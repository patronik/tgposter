const { readData, getConfigItem } = require('../config');
const { mtproto, authenticate } = require(`./mtproto`);
const { sleep, getRandomNumber } = require('../utils');
const { queryLLM, LLMEnabled } = require('../ai');

/* -- STATE -- */
let SELF_USER_ID = null;

let BIO_LOCK = false;
let SAVED_BIO = null;

let CH_POLLING_LOCK = false;

let PM_POLLING_LOCK = false;

let IS_RUNNING = false;

let TOTAL_SENT = 0;

const lastSeenPost = new Map();
const channelDebounce = new Map();
const channelPeerCache = new Map();
const linkedChatCache = new Map();
const processedPMs = new Map();

let pmTimer = null;
let pollTimer = null;

function getIsRunning() {
  return IS_RUNNING;
}

function setIsRunning(value) {
  IS_RUNNING = value;
}

function getTotalSent() {
  return TOTAL_SENT;
}
/* -- STATE END -- */

async function mtprotoCall(method, data, retry = 0) {
  try {
      const result = await mtproto.call(method, data);
      const apiDelay = getConfigItem('TELEGRAM_API_DELAY') || '10';
      await sleep(parseInt(apiDelay, 10) * 1000);
      return result;
    } catch (err) {     
    const errorMessage = err.error_message || err.message;
    if (errorMessage && errorMessage.startsWith('FLOOD_WAIT')) { 
      console.error(`❌ Flood wait error:`, err);
      const wait = Number(errorMessage.split('_').pop()); 
      await sleep(wait * 1000); 
      if (retry < 2) {
        console.log(`Retry ${(retry + 1)}`);
        return await mtprotoCall(method, data, retry + 1);
      } else {
        throw err;
      }
    } else {
      throw err;
    }
  }
}

function getInputPeer(peer) {
  let inputPeer;
  if (peer._ === 'chat') {
      inputPeer = { 
        _: 'inputPeerChat', 
        chat_id: peer.id 
      };
  } else {
    inputPeer = {
        _: 'inputPeerChannel',
        channel_id: peer.id,
        access_hash: peer.access_hash,
    };
  }   
  return inputPeer;
}

function isOurMessage(msg, sendAsPeer) {
  if (!msg?.from_id) return false;

  if (sendAsPeer && msg.from_id.channel_id === sendAsPeer.id) {
    return true;
  }

  if (!sendAsPeer && msg.from_id.user_id === SELF_USER_ID) {
    return true;
  }

  return false;
}

function isPrivateMessage(msg) {
  return (
    msg?._ === 'message' &&
    msg.peer_id?._ === 'peerUser' &&
    msg.message
  );
}

async function initSelf() {
  if (!SELF_USER_ID) {
    const res = await mtprotoCall('users.getFullUser', {
      id: { _: 'inputUserSelf' }
    });
    SELF_USER_ID = res.users[0].id;
    console.log(`👤 SELF_USER_ID = ${SELF_USER_ID}`);
  }
}

function getSecondsDifferenceToNow(postTime) {
  const now = Math.floor(Date.now() / 1000); 
  const elapsedSeconds = now - postTime;  
  return elapsedSeconds;
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
    answer: "",
    message_id: null
  }; 
    
  const response = await queryLLM(`${prompt}\nINPUT:\n${input}`);
  console.log(`LLM: ${response}`);

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

