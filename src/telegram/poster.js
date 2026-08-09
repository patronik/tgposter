const { readData, getConfigItem } = require('../config');
const { getCurrentClient, getCurrentPhone, advanceToNextAccount, authenticate, isMultiAccountMode, getAccountList, setCurrentIndex } = require('./mtproto');
const { sleep, getRandomNumber } = require('../utils');
const {
  queryLLM,
  LLMEnabled,
  buildAiContext,
  buildPmAiContext,
  resolvePmMode,
  getPmPrompt,
  shouldOccasionallySkip,
  maybeAiReplyDelay,
} = require('../ai');

/* -- STATE -- */
let SELF_USER_ID = null;

let BIO_LOCK = false;
let SAVED_BIO = null;

let CH_POLLING_LOCK = false;

let PM_POLLING_LOCK = false;

let IS_RUNNING = false;

let TOTAL_SENT = 0;

/** @type {Record<string, number>} messages sent per group/channel id */
let SENT_BY_GROUP = {};

// Per-account caches: Map<accountKey, Map<...>> so multi-account mode does not share state
const lastSeenPost = new Map();
const channelDebounce = new Map();
const channelPeerCache = new Map();
const channelIgnorePeer = new Map();
const linkedChatCache = new Map();

/** Returns the inner cache for the current account so caches are not shared across accounts. */
function getAccountScopedCache(store) {
  const accountKey = getCurrentPhone() ?? 'default';
  if (!store.has(accountKey)) store.set(accountKey, new Map());
  return store.get(accountKey);
}

let pmTimer = null;
let pollTimer = null;

/** @type {Map<string, number>} last incoming PM message id we already handled per user */
const lastHandledPmByUser = new Map();

function getIsRunning() {
  return IS_RUNNING;
}

function setIsRunning(value) {
  IS_RUNNING = value;
}

function getTotalSent() {
  return TOTAL_SENT;
}

function getSentByGroup() {
  return { ...SENT_BY_GROUP };
}
/* -- STATE END -- */

async function mtprotoCall(method, data, retry = 0) {
  const mtproto = getCurrentClient();
  if (!mtproto) throw new Error('No Telegram client (add account or set TELEGRAM_PHONE_NUM)');
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
        console.log(`Retry ${retry + 1}`);
        return await mtprotoCall(method, data, retry + 1);
      } else {
        throw err;
      }
    } else {
      throw err;
    }
  }
}

function onMessageSent(groupid) {
  TOTAL_SENT++;
  if (groupid) {
    const key = String(groupid);
    SENT_BY_GROUP[key] = (SENT_BY_GROUP[key] || 0) + 1;
  }
  if (isMultiAccountMode()) {
    const frequency = Math.max(1, parseInt(String(getConfigItem('ACCOUNT_CHANGE_FREQUENCY') || '1'), 10) || 1);
    // frequency 1 => change after every message; frequency n => change every n messages
    const shouldRotate = frequency === 1 || TOTAL_SENT % frequency === 0;
    if (shouldRotate) {
      advanceToNextAccount();
      SELF_USER_ID = null;
    }
  }
}

function getInputPeer(peer) {
  if (peer._ === 'inputPeerChannel' || peer._ === 'inputPeerChat') return peer;
  let inputPeer;
  if (peer._ === 'chat') {
    inputPeer = { _: 'inputPeerChat', chat_id: peer.id };
  } else {
    inputPeer = {
      _: 'inputPeerChannel',
      channel_id: peer.channel_id ?? peer.id,
      access_hash: peer.access_hash,
    };
  }
  return inputPeer;
}

