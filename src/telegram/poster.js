const { readData, getConfigItem } = require('../config');
const { mtproto, authenticate } = require(`./mtproto`);
const { sleep, getRandomNumber } = require('../utils');
const { queryLLM, LLMEnabled } = require('../ai');

let IS_RUNNING = false;
let TASK_COUNT = 0;
let logger = function (data) {};

function getIsRunning() {
  return IS_RUNNING;
}

function setIsRunning(value) {
  IS_RUNNING = value;
}

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
    const fullChannel = await mtprotoCall('channels.getFullChannel', {
      channel: { _: 'inputChannel', channel_id: channelPeer.id, access_hash: channelPeer.access_hash },
    });

    const linkedChatId = fullChannel.full_chat?.linked_chat_id;
    if (!linkedChatId) throw new Error('No linked chat');
    
    const linkedChat = fullChannel.chats.find(c => c.id === linkedChatId);
    if (!linkedChat) throw new Error('Linked chat not found');
    
    return {
      peer: linkedChat,
      access_hash: linkedChat.access_hash
    };
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
        limit: 10,
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
        // reply with AI 
        params.message = await queryLLM(`${prompt}. Повідомлення: "${targetMessage.message}"`);
      }
    }

    await mtprotoCall('messages.sendMessage', params);

    console.log(`✅ Message sent to ${groupid}`);
    logger(`✅ Message sent to ${groupid}`);
  } catch (error) {
    console.error(`❌ Error sending to ${groupid}:`, error);
    logger(`❌ Error sending to ${groupid}: ${JSON.stringify(error)}`);
  }
}