async function getLastChannelPost(channelPeer, scanLimit = 20) {
  const history = await mtprotoCall('messages.getHistory', {
    peer: getInputPeer(channelPeer),
    limit: scanLimit,
  });


  for (const msg of history.messages || []) {
    if (msg._ !== 'message') continue;

    try {
      await mtprotoCall('messages.getDiscussionMessage', {
        peer: getInputPeer(channelPeer),
        msg_id: msg.id,
      });    
      // Якщо дискусія існує → це наш пост
      return { channelPostId: msg.id, postDate: msg.date };
    } catch (e) {
      // Очікувано для постів без дискусії
      continue;
    }
  }

  throw new Error('No recent channel post with discussion found');
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

async function getCurrentBio() {
  const res = await mtprotoCall('users.getFullUser', {id: { _: 'inputUserSelf' }});
  return res.full_user?.about ?? '';
}

async function clearBio() {
  await mtprotoCall('account.updateProfile', { about: 'What a day!' });
}
async function restoreBio(bio) {
  await mtprotoCall('account.updateProfile', { about: bio });
}

async function withTemporaryClearedBio(action) {
  const restoreDelay = getConfigItem('TELEGRAM_RESTORE_BIO_DELAY');
  if (!restoreDelay) {
    return await action();
  }

  if (BIO_LOCK) {
    return await action();
  }

  BIO_LOCK = true;

  try {
    SAVED_BIO = await getCurrentBio();

    if (SAVED_BIO) {
      await clearBio();
      console.log(`🧹 Bio cleared`);
    }

    const result = await action();

    if (SAVED_BIO) {
      setTimeout(async () => {
        try {
          await restoreBio(SAVED_BIO);
          console.log(`🧬 Bio restored`);
        } catch (err) {
          console.error('❌ Failed to restore bio:', err);
        } finally {
          BIO_LOCK = false;
          SAVED_BIO = null;
        }
      }, parseInt(restoreDelay, 10) * 1000);
    } else {
      BIO_LOCK = false;
    }

    return result;
  } catch (err) {
    BIO_LOCK = false;
    throw err;
  }
}

async function prepareGroups() {  
  const data = readData();
  for (const group of data) {   
    try {
      await getPeerCached(group.groupid);      
    } catch (err) {
      console.error(`❌ Failed preparing "${group.groupid}"`);
    }    
  }
  return data;  
}

async function sendAndMaybeEditAndMaybeDelete(sendParams, edition, logPrefix = '') {
  // 1️⃣ Send message
  const result = await mtprotoCall('messages.sendMessage', sendParams);

  let sentMessageId;

  for (const update of result.updates || []) {
    if (
      update._ === 'updateNewMessage' ||
      update._ === 'updateNewChannelMessage'
    ) {
      if (update.message?._ === 'message') {
        sentMessageId = update.message.id;
        break;
      }
    }

    if (update._ === 'updateMessageID' && update.id) {
      sentMessageId = update.id;
    }
  }

  // 2️⃣ Edit message
  const editDelay = getConfigItem('TELEGRAM_EDIT_DELAY');
  if (editDelay && edition && sentMessageId) {
    setTimeout(async () => {
      try {
        await mtprotoCall('messages.editMessage', {
          peer: sendParams.peer,
          id: sentMessageId,
          message: edition,
          ...(sendParams.send_as && { send_as: sendParams.send_as })
        });
        console.log(`✏️ ${logPrefix} edited`);
      } catch (err) {
        console.error(`❌ Failed to edit ${logPrefix}:`, err);
      }
    }, parseInt(editDelay, 10) * 1000);
  }
  
  // 3️⃣ Delete message
  const deleteDelay = getConfigItem('TELEGRAM_DELETE_DELAY');
  if (deleteDelay && sentMessageId) {
    setTimeout(async () => {
      try {
        await mtprotoCall('messages.deleteMessages', {
          peer: sendParams.peer,
          id: [sentMessageId],
          revoke: true
        });
        console.log(`🗑️ ${logPrefix} deleted`);
      } catch (err) {
        console.error(`❌ Failed to delete ${logPrefix}:`, err);
      }
    }, parseInt(deleteDelay, 10) * 1000);
  }

  return sentMessageId;
}

/* -- GROUP POSTING -- */
async function sendMessage(peer, groupid, message, edition, target, prompt) {
  try {  
    let inputPeer = getInputPeer(peer);
    
    const params = {
      peer: inputPeer,
      message,
      random_id: BigInt(Math.floor(Math.random() * 1e18)).toString(),
    };

    // reply logic
    let targetMessage;
    if (target === '*' || target === '$' || target == '@') {
      const history = await mtprotoCall('messages.getHistory', {
        peer: inputPeer,
        limit: 100,
      });
      
      const validMessages = (history.messages || []).filter(
        (m) => m?.id && m._ === 'message'
      );

      if (!validMessages.length) {
        throw new Error('No valid messages to reply to.');
      }
      
      if (target === '$') {
        // last
        targetMessage = validMessages[0];
      } else if (target === '*') {
        // random
        targetMessage = validMessages[getRandomNumber(0, validMessages.length - 1)];
      } else if (target === '@') {
        // discussion root
        targetMessage = validMessages[validMessages.length - 1];
      }        

      params.reply_to_msg_id = targetMessage.id;
      
      if (prompt && LLMEnabled()) {
        // handle prompt        
        let jsonPayload;
        if (target == '@') {
          const discussionThread = await getDiscussionThread(inputPeer, targetMessage.id);
          jsonPayload = JSON.stringify(await buildLLMPayload(discussionThread, targetMessage.id), null, 2);
        }  
        
        const res = await handlePrompt(prompt, jsonPayload || targetMessage.message);
                                                                                                                                                                        
        if (res.skip) {
          console.log(`Skip sending to ${groupid} due to agent directive`);
          return;
        }

        if (!res.answer) {
          console.log(`Skip sending to ${groupid} due to an empty answer`);
          return;
        }

        if (res.message_id) {
          params.reply_to_msg_id = res.message_id;
        }

        params.message = res.answer;
      }
    }

    let sendAsPeer = await getSendAsPeer();    
    if (sendAsPeer) {
      params.send_as = getSendAsChannel(sendAsPeer);
    }

    // avoid replying to our messages    
    if (targetMessage && params.reply_to_msg_id == targetMessage.id) {
      if (isOurMessage(targetMessage, sendAsPeer)) {
        throw new Error('Skip replying to our message.');       
      }                
    }  

    // process message
    await withTemporaryClearedBio(
      () => sendAndMaybeEditAndMaybeDelete(params, edition, `message in ${groupid}`)
    );

    TOTAL_SENT++;
    console.log(`✅ Message sent to ${groupid}`);
  } catch (error) {
    console.error(`❌ Error sending to ${groupid}:`, error);
  }
}

async function reactToMessage(peer, groupid, reaction, target) {
  try {   
    let inputPeer = getInputPeer(peer); 
    const history = await mtprotoCall('messages.getHistory', {
      peer: inputPeer,
      limit: 100,
    });

    const validMessages = (history.messages || []).filter(
      (m) => m?.id && m._ === 'message'
    );

    if (!validMessages.length) {
      throw new Error('No valid messages to reply to.');
    }

    let targetMessage;
    if (target === '$') {
      targetMessage = validMessages[0];
    } else if (target === '*')  {
      targetMessage = validMessages[getRandomNumber(0, validMessages.length - 1)];
    } else {
      throw new Error(`Not supported target ${target}.`);
    }

    let params = {
      peer: inputPeer,
      msg_id: targetMessage.id,
      reaction: [{ _: 'reactionEmoji', emoticon: reaction }],
      big: false,
    };

    let sendAsPeer = await getSendAsPeer();    
    if (sendAsPeer) {
      params.send_as = getSendAsChannel(sendAsPeer);
    }

    // avoid reacting to our messages
    if (isOurMessage(targetMessage, sendAsPeer)) {
      throw new Error('Skip reacting to our message.');       
    } 

    await mtprotoCall('messages.sendReaction', params);

    TOTAL_SENT++;
    console.log(`✅ Reacted to message ${params.msg_id} in ${groupid}`);
  } catch (error) {
    console.error(`❌ React error in ${groupid}:`, error);
  }
}

/* -- END GROUP POSTING -- */

/* -- CHANNEL CHAT POSTING -- */

async function buildLLMPayload(messages, discussionRootId) {
  const root = messages.find(m => m.id === discussionRootId);
  if (!root) throw new Error('Root message not found');

  let ourMessages = [];
  const sendAsPeer = await getSendAsPeer();
  if (sendAsPeer) {
    ourMessages = messages.filter(
      m => m.from_id?.channel_id === sendAsPeer.id
    );
  } else {
    ourMessages = messages.filter(
      m => m.from_id?.user_id === SELF_USER_ID
    );
  }  

  const repliesToUs = messages
    .filter(m =>
      m.reply_to &&
      ourMessages.some(om => om.id === m.reply_to.reply_to_msg_id)
    )
    .map(m => ({
      id: m.id,
      text: m.message || "",
      reply_to_our_message_id: m.reply_to.reply_to_msg_id
    }))
    .sort((a, b) => b.id - a.id);

  let target;

  if (!ourMessages.length) {
    target = root;
  } else if (repliesToUs.length) {
    target = messages.find(m => m.id === repliesToUs[0].id);
  } else {
    target = root;
  }

  return {
    root: {
      id: root.id,
      text: root.message || ""
    },
    target: {
      id: target.id,
      text: target.message || ""
    },
    our_messages: ourMessages.map(m => ({
      id: m.id,
      text: m.message || ""
    })),
    replies_to_our_messages: repliesToUs
  };
}

async function getDiscussionThread(inputPeer, discussionRootId) {
  const result = new Map();
  const limit = 100;
  let offset_id = 0;

  while (true) {
    const history = await mtprotoCall('messages.getHistory', {
      peer: inputPeer,
      offset_id,
      limit
    });

    const messages = history.messages || [];
    if (messages.length === 0) break;

    for (const m of messages) {
      if (m._ !== 'message') continue;

      if (m.id === discussionRootId) {
        result.set(m.id, m);
        return [...result.values()].sort((a, b) => a.id - b.id);
      }

      if (m.id < discussionRootId) {
        return [...result.values()].sort((a, b) => a.id - b.id);
      }

      if (
        m.reply_to?.reply_to_top_id === discussionRootId ||
        m.reply_to?.reply_to_msg_id === discussionRootId
      ) {
        result.set(m.id, m);
      }
    }

    offset_id = messages[messages.length - 1].id;
  }

  return [...result.values()].sort((a, b) => a.id - b.id);
}

async function sendCommentToPost(channelPeer, channelGroupId, target, comment, edition, prompt) {
  try {
    // 1️⃣ Отримуємо ID останнього поста каналу
    const { channelPostId } = await getLastChannelPost(channelPeer);
    const discussionRoot = await findDiscussionRoot(channelPeer, channelPostId);
    console.log(`📰 Last channel post ID: ${channelPostId}`);
    console.log(`🧵 Discussion root ID: ${discussionRoot.id}`);

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
      let jsonPayload;
      if (target == '@') {
        const discussionThread = await getDiscussionThread(getInputPeer(linkedChat.peer), discussionRoot.id);
        jsonPayload = JSON.stringify(await buildLLMPayload(discussionThread, discussionRoot.id), null, 2);
      }    

      const res = await handlePrompt(prompt, jsonPayload || targetMessage.message);

      if (res.skip) {
        console.log(`Skip sending to ${channelGroupId} due to agent directive`);
        return;
      }

      if (!res.answer) {
        console.log(`Skip sending to ${channelGroupId} due to an empty answer`);
        return;
      }
      
      if (res.message_id) {
        params.reply_to_msg_id = res.message_id;
      }

      params.message = res.answer;
    }

    let sendAsPeer = await getSendAsPeer();    
    if (sendAsPeer) {
      params.send_as = getSendAsChannel(sendAsPeer);
    } 

    // avoid replying to our messages
    if (params.reply_to_msg_id == targetMessage.id) {
      if (isOurMessage(targetMessage, sendAsPeer)) {
        throw new Error('Skip replying to our message.');       
      } 
    }    

    // 7️⃣ process message    
    await withTemporaryClearedBio(
      () => sendAndMaybeEditAndMaybeDelete(params, edition, `comment in ${channelGroupId}`)
    );

    TOTAL_SENT++;
    console.log(`✅ Comment sent (reply_to=${params.reply_to_msg_id}) in ${channelGroupId}`);
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
    const { channelPostId } = await getLastChannelPost(channelPeer);    
    console.log(`📰 Last channel post ID: ${channelPostId}`);

    // 4️⃣ Знаходимо discussion root для ОСТАННЬОГО поста
    const discussionRoot = await findDiscussionRoot(channelPeer, channelPostId);

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
    let targetMessage;
    if (target === '$' || target === '*') {
      if (!comments.length) {
        throw new Error('No comments for post');
      }
      if (target === '$') {
        targetMessage = comments[0];
        console.log(`💬 Last comment ID: ${targetMessage.id}`);
      } else if (target === '*') {
        targetMessage = comments[getRandomNumber(0, comments.length - 1)];
        console.log(`💬 Random comment ID: ${targetMessage.id}`);
      } 
    } else {
      targetMessage = discussionRoot;
      console.log(`💬 Root ID: ${targetMessage.id}`);
    }

    console.log(`🎯 Reacting to comment ID: ${targetMessage.id}`);

    let params = {
      peer: {
        _: 'inputPeerChannel',
        channel_id: linkedChat.peer.id,
        access_hash: linkedChat.peer.access_hash
      },
      msg_id: targetMessage.id,
      reaction: [{ _: 'reactionEmoji', emoticon: reaction }],
      big: false
    };

    let sendAsPeer = await getSendAsPeer();    
    if (sendAsPeer) {
      params.send_as = getSendAsChannel(sendAsPeer);
    }

    // avoid reacting to our messages    
    if (isOurMessage(targetMessage, sendAsPeer)) {
      throw new Error('Skip reacting to our message.');       
    } 

    /** 7️⃣ Відправка реакції */
    await mtprotoCall('messages.sendReaction', params);

    TOTAL_SENT++;
    console.log(`✅ Reacted to comment ${params.msg_id} in ${channelGroupId}`);
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

  TOTAL_SENT++;
  console.log(`❤️ Reacted to new post ${postId} in ${channelGroupId}`);
}

async function sendCommentToSpecificPost(channelPeer, channelGroupId, postId, comment, edition, prompt) {
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

    if (!res.answer) {
      console.log(`Skip sending to ${channelGroupId} due to an empty answer`);
      return;
    }

    text = res.answer;
  }

  let sendAsPeer = await getSendAsPeer();  

  const sendParams = {
    peer: {
      _: 'inputPeerChannel',
      channel_id: linkedChat.peer.id,
      access_hash: linkedChat.peer.access_hash
    },
    message: text,
    reply_to_msg_id: discussionRoot.id,
    random_id: BigInt(Date.now()).toString(),
    ...(sendAsPeer && { send_as: getSendAsChannel(sendAsPeer) })
  };

  // process message
  await withTemporaryClearedBio(
    () => sendAndMaybeEditAndMaybeDelete(sendParams, edition, `comment in ${channelGroupId}`)
  );

  TOTAL_SENT++;
  console.log(`💬 Commented on new post ${postId} in ${channelGroupId}`);
}