/** Mute notifications for a chat/channel so other devices (same account) don't get notified. */
async function mutePeerNotifications(peer) {
  try {
    const inputPeer = getInputPeer(peer);
    await mtprotoCall('account.updateNotifySettings', {
      peer: {
        _: 'inputNotifyPeer',
        peer: inputPeer,
      },
      settings: {
        _: 'inputPeerNotifySettings',
        flags: 2,
        mute_until: 2147483647, // effectively forever
      },
    });
    console.log('🔇 Muted notifications for this chat/channel');
  } catch (err) {
    console.warn('Could not mute notifications:', err.message || err.error_message);
  }
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
    (msg.message || msg.media)
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
  const cache = getAccountScopedCache(channelPeerCache);
  if (cache.has(id)) return cache.get(id);
  const result = await ensureMembership(id);
  cache.set(id, result);
  return result;
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

async function handlePrompt(prompt, input, aiContext = null) {
  let result = {
    skip: false,
    answer: "",
    message_id: null
  };

  if (shouldOccasionallySkip()) {
    console.log('Skip sending due to AI_SKIP_PROBABILITY');
    return { ...result, skip: true };
  }

  await maybeAiReplyDelay(sleep);

  const response = await queryLLM(`${prompt}\nINPUT:\n${input}`, 2, aiContext);
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

function getMessageSenderId(message) {
  if (message?.from_id?.user_id != null) return `user:${message.from_id.user_id}`;
  if (message?.from_id?.channel_id != null) return `channel:${message.from_id.channel_id}`;
  return 'unknown';
}

function isOursInThread(message, sendAsPeer) {
  if (sendAsPeer) {
    return message?.from_id?.channel_id === sendAsPeer.id;
  }
  return message?.from_id?.user_id === SELF_USER_ID;
}

function buildThreadTree(messages, discussionRootId, sendAsPeer) {
  const nodes = new Map();

  for (const m of messages) {
    const parentId =
      m.id === discussionRootId
        ? null
        : (m.reply_to?.reply_to_msg_id ?? discussionRootId);

    nodes.set(m.id, {
      id: m.id,
      text: m.message || '',
      parent_id: parentId,
      from: getMessageSenderId(m),
      is_ours: isOursInThread(m, sendAsPeer),
      children: [],
    });
  }

  for (const node of nodes.values()) {
    if (node.parent_id != null && nodes.has(node.parent_id)) {
      nodes.get(node.parent_id).children.push(node);
    }
  }

  for (const node of nodes.values()) {
    node.children.sort((a, b) => a.id - b.id);
  }

  return nodes.get(discussionRootId) || null;
}

function flattenThreadNodes(rootNode) {
  if (!rootNode) return [];
  const out = [];
  const walk = (node) => {
    out.push({
      id: node.id,
      text: node.text,
      parent_id: node.parent_id,
      from: node.from,
      is_ours: node.is_ours,
    });
    for (const child of node.children || []) walk(child);
  };
  walk(rootNode);
  return out;
}

function pickSuggestedTarget(messages, root, ourMessages, unansweredToUs, replyStrategy) {
  const nonOurs = messages.filter((m) => !ourMessages.some((om) => om.id === m.id));

  switch (replyStrategy) {
    case 'root':
      return { target: root, reason: 'root strategy' };
    case 'unanswered_to_us':
      if (!unansweredToUs.length) {
        return { target: null, reason: 'no unanswered replies to us', skip: true };
      }
      return {
        target: messages.find((m) => m.id === unansweredToUs[0].id) || null,
        reason: 'unanswered reply to our message',
      };
    case 'any_thread':
      return { target: null, reason: 'llm chooses any thread message', llmChooses: true };
    case 'last': {
      const latest = [...nonOurs].sort((a, b) => b.id - a.id)[0] || root;
      return { target: latest, reason: 'latest non-ours message' };
    }
    case 'random': {
      if (!nonOurs.length) return { target: root, reason: 'fallback root' };
      const picked = nonOurs[getRandomNumber(0, nonOurs.length - 1)];
      return { target: picked, reason: 'random non-ours message' };
    }
    case 'auto':
    default:
      if (!ourMessages.length) {
        return { target: root, reason: 'auto: no our messages yet' };
      }
      if (unansweredToUs.length) {
        return {
          target: messages.find((m) => m.id === unansweredToUs[0].id) || root,
          reason: 'auto: newest unanswered reply to us',
        };
      }
      return { target: root, reason: 'auto: fallback to root' };
  }
}

async function ensureMembership(groupidOrInvite) {
  try {
    const inviteHash = extractInviteHash(groupidOrInvite);

    if (inviteHash) {
      try {
        const imported = await mtprotoCall('messages.importChatInvite', { hash: inviteHash });
        const peer = imported.chats[0];
        console.log(`✅ Joined via invite: ${groupidOrInvite}`);
        await mutePeerNotifications(peer);
        return { peer };
      } catch (error) {
        if (error.error_message.includes('USER_ALREADY_PARTICIPANT')) {
          const checked = await mtprotoCall('messages.checkChatInvite', { hash: inviteHash });
          console.log(`ℹ️ Already in: ${groupidOrInvite}`);
          await mutePeerNotifications(checked.chat);
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
        await mutePeerNotifications(peer);
        return { peer };
      } catch (error) {
        if (error.error_message === 'USER_NOT_PARTICIPANT') {
          await mtprotoCall('channels.joinChannel', {
            channel: inputChannel,
          });
          console.log(`✅ Joined ${groupidOrInvite}`);
          await mutePeerNotifications(peer);
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
    const cache = getAccountScopedCache(linkedChatCache);
    if (cache.has(channelPeer.id)) {
      return cache.get(channelPeer.id);
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

    cache.set(channelPeer.id, result);
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
  const res = await mtprotoCall('users.getFullUser', { id: { _: 'inputUserSelf' } });
  return res.full_user?.about ?? '';
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
      await updateProfile({ bio: 'What a day!' });
      console.log(`🧹 Bio cleared`);
    }

    const result = await action();

    if (SAVED_BIO) {
      setTimeout(async () => {
        try {
          await updateProfile({ bio: SAVED_BIO });
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
  const ignoreCache = getAccountScopedCache(channelIgnorePeer);
  for (const group of data) {
    try {
      if (ignoreCache.has(group.groupid)) continue;
      await getPeerCached(group.groupid);
    } catch (err) {
      ignoreCache.set(group.groupid, true);
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
async function sendMessage(peer, groupid, message, edition, target, prompt, aiContext = null) {
  try {
    let inputPeer = getInputPeer(peer);
    const ctx = aiContext || buildAiContext({});

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
          const payload = await buildLLMPayload(
            discussionThread,
            targetMessage.id,
            ctx.replyStrategy
          );
          if (payload.skip_suggested) {
            console.log(`Skip sending to ${groupid}: ${payload.suggested_reason}`);
            return;
          }
          if (payload.target?.id) {
            params.reply_to_msg_id = payload.target.id;
            targetMessage =
              discussionThread.find((m) => m.id === payload.target.id) || targetMessage;
          }
          jsonPayload = JSON.stringify(payload, null, 2);
        }

        const res = await handlePrompt(prompt, jsonPayload || targetMessage.message, ctx);

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

    onMessageSent(groupid);
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
    } else if (target === '*') {
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

    onMessageSent(groupid);
    console.log(`✅ Reacted to message ${params.msg_id} in ${groupid}`);
  } catch (error) {
    console.error(`❌ React error in ${groupid}:`, error);
  }
}

/* -- END GROUP POSTING -- */

/* -- CHANNEL CHAT POSTING -- */

async function buildLLMPayload(messages, discussionRootId, replyStrategy = 'auto') {
  const root = messages.find(m => m.id === discussionRootId);
  if (!root) throw new Error('Root message not found');

  const sendAsPeer = await getSendAsPeer();
  const ourMessages = messages.filter((m) => isOursInThread(m, sendAsPeer));

  const repliesToUs = messages
    .filter(m =>
      m.reply_to &&
      ourMessages.some(om => om.id === m.reply_to.reply_to_msg_id)
    )
    .map(m => ({
      id: m.id,
      text: m.message || "",
      parent_id: m.reply_to.reply_to_msg_id,
      reply_to_our_message_id: m.reply_to.reply_to_msg_id,
      is_ours: isOursInThread(m, sendAsPeer),
    }))
    .sort((a, b) => b.id - a.id);

  // Replies to us that we have not answered yet (no our message with parent = that reply)
  const unansweredToUs = repliesToUs.filter(
    (reply) => !ourMessages.some((om) => om.reply_to?.reply_to_msg_id === reply.id)
  );

  const suggestion = pickSuggestedTarget(
    messages,
    root,
    ourMessages,
    unansweredToUs,
    replyStrategy
  );

  const tree = buildThreadTree(messages, discussionRootId, sendAsPeer);
  const flat = flattenThreadNodes(tree);

  return {
    reply_strategy: replyStrategy,
    skip_suggested: Boolean(suggestion.skip),
    suggested_reason: suggestion.reason,
    llm_chooses_target: Boolean(suggestion.llmChooses),
    root: {
      id: root.id,
      text: root.message || "",
      from: getMessageSenderId(root),
    },
    target: suggestion.target
      ? {
          id: suggestion.target.id,
          text: suggestion.target.message || "",
          from: getMessageSenderId(suggestion.target),
        }
      : null,
    our_messages: ourMessages.map(m => ({
      id: m.id,
      text: m.message || "",
      parent_id: m.reply_to?.reply_to_msg_id ?? null,
    })),
    replies_to_our_messages: repliesToUs,
    unanswered_replies_to_us: unansweredToUs,
    thread: {
      tree,
      messages: flat,
    },
  };
}

async function getDiscussionThread(inputPeer, discussionRootId) {
  const candidates = new Map();
  const limit = 100;
  let offset_id = 0;
  let foundRoot = false;

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
        candidates.set(m.id, m);
        foundRoot = true;
        break;
      }

      if (m.id < discussionRootId) {
        foundRoot = true;
        break;
      }

      candidates.set(m.id, m);
    }

    if (foundRoot) break;
    offset_id = messages[messages.length - 1].id;
  }

  const belongsToThread = (message) => {
    if (!message) return false;
    if (message.id === discussionRootId) return true;
    if (message.reply_to?.reply_to_top_id === discussionRootId) return true;

    let parentId = message.reply_to?.reply_to_msg_id;
    const seen = new Set();
    while (parentId && !seen.has(parentId)) {
      if (parentId === discussionRootId) return true;
      seen.add(parentId);
      const parent = candidates.get(parentId);
      if (!parent) break;
      parentId = parent.reply_to?.reply_to_msg_id;
    }
    return false;
  };

  return [...candidates.values()]
    .filter(belongsToThread)
    .sort((a, b) => a.id - b.id);
}

async function sendCommentToPost(channelPeer, channelGroupId, target, comment, edition, prompt, aiContext = null) {
  try {
    const ctx = aiContext || buildAiContext({});

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
        const payload = await buildLLMPayload(
          discussionThread,
          discussionRoot.id,
          ctx.replyStrategy
        );
        if (payload.skip_suggested) {
          console.log(`Skip sending to ${channelGroupId}: ${payload.suggested_reason}`);
          return;
        }
        if (payload.target?.id) {
          params.reply_to_msg_id = payload.target.id;
          targetMessage =
            discussionThread.find((m) => m.id === payload.target.id) || targetMessage;
        }
        jsonPayload = JSON.stringify(payload, null, 2);
      }

      const res = await handlePrompt(prompt, jsonPayload || targetMessage.message, ctx);

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

    onMessageSent(channelGroupId);
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

    onMessageSent(channelGroupId);
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

  onMessageSent(channelGroupId);
  console.log(`❤️ Reacted to new post ${postId} in ${channelGroupId}`);
}

async function sendCommentToSpecificPost(channelPeer, channelGroupId, postId, comment, edition, prompt, aiContext = null) {
  const ctx = aiContext || buildAiContext({});
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
  let replyToMsgId = discussionRoot.id;

  if (prompt && LLMEnabled()) {
    const discussionThread = await getDiscussionThread(
      getInputPeer(linkedChat.peer),
      discussionRoot.id
    );
    const payload = await buildLLMPayload(
      discussionThread,
      discussionRoot.id,
      ctx.replyStrategy
    );

    if (payload.skip_suggested) {
      console.log(`Skip sending to ${channelGroupId}: ${payload.suggested_reason}`);
      return;
    }

    if (payload.target?.id) {
      replyToMsgId = payload.target.id;
    }

    const res = await handlePrompt(prompt, JSON.stringify(payload, null, 2), ctx);

    if (res.skip) {
      console.log(`Skip sending to ${channelGroupId} due to agent directive`);
      return;
    }

    if (!res.answer) {
      console.log(`Skip sending to ${channelGroupId} due to an empty answer`);
      return;
    }

    if (res.message_id) {
      replyToMsgId = res.message_id;
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
    reply_to_msg_id: replyToMsgId,
    random_id: BigInt(Date.now()).toString(),
    ...(sendAsPeer && { send_as: getSendAsChannel(sendAsPeer) })
  };

  // process message
  await withTemporaryClearedBio(
    () => sendAndMaybeEditAndMaybeDelete(sendParams, edition, `comment in ${channelGroupId}`)
  );

  onMessageSent(channelGroupId);
  console.log(`💬 Commented on new post ${postId} in ${channelGroupId}`);
}

/* -- CHANNEL CHAT POSTING -- */

async function handleDebouncedPost(
  channelPeer,
  groupConfig,
  postId
) {
  const { groupid, comment, edition, reaction, prompt } = groupConfig;
  const aiContext = buildAiContext(groupConfig);

  console.log(`⏳ Debounced post ${postId} in ${groupid}`);

  if (comment || prompt) {
    await sendCommentToSpecificPost(
      channelPeer,
      groupid,
      postId,
      comment,
      edition,
      prompt,
      aiContext
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
  const lastSeenCache = getAccountScopedCache(lastSeenPost);
  const debounceCache = getAccountScopedCache(channelDebounce);

  const lastSeen = lastSeenCache.get(key);
  if (lastSeen && postId <= lastSeen) return;
  lastSeenCache.set(key, postId);

  const existing = debounceCache.get(key);
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
      debounceCache.delete(key);
    }
  }, parseInt(postDebounce, 10) * 1000);

  debounceCache.set(key, { postId, timer });

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

function buildPmConversationPayload(messages, user) {
  const chronological = [...messages]
    .filter((m) => m?._ === 'message' && m.id)
    .sort((a, b) => a.id - b.id);

  const mapped = chronological.map((m) => ({
    id: m.id,
    text: m.message || '',
    parent_id: m.reply_to?.reply_to_msg_id ?? null,
    is_ours: m.out === true,
    from: m.out === true ? 'us' : 'them',
  }));

  const latestIncoming = [...mapped].reverse().find((m) => !m.is_ours) || null;
  const latest = mapped[mapped.length - 1] || null;

  return {
    chat_type: 'private',
    peer: {
      user_id: user.id,
      username: user.username || null,
      first_name: user.first_name || null,
      last_name: user.last_name || null,
    },
    messages: mapped,
    latest,
    latest_incoming: latestIncoming,
    target: latestIncoming,
  };
}

async function replyToPrivateMessageAutoreply(inputPeer, userId, messages, replyText) {
  const alreadyReplied = messages.some(
    (m) =>
      m.out === true &&
      typeof m.message === 'string' &&
      m.message.trim() === replyText.trim()
  );
  if (alreadyReplied) return false;

  const incoming = messages.find((m) => isPrivateMessage(m) && m.out !== true);
  if (!incoming) return false;

  console.log(`💬 PM from ${userId}: ${incoming.message}`);

  await mtprotoCall('messages.sendMessage', {
    peer: inputPeer,
    message: replyText,
    random_id: BigInt(Date.now()).toString(),
  });

  onMessageSent();
  console.log(`✅ Auto-replied to ${userId}`);
  return true;
}

async function replyToPrivateMessageAi(inputPeer, user, messages) {
  if (!LLMEnabled()) {
    console.log('Skip AI PM reply: GROQ_API_KEY is not configured');
    return false;
  }

  const validMessages = (messages || []).filter((m) => m?._ === 'message' && m.id);
  if (!validMessages.length) return false;

  // Newest first from Telegram history
  const latest = validMessages[0];
  if (!latest || latest.out === true || !isPrivateMessage(latest)) {
    return false;
  }

  const userKey = String(user.id);
  if (lastHandledPmByUser.get(userKey) === latest.id) {
    return false;
  }

  const payload = buildPmConversationPayload(validMessages, user);
  const aiContext = buildPmAiContext();
  const prompt = getPmPrompt();

  console.log(`💬 AI PM from ${user.id}: ${latest.message}`);

  const res = await handlePrompt(prompt, JSON.stringify(payload, null, 2), aiContext);

  // Mark handled even on skip so we don't hammer the same message every poll
  lastHandledPmByUser.set(userKey, latest.id);

  if (res.skip) {
    console.log(`Skip AI PM reply to ${user.id} due to agent directive`);
    return false;
  }

  if (!res.answer) {
    console.log(`Skip AI PM reply to ${user.id} due to an empty answer`);
    return false;
  }

  const sendParams = {
    peer: inputPeer,
    message: res.answer,
    random_id: BigInt(Date.now()).toString(),
  };

  if (res.message_id) {
    sendParams.reply_to_msg_id = res.message_id;
  } else if (payload.target?.id) {
    sendParams.reply_to_msg_id = payload.target.id;
  }

  await mtprotoCall('messages.sendMessage', sendParams);
  onMessageSent();
  console.log(`✅ AI-replied to PM ${user.id}`);
  return true;
}

async function pollPrivateMessages() {
  if (PM_POLLING_LOCK) return;
  PM_POLLING_LOCK = true;

  try {
    const mode = resolvePmMode();
    if (mode === 'off') return;

    const replyText = getConfigItem('TELEGRAM_PM_AUTOREPLY_TEXT');
    if (mode === 'autoreply' && !replyText) return;
    if (mode === 'ai' && !LLMEnabled()) {
      console.log('TELEGRAM_PM_MODE=ai but GROQ_API_KEY is missing');
      return;
    }

    const dialogs = await mtprotoCall('messages.getDialogs', {
      offset_date: 0,
      offset_id: 0,
      offset_peer: { _: 'inputPeerEmpty' },
      limit: 100,
      hash: 0
    });

    for (const dialog of dialogs.dialogs || []) {
      if (dialog.peer?._ !== 'peerUser') continue;

      const userId = dialog.peer.user_id;

      const user = dialogs.users.find(u => u.id === userId);
      if (!user?.access_hash) continue;

      const inputPeer = {
        _: 'inputPeerUser',
        user_id: userId,
        access_hash: user.access_hash
      };

      const historyLimit = mode === 'ai' ? 40 : 10;
      const history = await mtprotoCall('messages.getHistory', {
        peer: inputPeer,
        limit: historyLimit
      });

      const messages = history.messages || [];
      if (!messages.length) continue;

      if (mode === 'ai') {
        await replyToPrivateMessageAi(inputPeer, user, messages);
      } else {
        await replyToPrivateMessageAutoreply(inputPeer, userId, messages, replyText);
      }
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

    // Warm up self/profile and group membership for all accounts before processing
    if (isMultiAccountMode()) {
      const accounts = getAccountList();
      for (let i = 0; i < accounts.length; i++) {
        setCurrentIndex(i);
        SELF_USER_ID = null;
        await initSelf();
        await prepareGroups();
      }
    } else {
      SELF_USER_ID = null;
      await initSelf();
      await prepareGroups();
    }

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

      const throttlingRateRaw = getConfigItem('TELEGRAM_THROTLING_RATE') || '0';
      const throttlingRate =
        Math.min(100, Math.max(0, parseInt(String(throttlingRateRaw), 10) || 0));

      const postingDelayRaw = getConfigItem('TELEGRAM_POSTING_DELAY') || '0';
      const postingDelay = parseInt(String(postingDelayRaw), 10) || 0;


      for (const group of data) {
        const { groupid, comment, edition, reaction, prompt, target } = group;
        const aiContext = buildAiContext(group);
        console.log(`\n⚙️ Processing ${groupid}`);

        if (throttlingRate > 0) {
          const roll = Math.random() * 100;
          if (roll < throttlingRate) {
            console.log(
              `⏭️ Skipping ${groupid} due to TELEGRAM_THROTLING_RATE=${throttlingRate} (roll=${roll.toFixed(
                2
              )})`
            );
            const apiDelay = getConfigItem('TELEGRAM_API_DELAY') || '10';
            await sleep(parseInt(apiDelay, 10) * 1000);
            continue;
          }
        }

        if (target == '^') continue;

        let peer;
        try {
          ({ peer } = await getPeerCached(groupid));
        } catch (err) {
          console.log('Failed to retrieve a peer.')
          continue;
        }

        const type = getPeerType(peer);

        if (type == 'group' || type == 'supergroup') {
          if (comment || prompt) await sendMessage(peer, groupid, comment, edition, target, prompt, aiContext);
          if (reaction) await reactToMessage(peer, groupid, reaction, target);
        } else if (type == 'channel') {
          if (comment || prompt) await sendCommentToPost(peer, groupid, target, comment, edition, prompt, aiContext);
          if (reaction) await reactToCommentOfPost(peer, groupid, target, reaction);
        }

	if (postingDelay > 0) {
            console.log(`Sleep for ${postingDelay} seconds...`);
	    await sleep(postingDelay * 1000);
	}

      }

      console.log(`🛌 Go to sleep`);
      const iterationDelay = getConfigItem('TELEGRAM_ITERATION_DELAY') || '60';
      await sleep(parseInt(iterationDelay, 10) * 1000);
    }
  } catch (err) {
    console.log(err);
  } finally {
    setIsRunning(false);
    clearInterval(pmTimer);
    clearInterval(pollTimer);
    lastHandledPmByUser.clear();
    for (const m of lastSeenPost.values()) m.clear();
    lastSeenPost.clear();
    for (const m of channelDebounce.values()) {
      for (const entry of m.values()) {
        if (entry?.timer) clearTimeout(entry.timer);
      }
      m.clear();
    }
    channelDebounce.clear();
    console.log(`exiting`);
  }
}

async function getProfile() {
  const phone = getCurrentPhone() || '';
  const list = getAccountList();
  if (!list.length) {
    return { loggedIn: false, phone, username: '', bio: '', hasPhoto: false };
  }
  try {
    const res = await mtprotoCall('users.getFullUser', { id: { _: 'inputUserSelf' } });
    const user = res.users && res.users[0];
    const fullUser = res.full_user;
    if (!user) {
      return { loggedIn: true, phone, username: '', bio: '', hasPhoto: false };
    }
    const username = user.username || '';
    const bio = (fullUser && fullUser.about) || '';
    const hasPhoto = Boolean(user.photo && user.photo._ === 'userProfilePhoto');
    return { loggedIn: true, phone, username, bio, hasPhoto };
  } catch (err) {
    const msg = err.error_message || err.message || '';
    if (msg === 'AUTH_KEY_UNREGISTERED' || msg.includes('SESSION') || msg.includes('auth')) {
      return { loggedIn: false, phone, username: '', bio: '', hasPhoto: false };
    }
    throw err;
  }
}

async function getProfilePhotoBuffer() {
  try {
    const res = await mtprotoCall('users.getFullUser', { id: { _: 'inputUserSelf' } });
    const user = res.users && res.users[0];
    if (!user || !user.photo || user.photo._ !== 'userProfilePhoto') return null;
    const photoId = user.photo.photo_id;
    const location = {
      _: 'inputPeerPhotoFileLocation',
      peer: { _: 'inputPeerSelf' },
      photo_id: photoId,
      big: true,
    };
    const file = await mtprotoCall('upload.getFile', {
      location,
      offset: 0,
      limit: 1024 * 1024,
    });
    return file.bytes ? Buffer.from(file.bytes) : null;
  } catch (_) {
    return null;
  }
}

async function updateProfile({ username, bio }) {
  if (bio !== undefined) {
    await mtprotoCall('account.updateProfile', { about: bio || '' });
  }
  if (username !== undefined) {
    await mtprotoCall('account.updateUsername', { username: (username || '').trim() });
  }
}

module.exports.processGroups = processGroups;
module.exports.getTotalSent = getTotalSent;
module.exports.getSentByGroup = getSentByGroup;
module.exports.getIsRunning = getIsRunning;
module.exports.setIsRunning = setIsRunning;
module.exports.getProfile = getProfile;
module.exports.getProfilePhotoBuffer = getProfilePhotoBuffer;
module.exports.updateProfile = updateProfile;