async function reactToMessage(peer, groupid, reaction, target) {
  try {    
    const history = await mtprotoCall('messages.getHistory', {
      peer: { _: 'inputPeerChannel', channel_id: peer.id, access_hash: peer.access_hash },
      limit: 10,
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

    await mtprotoCall('messages.sendReaction', {
      peer: { _: 'inputPeerChannel', channel_id: peer.id, access_hash: peer.access_hash },
      msg_id: targetMessage.id,
      reaction: [{ _: 'reactionEmoji', emoticon: reaction }],
      big: false,
    });
    console.log(`✅ Reacted to message ${targetMessage.id} in ${groupid}`);
    logger(`✅ Reacted to message ${targetMessage.id} in ${groupid}`);
  } catch (error) {
    console.error(`❌ React error in ${groupid}:`, error);
    logger(`❌ React error in ${groupid}: ${JSON.stringify(error)}`);
  }
}

async function findDiscussionMessage(linkedChatPeer, channelPeer, channelPostId) {
  try {
    const history = await mtprotoCall('messages.getHistory', {
      peer: { _: 'inputPeerChannel', channel_id: linkedChatPeer.id, access_hash: linkedChatPeer.access_hash },
      limit: 100,
    });

    const discussionMsg = history.messages.find(msg => 
      msg.fwd_from?.saved_from_peer?.channel_id === channelPeer.id &&
      msg.fwd_from?.saved_from_msg_id === channelPostId
    );

    if (!discussionMsg) {
      throw new Error('No discussion message found - maybe delayed?');
    }
    return discussionMsg;
  } catch (error) {
    console.error('Discussion message search failed:', error);
    throw error;
  }
}

async function sendCommentToPost(channelPeer, channelGroupId, target, comment, prompt) {
  try {
    // 1️⃣ Отримуємо ID останнього поста каналу
    const channelPostId = await getLastChannelPost(channelPeer);
    console.log(`📰 Last channel post ID: ${channelPostId}`);

    // 2️⃣ Отримуємо linked discussion chat
    const linkedChat = await getLinkedChatPeer(channelPeer);

    // 3️⃣ Гарантуємо участь у linked chat
    if (linkedChat.peer.username) {
      await ensureMembership(`@${linkedChat.peer.username}`);
    } else if (linkedChat.peer.id && linkedChat.peer.access_hash) {
      await ensureMembership(`${linkedChat.peer.id}:${linkedChat.peer.access_hash}`);
    } else {
      throw new Error('Invalid linked chat peer');
    }

    // 4️⃣ Знаходимо discussion root для ОСТАННЬОГО поста
    const discussionRoot = await findDiscussionMessage(
      linkedChat.peer,
      channelPeer,
      channelPostId
    );

    if (!discussionRoot.id) {
      throw new Error('Discussion root not found for last channel post');
    }

    console.log(`🧵 Discussion root ID: ${discussionRoot.id}`);

    // 5️⃣ Обробка target
    let targetMessage;
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
      throw new Error('No comments found for last post');
    }

    if (target === '$') {
      targetMessage = postComments[0];
      console.log(`💬 Last comment ID: ${targetMessage.id}`);
    } else if (target === '*') {
      targetMessage = postComments[getRandomNumber(0, postComments.length - 1)];
      console.log(`🎲 Random comment ID: ${targetMessage.id}`);
    } else {
      targetMessage = discussionRoot;
      console.log(`💬 Root ID: ${targetMessage.id}`);
    }

    console.log(`🎯 Replying to message ID: ${targetMessage.id}`);

    if (prompt && LLMEnabled()) {
      // reply with AI 
      params.message = await queryLLM(`${prompt}. Повідомлення: "${targetMessage.message}"`);
    }

    // 7️⃣ Відправляємо коментар
    await mtprotoCall('messages.sendMessage', {
      peer: {
        _: 'inputPeerChannel',
        channel_id: linkedChat.peer.id,
        access_hash: linkedChat.peer.access_hash,
      },
      message: comment,
      reply_to: {
        _: 'inputReplyToMessage',
        reply_to_msg_id: targetMessage.id,
      },
      random_id: (
        BigInt(Date.now()) * 1000n +
        BigInt(Math.floor(Math.random() * 1000))
      ).toString(),
    });

    console.log(`✅ Comment sent (reply_to=${targetMessage.id}) in ${channelGroupId}`);
    logger(`✅ Comment sent (reply_to=${targetMessage.id}) in ${channelGroupId}`);
  } catch (error) {
    console.error('❌ sendCommentToPost error:', error);
    logger(`❌ sendCommentToPost error: ${JSON.stringify(error)}`);
  }
}

async function reactToCommentOfPost(channelPeer, channelGroupId, target, reaction) {
  try {
    /** 1️⃣ Отримуємо linked chat */
    const linkedChat = await getLinkedChatPeer(channelPeer);

    /** 2️⃣ Гарантуємо участь */
    if (linkedChat.peer.username) {
      await ensureMembership(`@${linkedChat.peer.username}`);
    } else if (linkedChat.peer.id && linkedChat.peer.access_hash) {
      await ensureMembership(`${linkedChat.peer.id}:${linkedChat.peer.access_hash}`);
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
    const discussionRoot = await findDiscussionMessage(
      linkedChat.peer,
      channelPeer,
      lastPost.id
    );

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

    if (!comments.length) {
      throw new Error('No comments for last post');
    }

    /** 6️⃣ Вибір target */
    let targetMessageId;
    if (target === '$') {
      targetMessageId = comments[0].id;
      console.log(`💬 Last comment ID: ${targetMessageId}`);
    } else if (target === '*') {
      targetMessageId = comments[getRandomNumber(0, comments.length - 1)].id;
      console.log(`💬 Random comment ID: ${targetMessageId}`);
    } else {
      targetMessageId = discussionRoot.id;
      console.log(`💬 Root ID: ${targetMessageId}`);
    }

    console.log(`🎯 Reacting to comment ID: ${targetMessageId}`);

    /** 7️⃣ Відправка реакції */
    await mtprotoCall('messages.sendReaction', {
      peer: {
        _: 'inputPeerChannel',
        channel_id: linkedChat.peer.id,
        access_hash: linkedChat.peer.access_hash
      },
      msg_id: targetMessageId,
      reaction: [{ _: 'reactionEmoji', emoticon: reaction }],
      big: false
    });

    console.log(`✅ Reacted to comment ${targetMessageId} in ${channelGroupId}`);
    logger(`✅ Reacted to comment ${targetMessageId} in ${channelGroupId}`);
  } catch (error) {
    console.error('❌ Comment react error:', error);
    logger(`❌ Comment react error: ${JSON.stringify(error)}`);
  }
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

async function processGroups(requestCode, externalLogger) {
  try {     
    if (TASK_COUNT > 0) {
      // avoid running multiple tasks 
      return;
    }
    TASK_COUNT++;
    logger = externalLogger;
    await authenticate(requestCode);    
    
    while (getIsRunning()) {
      const data = readData();
      for (const group of data) {        
        const { id, comment, reaction, prompt, target } = group;

        const { peer } = await ensureMembership(id);
        const type = getPeerType(peer);

        if (type == 'group' || type == 'supergroup') {
          if (comment || prompt) await sendMessage(peer, id, comment, target, prompt);            
          if (reaction) await reactToMessage(peer, id, reaction, target);                     
        } else if (type == 'channel') {
          if (comment || prompt) await sendCommentToPost(peer, id, target, comment, prompt);                
          if (reaction) await reactToCommentOfPost(peer, id, target, reaction);                           
        }      

      }
      await sleep(parseInt(getConfigItem('TELEGRAM_ITERATION_DELAY'), 10) * 1000);
    }  
  } catch (err) {
    console.log(err);
    return;
  } finally {
    TASK_COUNT--;
  }    
}

module.exports.processGroups = processGroups;
module.exports.getIsRunning = getIsRunning;
module.exports.setIsRunning = setIsRunning;