/* -- CHANNEL CHAT POSTING -- */

async function handleDebouncedPost(
  channelPeer,
  groupConfig,
  postId  
) {
  const { groupid, comment, edition, reaction, prompt } = groupConfig;

  console.log(`⏳ Debounced post ${postId} in ${groupid}`);

  if (comment || prompt) {
    await sendCommentToSpecificPost(
      channelPeer,
      groupid,
      postId,
      comment,
      edition,
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
  postId,
  postDate  
) {

  const key = `${channelPeer.id}:${groupConfig.id}`;

  const lastSeen = lastSeenPost.get(key);  
  if (lastSeen && postId <= lastSeen) return;    
  lastSeenPost.set(key, postId);  

  const existing = channelDebounce.get(key);
  if (existing?.timer) {
    clearTimeout(existing.timer);
  }

  const now = Math.floor(Date.now() / 1000); 
  const elapsedSec = now - postDate;
  const elapsedMin = Math.floor(elapsedSec / 60);
  const elapsedHours = Math.floor(elapsedSec / 3600);

  const postDebounce = getConfigItem('TELEGRAM_NEW_POST_DEBOUNCE') || '10';
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
  }, parseInt(postDebounce, 10) * 1000);

  channelDebounce.set(key, { postId, timer });   
  
  console.log(
    `📰 Scheduled reply in ${groupConfig.groupid} to post ID ${postId} created ${elapsedSec}s (~${elapsedMin}m, ~${elapsedHours}h) ago`
  );  
}

