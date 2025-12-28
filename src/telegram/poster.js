const { readData, getConfigItem } = require('../config');
const { mtproto, authenticate } = require(`./mtproto`);
const { sleep, getRandomNumber } = require('../utils');
const { queryLLM, LLMEnabled } = require('../ai');

/* -- STATE -- */
const lastSeenChannelPost = new Map();
const channelDebounce = new Map();
const channelPeerCache = new Map();
const linkedChatCache = new Map();

let IS_RUNNING = false;

let messagesSent = 0;

function getIsRunning() {
  return IS_RUNNING;
}

function setIsRunning(value) {
  IS_RUNNING = value;
}

function getMessagesSent() {
  return messagesSent;
}

/* -- STATE END -- */

async function mtprotoCall(method, data) {
  const result = await mtproto.call(method, data);
  await sleep(parseInt(getConfigItem('TELEGRAM_API_DELAY'), 10) * 1000);
  return result;
}

function extractInviteHash(linkOrHash) {
  const match = linkOrHash.match(/(?:t\.me\/(?:joinchat\/|\+))([\w-]+)/);
  return match ? match[1] : null;
}

function extractUsername(groupidOrLink) {
  const match = groupidOrLink.match(/(?:t\.me\/)([\w-]+)/);
  return match ? match[1] : groupidOrLink.replace('@', '');
}

function isNumericId(str) {
  return /^\d+$/.test(str);
}

function getSendAsChannel(channelPeer) {
  return {
    _: 'inputPeerChannel',
    channel_id: channelPeer.id,
    access_hash: channelPeer.access_hash
  };
}

async function getPeerCached(id) {
  if (channelPeerCache.has(id)) return channelPeerCache.get(id);
  const res = await ensureMembership(id);
  channelPeerCache.set(id, res);
  return res;
}

async function getSendAsPeer() {
  const sendAsConfig = getConfigItem('TELEGRAM_SEND_AS_CHANNEL');
  if (!sendAsConfig) {
    return null;
  }

  const sendAsChannels = sendAsConfig
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  if (sendAsChannels.length === 0) {
    return null;
  }

  let sendAsChannel;
  
  if (sendAsChannels.length === 1) {
    sendAsChannel = sendAsChannels[0];
  } else {
    sendAsChannel = sendAsChannels[getRandomNumber(0, sendAsChannels.length - 1)];
  }
  
  const sendAsChannelPeer = await getPeerCached(sendAsChannel);
  if (sendAsChannelPeer.peer._ !== 'channel') {
    throw new Error('TELEGRAM_SEND_AS_CHANNEL must be a channel');
  }
  
  return sendAsChannelPeer.peer;
}

function getPeerType(peer) {
  if (!peer || !peer._) return 'unknown';

  if (peer._ === 'chat') {
    return 'group';
  }

  if (peer._ === 'channel') {
    return peer.megagroup ? 'supergroup' : 'channel';
  }

  return 'unknown';
}