async function pollChannelsForNewPosts() {
  if (CH_POLLING_LOCK) return;
  CH_POLLING_LOCK = true;

  try {
    const data = await prepareGroups();

    for (const group of data) {
      if (group.target !== '^') continue;

      const { groupid } = group;
      const { peer } = await getPeerCached(groupid);

      if (peer._ !== 'channel') continue;
      
      const { channelPostId, postDate } = await getLastChannelPost(peer);

      const maxPostAge = parseInt(getConfigItem('TELEGRAM_NEW_POST_MAX_AGE') || '30', 10);
      const lastPostAge = getSecondsDifferenceToNow(postDate);
      if (lastPostAge > maxPostAge) {
        continue;
      }

      scheduleDebouncedPost(peer, group, channelPostId, postDate);      
    }
  } catch (err) {
    console.error('❌ Polling error:', err);
  } finally {
    CH_POLLING_LOCK = false;
  }
}

async function pollPrivateMessages() {
  if (PM_POLLING_LOCK) return;
  PM_POLLING_LOCK = true;

  try {
    const replyText = getConfigItem('TELEGRAM_PM_AUTOREPLY_TEXT');
    if (!replyText) return;

    const dialogs = await mtprotoCall('messages.getDialogs', {
      offset_date: 0,
      offset_id: 0,
      offset_peer: { _: 'inputPeerEmpty' },
      limit: 20,
      hash: 0
    });

    for (const dialog of dialogs.dialogs || []) {
      if (dialog.peer?._ !== 'peerUser') continue;

      const userId = dialog.peer.user_id;
      
      if (processedPMs.has(userId)) continue;      

      const inputPeer = { 
        _: 'inputPeerUser', 
        user_id: userId, 
        access_hash: dialogs.users.find(u => u.id === userId)?.access_hash
      };
      
      const history = await mtprotoCall('messages.getHistory', {
        peer: inputPeer,
        limit: 1
      });

      const msg = history.messages?.[0];
      if (!isPrivateMessage(msg)) continue;

      console.log(`💬 PM from ${userId}: ${msg.message}`);

      await mtprotoCall('messages.sendMessage', {
        peer: inputPeer,
        message: replyText,
        random_id: BigInt(Date.now()).toString()
      });

      processedPMs.set(userId, true);

      TOTAL_SENT++;
      console.log(`✅ Auto-replied to ${userId}`);
    }
  } catch (err) {
    console.error('❌ PM polling error:', err);
  } finally {
    PM_POLLING_LOCK = false;
  }
}

async function processGroups(requestCode) {  
  try {        
    await authenticate(requestCode);  
    await initSelf();

    // cache warmup
    await prepareGroups();  
    
    const pmInterval = getConfigItem('TELEGRAM_PM_POLL_INTERVAL') || '30';
    pmTimer = setInterval(() => {
      if (!getIsRunning()) return;
      pollPrivateMessages();
    }, parseInt(pmInterval, 10) * 1000);
      
    const pollIterval = getConfigItem('TELEGRAM_CH_POLL_INTERVAL') || '20';
    pollTimer = setInterval(() => {
      if (!getIsRunning()) return;
      pollChannelsForNewPosts();
    }, parseInt(pollIterval, 10) * 1000);  
    
    while (getIsRunning()) {
      const data = await prepareGroups();
      for (const group of data) {        
        const { groupid, comment, edition, reaction, prompt, target } = group;
        console.log(`\n⚙️ Processing ${groupid}`);

        if (target == '^') continue;   

        const { peer } = await getPeerCached(groupid);
        const type = getPeerType(peer);

        if (type == 'group' || type == 'supergroup') {
          if (comment || prompt) await sendMessage(peer, groupid, comment, edition, target, prompt);            
          if (reaction) await reactToMessage(peer, groupid, reaction, target);                     
        } else if (type == 'channel') {          
          if (comment || prompt) await sendCommentToPost(peer, groupid, target, comment, edition, prompt);                
          if (reaction) await reactToCommentOfPost(peer, groupid, target, reaction);                           
        }      

      }

      console.log(`🛌 Go to sleep`);
      const iterationDelay = getConfigItem('TELEGRAM_ITERATION_DELAY') || '60';
      await sleep(parseInt(iterationDelay, 10) * 1000);
    }  
  } catch (err) {
    console.log(err);
    return;
  } finally {
    setIsRunning(false);
    clearInterval(pmTimer);
    clearInterval(pollTimer);    
    processedPMs.clear();
    lastSeenPost.clear();
    channelDebounce.clear();
    console.log(`exiting`);
  }    
}

module.exports.processGroups = processGroups;
module.exports.getTotalSent = getTotalSent;
module.exports.getIsRunning = getIsRunning;
module.exports.setIsRunning = setIsRunning;