async function handlePrompt(prompt, input) {
  let result = {
    skip: false,
    answer: ""
  };  

  const response = await queryLLM(`${prompt} <<<${input}>>>`);
  console.log(`LLM response: "${response}"`);

  let jsonData;
  try {
    jsonData = JSON.parse(response);    
  } catch (e) {        
  }

  if (jsonData) {    
    result = {
      ...result,
      ...jsonData
    };
  } else {
    result.answer = response;  
  }  

  if (result.answer) {
    result.answer = result.answer.replace(/^["']|["']$/g, '');  
  }

  return result;
}

async function ensureMembership(groupidOrInvite) {
  try {
    const inviteHash = extractInviteHash(groupidOrInvite);

    if (inviteHash) {
      try {
        const imported = await mtprotoCall('messages.importChatInvite', { hash: inviteHash });
        const peer = imported.chats[0];
        console.log(`✅ Joined via invite: ${groupidOrInvite}`);
        return { peer };
      } catch (error) {
        if (error.error_message.includes('USER_ALREADY_PARTICIPANT')) {
          const checked = await mtprotoCall('messages.checkChatInvite', { hash: inviteHash });
          console.log(`ℹ️ Already in: ${groupidOrInvite}`);
          return { peer: checked.chat };
        }
        throw error;
      }
    } else {
      const usernameOrId = extractUsername(groupidOrInvite);
      let inputChannel;
      let peer;

      // Check if the usernameOrId is in the format "channel_id:access_hash"
      const parts = usernameOrId.split(':');
      if (parts.length === 2 && isNumericId(parts[0]) && isNumericId(parts[1])) {
        // Numeric ID and access_hash
        const channelId = parseInt(parts[0], 10);
        const accessHash = parts[1];
        inputChannel = {
          _: 'inputChannel',
          channel_id: channelId,
          access_hash: accessHash,
        };
        peer = {
          _: 'inputPeerChannel',
          channel_id: channelId,
          access_hash: accessHash,
        };
      } else {
        // Check if it's a numeric ID without access_hash
        if (isNumericId(usernameOrId)) {
          throw new Error('Numeric ID must be provided in the format "channel_id:access_hash"');
        }
        // Resolve username
        const resolved = await mtprotoCall('contacts.resolveUsername', {
          username: usernameOrId,
        });
        const chat = resolved.chats[0];
        inputChannel = {
          _: 'inputChannel',
          channel_id: chat.id,
          access_hash: chat.access_hash,
        };
        peer = chat;
      }

      try {
        await mtprotoCall('channels.getParticipant', {
          channel: inputChannel,
          participant: { _: 'inputPeerSelf' },
        });
        console.log(`ℹ️ Already in: ${groupidOrInvite}`);
        return { peer };
      } catch (error) {
        if (error.error_message === 'USER_NOT_PARTICIPANT') {
          await mtprotoCall('channels.joinChannel', {
            channel: inputChannel,
          });
          console.log(`✅ Joined ${groupidOrInvite}`);
          return { peer };
        }
        throw error;
      }
    }
  } catch (error) {
    console.error(`❌ Error joining ${groupidOrInvite}:`, error);
    throw error;
  }
}

async function getLinkedChatPeer(channelPeer) {
  try {
    if (linkedChatCache.has(channelPeer.id)) {
      return linkedChatCache.get(channelPeer.id);
    }

    const fullChannel = await mtprotoCall('channels.getFullChannel', {
      channel: { _: 'inputChannel', channel_id: channelPeer.id, access_hash: channelPeer.access_hash },
    });

    const linkedChatId = fullChannel.full_chat?.linked_chat_id;
    if (!linkedChatId) throw new Error('No linked chat');
    
    const linkedChat = fullChannel.chats.find(c => c.id === linkedChatId);
    if (!linkedChat) throw new Error('Linked chat not found');
    
    const result = {
      peer: linkedChat,
      access_hash: linkedChat.access_hash
    };

    linkedChatCache.set(channelPeer.id, result);
  return result;
  } catch (error) {
    console.error('Error getting linked chat:', error);
    throw error;
  }
}

async function getLastChannelPost(channelPeer) {
  const history = await mtprotoCall('messages.getHistory', {
    peer: { _: 'inputPeerChannel', channel_id: channelPeer.id, access_hash: channelPeer.access_hash },
    limit: 1,
  });
  if (!history.messages.length) throw new Error('No posts found');
  return history.messages[0].id;
}

async function findDiscussionRoot(channelPeer, channelPostId) {
  const res = await mtprotoCall('messages.getDiscussionMessage', {
    peer: {
      _: 'inputPeerChannel',
      channel_id: channelPeer.id,
      access_hash: channelPeer.access_hash
    },
    msg_id: channelPostId
  });

  // Find the true thread root
  const root = res.messages.find(m =>
    m.replies ||
    m.reply_to_top_id === m.id
  );

  if (!root) {
    throw new Error('Discussion thread root not found yet');
  }

  return root;
}

async function preloadDialogs() {
  await mtprotoCall('messages.getDialogs', {
    offset_date: 0,
    offset_id: 0,
    offset_peer: { _: 'inputPeerEmpty' },
    limit: 200,
    hash: 0
  });
  console.log('📂 Dialogs preloaded');
}

async function warmUpPeerCache() {
  const data = readData();  
  for (const group of data) {    
    await getPeerCached(group.groupid);
  }  
}

/* -- GROUP POSTING -- */
async function sendMessage(peer, groupid, message, target, prompt) {
  try {  
    const params = {
      peer: {
        _: 'inputPeerChannel',
        channel_id: peer.id,
        access_hash: peer.access_hash,
      },
      message,
      random_id: BigInt(Math.floor(Math.random() * 1e18)).toString(),
    };

    // reply logic
    if (target === '*' || target === '$') {
      const history = await mtprotoCall('messages.getHistory', {
        peer: { _: 'inputPeerChannel', channel_id: peer.id, access_hash: peer.access_hash },
        limit: 100,
      });
      
      const validMessages = (history.messages || []).filter(
        (m) => m?.id && m._ === 'message'
      );

      if (!validMessages.length) {
        throw new Error('No valid messages to reply to.');
      }

      let targetMessage;
      if (target == '$') {
        targetMessage = validMessages[0];
      } else if (target == '*')  {
        targetMessage = validMessages[getRandomNumber(0, validMessages.length - 1)];
      }         

      params.reply_to_msg_id = targetMessage.id;
      
      if (prompt && LLMEnabled()) {
        // handle prompt        
        const res = await handlePrompt(prompt, targetMessage.message);
                                                                                                                                                                        
        if (res.skip) {
          console.log(`Skip sending to ${groupid} due to agent directive`);
          return;
        }

        if (!(res.answer.length > 0)) {
          console.log(`Skip sending to ${groupid} due to an empty answer`);
          return;
        }

        params.message = res.answer;
      }
    }

    let sendAsPeer = await getSendAsPeer();    
    if (sendAsPeer) {
      params.send_as = getSendAsChannel(sendAsPeer);
    }

    await mtprotoCall('messages.sendMessage', params);

    messagesSent++;
    console.log(`✅ Message sent to ${groupid}`);
  } catch (error) {
    console.error(`❌ Error sending to ${groupid}:`, error);
  }
}

async function reactToMessage(peer, groupid, reaction, target) {
  try {    
    const history = await mtprotoCall('messages.getHistory', {
      peer: { _: 'inputPeerChannel', channel_id: peer.id, access_hash: peer.access_hash },
      limit: 100,
    });

    const validMessages = (history.messages || []).filter(
      (m) => m?.id && m._ === 'message'
    );

    if (!validMessages.length) {
      throw new Error('No valid messages to reply to.');
    }

    let targetMessage;
    if (target == '$') {
      targetMessage = validMessages[0];
    } else if (target == '*')  {
      targetMessage = validMessages[getRandomNumber(0, validMessages.length - 1)];
    } else {
      targetMessage = validMessages[validMessages.length - 1];
    }

    let params = {
      peer: { _: 'inputPeerChannel', channel_id: peer.id, access_hash: peer.access_hash },
      msg_id: targetMessage.id,
      reaction: [{ _: 'reactionEmoji', emoticon: reaction }],
      big: false,
    };

    let sendAsPeer = await getSendAsPeer();    
    if (sendAsPeer) {
      params.send_as = getSendAsChannel(sendAsPeer);
    }

    await mtprotoCall('messages.sendReaction', params);

    messagesSent++;
    console.log(`✅ Reacted to message ${targetMessage.id} in ${groupid}`);
  } catch (error) {
    console.error(`❌ React error in ${groupid}:`, error);
  }
}

/* -- END GROUP POSTING -- */

/* -- CHANNEL CHAT POSTING -- */

async function sendCommentToPost(channelPeer, channelGroupId, target, comment, prompt) {
  try {
    // 1️⃣ Отримуємо ID останнього поста каналу
    const channelPostId = await getLastChannelPost(channelPeer);
    console.log(`📰 Last channel post ID: ${channelPostId}`);

    // 2️⃣ Отримуємо linked discussion chat
    const linkedChat = await getLinkedChatPeer(channelPeer);

    // 3️⃣ Гарантуємо участь у linked chat
    if (linkedChat.peer.username) {
      await getPeerCached(`@${linkedChat.peer.username}`);
    } else if (linkedChat.peer.id && linkedChat.peer.access_hash) {
      await getPeerCached(`${linkedChat.peer.id}:${linkedChat.peer.access_hash}`);
    } else {
      throw new Error('Invalid linked chat peer');
    }

    // 4️⃣ Знаходимо discussion root для ОСТАННЬОГО поста
    const discussionRoot = await findDiscussionRoot(channelPeer, channelPostId);

    if (!discussionRoot.id) {
      throw new Error('Discussion root not found for last channel post');
    }

    console.log(`🧵 Discussion root ID: ${discussionRoot.id}`);

    // 5️⃣ Обробка target
    let targetMessage;    
    if (target === '$' || target === '*') { 
      // Беремо історію коментарів
      const history = await mtprotoCall('messages.getHistory', {
        peer: {
          _: 'inputPeerChannel',
          channel_id: linkedChat.peer.id,
          access_hash: linkedChat.peer.access_hash,
        },
        limit: 100,
      });

      // 🔒 ТІЛЬКИ коментарі цього поста (перший рівень)
      const postComments = (history.messages || []).filter(m =>
        m._ === 'message' &&
        m.id &&
        m.reply_to &&
        m.reply_to.reply_to_msg_id === discussionRoot.id
      );
      
      if (!postComments.length) {
        throw new Error('No comments found for post');
      }

      if (target === '$') {
        targetMessage = postComments[0];
        console.log(`💬 Last comment ID: ${targetMessage.id}`);
      } else if (target === '*') {
        targetMessage = postComments[getRandomNumber(0, postComments.length - 1)];
        console.log(`🎲 Random comment ID: ${targetMessage.id}`);
      }  
    } else {
      targetMessage = discussionRoot;
      console.log(`💬 Root ID: ${targetMessage.id}`);
    }        

    console.log(`🎯 Replying to message ID: ${targetMessage.id}`);

    let params = {
      peer: {
        _: 'inputPeerChannel',
        channel_id: linkedChat.peer.id,
        access_hash: linkedChat.peer.access_hash,
      },
      message: comment,
      reply_to_msg_id: targetMessage.id,
      random_id: (
        BigInt(Date.now()) * 1000n +
        BigInt(Math.floor(Math.random() * 1000))
      ).toString(),
    };

    if (prompt && LLMEnabled()) {      
      // handle prompt        
      const res = await handlePrompt(prompt, targetMessage.message);

      if (res.skip) {
        console.log(`Skip sending to ${channelGroupId} due to agent directive`);
        return;
      }

      if (!(res.answer.length > 0)) {
        console.log(`Skip sending to ${channelGroupId} due to an empty answer`);
        return;
      }

      params.message = res.answer;
    }

    let sendAsPeer = await getSendAsPeer();    
    if (sendAsPeer) {
      params.send_as = getSendAsChannel(sendAsPeer);
    }

    // 7️⃣ Відправляємо коментар
    await mtprotoCall('messages.sendMessage', params);

    messagesSent++;
    console.log(`✅ Comment sent (reply_to=${targetMessage.id}) in ${channelGroupId}`);
  } catch (error) {
    console.error('❌ sendCommentToPost error:', error);
  }
}

async function reactToCommentOfPost(channelPeer, channelGroupId, target, reaction) {
  try {
    /** 1️⃣ Отримуємо linked chat */
    const linkedChat = await getLinkedChatPeer(channelPeer);

    /** 2️⃣ Гарантуємо участь */
    if (linkedChat.peer.username) {
      await getPeerCached(`@${linkedChat.peer.username}`);
    } else if (linkedChat.peer.id && linkedChat.peer.access_hash) {
      await getPeerCached(`${linkedChat.peer.id}:${linkedChat.peer.access_hash}`);
    }

    /** 3️⃣ Отримуємо ОСТАННІЙ ПОСТ каналу */
    const channelHistory = await mtprotoCall('messages.getHistory', {
      peer: {
        _: 'inputPeerChannel',
        channel_id: channelPeer.id,
        access_hash: channelPeer.access_hash
      },
      limit: 1
    });

    const lastPost = channelHistory.messages?.find(m => m._ === 'message' && m.id);
    if (!lastPost) throw new Error('No channel posts found');
    console.log(`📰 Last channel post ID: ${lastPost.id}`);

    // 4️⃣ Знаходимо discussion root для ОСТАННЬОГО поста
    const discussionRoot = await findDiscussionRoot(channelPeer, lastPost.id);

    if (!discussionRoot.id) {
      throw new Error('Discussion root not found for last channel post');
    }

    /** 5️⃣ Отримуємо коментарі ТІЛЬКИ до цього поста */
    const commentsHistory = await mtprotoCall('messages.getHistory', {
      peer: {
        _: 'inputPeerChannel',
        channel_id: linkedChat.peer.id,
        access_hash: linkedChat.peer.access_hash
      },
      limit: 100
    });

    const comments = (commentsHistory.messages || []).filter(m =>
      m._ === 'message' &&
      m.id &&
      m.reply_to?.reply_to_msg_id === discussionRoot.id
    );

    /** 6️⃣ Вибір target */
    let targetMessageId;
    if (target === '$' || target === '*') {
      if (!comments.length) {
        throw new Error('No comments for post');
      }
      if (target === '$') {
        targetMessageId = comments[0].id;
        console.log(`💬 Last comment ID: ${targetMessageId}`);
      } else if (target === '*') {
        targetMessageId = comments[getRandomNumber(0, comments.length - 1)].id;
        console.log(`💬 Random comment ID: ${targetMessageId}`);
      } 
    } else {
      targetMessageId = discussionRoot.id;
      console.log(`💬 Root ID: ${targetMessageId}`);
    }

    console.log(`🎯 Reacting to comment ID: ${targetMessageId}`);

    let params = {
      peer: {
        _: 'inputPeerChannel',
        channel_id: linkedChat.peer.id,
        access_hash: linkedChat.peer.access_hash
      },
      msg_id: targetMessageId,
      reaction: [{ _: 'reactionEmoji', emoticon: reaction }],
      big: false
    };

    let sendAsPeer = await getSendAsPeer();    
    if (sendAsPeer) {
      params.send_as = getSendAsChannel(sendAsPeer);
    }

    /** 7️⃣ Відправка реакції */
    await mtprotoCall('messages.sendReaction', params);

    messagesSent++;
    console.log(`✅ Reacted to comment ${targetMessageId} in ${channelGroupId}`);
  } catch (error) {
    console.error('❌ Comment react error:', error);
  }
}

async function reactToSpecificPost(channelPeer, channelGroupId, postId, reaction) {
  let sendAsPeer = await getSendAsPeer();  
  await mtprotoCall('messages.sendReaction', {
    peer: {
      _: 'inputPeerChannel',
      channel_id: channelPeer.id,
      access_hash: channelPeer.access_hash
    },
    msg_id: postId,
    reaction: [{ _: 'reactionEmoji', emoticon: reaction }],
    ...(sendAsPeer && { send_as: getSendAsChannel(sendAsPeer) })
  });

  messagesSent++;
  console.log(`❤️ Reacted to new post ${postId} in ${channelGroupId}`);
}

async function sendCommentToSpecificPost(channelPeer, channelGroupId, postId, comment, prompt) {
  const linkedChat = await getLinkedChatPeer(channelPeer);

  if (linkedChat.peer.username) {
    await getPeerCached(`@${linkedChat.peer.username}`);
  } else {
    await getPeerCached(`${linkedChat.peer.id}:${linkedChat.peer.access_hash}`);
  }

  // Знаходимо discussion root для ОСТАННЬОГО поста
  const discussionRoot = await findDiscussionRoot(channelPeer, postId);

  console.log(`🧵 Discussion root ID: ${discussionRoot.id}`);

  let text = comment;
  if (prompt && LLMEnabled()) {
    // handle prompt        
    const res = await handlePrompt(prompt, discussionRoot.message);

    if (res.skip) {
      console.log(`Skip sending to ${channelGroupId} due to agent directive`);
      return;
    } 

    if (!(res.answer.length > 0)) {
      console.log(`Skip sending to ${channelGroupId} due to an empty answer`);
      return;
    }

    text = res.answer;
  }

  let sendAsPeer = await getSendAsPeer();  

  await mtprotoCall('messages.sendMessage', {
    peer: {
      _: 'inputPeerChannel',
      channel_id: linkedChat.peer.id,
      access_hash: linkedChat.peer.access_hash
    },
    message: text,
    reply_to_msg_id: discussionRoot.id,
    random_id: BigInt(Date.now()).toString(),
    ...(sendAsPeer && { send_as: getSendAsChannel(sendAsPeer) })
  });

  messagesSent++;
  console.log(`💬 Commented on new post ${postId} in ${channelGroupId}`);
}

/* -- CHANNEL CHAT POSTING -- */

async function handleDebouncedPost(
  channelPeer,
  groupConfig,
  postId  
) {
  const { groupid, comment, reaction, prompt } = groupConfig;
  
  const key = `${channelPeer.id}:${groupConfig.id}`;
  const lastSeen = lastSeenChannelPost.get(key);

  if (lastSeen && postId <= lastSeen) return;

  lastSeenChannelPost.set(key, postId);

  console.log(`⏳ Debounced post ${postId} in ${groupid}`);

  if (comment || prompt) {
    await sendCommentToSpecificPost(
      channelPeer,
      groupid,
      postId,
      comment,
      prompt      
    );
  }

  if (reaction) {
    await reactToSpecificPost(
      channelPeer,
      groupid,
      postId,
      reaction      
    );
  }
}

function scheduleDebouncedPost(
  channelPeer,
  groupConfig,
  postId  
) {
  const key = `${channelPeer.id}:${groupConfig.id}`;

  const existing = channelDebounce.get(key);
  if (existing?.timer) {
    clearTimeout(existing.timer);
  }
  
  const delay = parseInt((getConfigItem('TELEGRAM_NEW_POST_DEBOUNCE') || 10), 10) * 1000;
  const timer = setTimeout(async () => {
    try {
      await handleDebouncedPost(
        channelPeer,
        groupConfig,
        postId        
      );
    } catch (err) {
      console.error('❌ Debounced post handler error:', err);
    } finally {
      channelDebounce.delete(key);
    }
  }, delay);

  channelDebounce.set(key, { postId, timer });

  console.log(`post scheduled`);
}

async function processGroups(requestCode) {
  try {        
    await authenticate(requestCode);  
    await preloadDialogs();
    await warmUpPeerCache();

    mtproto.updates.on('updates', async ({ updates }) => {
      if (!getIsRunning()) return;
    
      for (const upd of updates) {
        if (upd._ !== 'updateNewChannelMessage') continue;
    
        const msg = upd.message;
        if (!msg || msg._ !== 'message') continue;
        if (!msg.message && !msg.media) continue;
    
        const channelId = msg.peer_id?.channel_id;
        if (!channelId) continue;
    
        const data = readData();
    
        for (const group of data) {
          if (group.target !== '^') continue;
    
          const { groupid } = group;
          const { peer } = await getPeerCached(groupid);
    
          if (peer._ !== 'channel') continue;
          if (peer.id !== channelId) continue;          
    
          scheduleDebouncedPost(peer, group, msg.id);
        }
      }
    });
    
    while (getIsRunning()) {
      const data = readData();      
      for (const group of data) {        
        const { groupid, comment, reaction, prompt, target } = group;

        if (target == '^') continue;        

        const { peer } = await getPeerCached(groupid);
        const type = getPeerType(peer);

        if (type == 'group' || type == 'supergroup') {
          if (comment || prompt) await sendMessage(peer, groupid, comment, target, prompt);            
          if (reaction) await reactToMessage(peer, groupid, reaction, target);                     
        } else if (type == 'channel') {          
          if (comment || prompt) await sendCommentToPost(peer, groupid, target, comment, prompt);                
          if (reaction) await reactToCommentOfPost(peer, groupid, target, reaction);                           
        }      

      }
      await sleep(parseInt(getConfigItem('TELEGRAM_ITERATION_DELAY'), 10) * 1000);
    }  
  } catch (err) {
    console.log(err);
    return;
  } finally {
    setIsRunning(false);
    lastSeenChannelPost.clear();
    channelDebounce.clear();
    console.log(`exiting`);
  }    
}

module.exports.processGroups = processGroups;
module.exports.getMessagesSent = getMessagesSent;
module.exports.getIsRunning = getIsRunning;
module.exports.setIsRunning = setIsRunning;