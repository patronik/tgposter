const { readData, getConfigItem } = require('../config');
const { mtproto, authenticate } = require(`./mtproto`);
const { sleep, getRandomNumber } = require('../utils');

let IS_RUNNING = false;

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

async function getRandomChannelPost(channelPeer) {
  const history = await mtprotoCall('messages.getHistory', {
    peer: { _: 'inputPeerChannel', channel_id: channelPeer.id, access_hash: channelPeer.access_hash },
    limit: 100,
  });
  if (!history.messages.length) throw new Error('No posts found');
  return history.messages[getRandomNumber(0, history.messages.length - 1)].id;
}

async function sendMessage(peer, groupid, message, prompt, target) {
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

    if (target) {
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
        if (!targetMessage?.id) {
          throw new Error('Random message not found.')
        }
      } else {
        throw new Error(`Unsupported target "${target}".`);
      }      

      params.reply_to_msg_id = targetMessage.id;

      // TODO implement replying with AI (if prompt is provided)
    }

    await mtprotoCall('messages.sendMessage', params);

    console.log(`✅ Message sent to ${groupid}`);
  } catch (error) {
    console.error(`❌ Error sending to ${groupid}:`, error);
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
      if (!targetMessage?.id) {
        throw new Error('Random message not found.')
      }
    } else {
      throw new Error(`Unsupported target "${target}".`);
    }

    await mtprotoCall('messages.sendReaction', {
      peer: { _: 'inputPeerChannel', channel_id: peer.id, access_hash: peer.access_hash },
      msg_id: targetMessage.id,
      reaction: [{ _: 'reactionEmoji', emoticon: reaction }],
      big: false,
    });
    console.log(`✅ Reacted to message https://t.me/${(groupid.replace('@', ''))}/${targetMessage.id} in ${groupid}`);
  } catch (error) {
    console.error(`❌ React error in ${groupid}:`, error);
  }
}

async function findDiscussionMessageId(linkedChatPeer, channelPeer, channelPostId) {
  try {
    const history = await mtprotoCall('messages.getHistory', {
      peer: { _: 'inputPeerChannel', channel_id: linkedChatPeer.id, access_hash: linkedChatPeer.access_hash },
      limit: 100,
    });

    const discussionMsgId = history.messages.find(msg => 
      msg.fwd_from?.saved_from_peer?.channel_id === channelPeer.id &&
      msg.fwd_from?.saved_from_msg_id === channelPostId
    );

    if (!discussionMsgId) {
      throw new Error('No discussion message found - maybe delayed?');
    }
    return discussionMsgId.id;
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
    const discussionRootId = await findDiscussionMessageId(
      linkedChat.peer,
      channelPeer,
      channelPostId
    );

    if (!discussionRootId) {
      throw new Error('Discussion root not found for last channel post');
    }

    console.log(`🧵 Discussion root ID: ${discussionRootId}`);

    let targetMessageId;

    // 5️⃣ Обробка target
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
        m.reply_to.reply_to_msg_id === discussionRootId
      );

      if (!postComments.length) {
        throw new Error('No comments found for last post');
      }

      if (target === '$') {
        targetMessageId = postComments[0].id;
        console.log(`💬 Last comment ID: ${targetMessageId}`);
      } else {
        const rnd = Math.floor(Math.random() * postComments.length);
        targetMessageId = postComments[rnd].id;
        console.log(`🎲 Random comment ID: ${targetMessageId}`);
      }
    } else {
      // 6️⃣ Reply без target → reply до discussion root
      targetMessageId = discussionRootId;
      console.log(`↩️ Replying to discussion root`);
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
        reply_to_msg_id: targetMessageId,
      },
      random_id: (
        BigInt(Date.now()) * 1000n +
        BigInt(Math.floor(Math.random() * 1000))
      ).toString(),
    });

    console.log(`✅ Comment sent (reply_to=${targetMessageId})`);
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
      await ensureMembership(`@${linkedChat.peer.username}`);
    } else if (linkedChat.peer.id && linkedChat.peer.access_hash) {
      await ensureMembership(`${linkedChat.peer.id}:${linkedChat.peer.access_hash}`);
    }

    /** 3️⃣ Отримуємо ОСТАННІЙ ПОСТ каналу */
    const channelHistory = await mtprotoCall('messages.getHistory', {
      peer: channelPeer,
      limit: 1
    });

    const lastPost = channelHistory.messages?.find(m => m._ === 'message' && m.id);
    if (!lastPost) throw new Error('No channel posts found');

    const postId = lastPost.id;
    console.log(`📰 Last channel post ID: ${postId}`);

    /** 4️⃣ Отримуємо коментарі ТІЛЬКИ до цього поста */
    const commentsHistory = await mtprotoCall('messages.getHistory', {
      peer: {
        _: 'inputPeerChannel',
        channel_id: linkedChat.peer.id,
        access_hash: linkedChat.peer.access_hash
      },
      limit: 50
    });

    const comments = (commentsHistory.messages || []).filter(m =>
      m._ === 'message' &&
      m.id &&
      m.reply_to?.reply_to_msg_id === postId
    );

    if (!comments.length) {
      throw new Error('No comments for last post');
    }

    /** 5️⃣ Вибір target */
    let targetMessageId;

    if (target === '$') {
      // останній коментар
      targetMessageId = comments[0].id;
    } else if (target === '*') {
      // випадковий коментар
      targetMessageId = comments[getRandomNumber(0, comments.length - 1)].id;
    } else {
      throw new Error('Invalid target');
    }

    console.log(`🎯 Reacting to comment ID: ${targetMessageId}`);

    /** 6️⃣ Відправка реакції */
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
  } catch (error) {
    console.error('❌ Comment react error:', error);
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

async function processGroups(requestCode) {
  try { 
    await authenticate(requestCode);

    IS_RUNNING = true;
    while (IS_RUNNING) {
      const data = readData();
      for (const group of data) {
        const { id, comment, reaction, prompt, target } = group;

        const { peer } = await ensureMembership(id);
        const type = getPeerType(peer);

        if (type == 'group' || type == 'supergroup') {
          if (comment) await sendMessage(peer, id, comment, prompt, target);
          if (reaction) await reactToMessage(peer, id, reaction, target || '*');
        } else if (type == 'channel') {
          if (comment) await sendCommentToPost(peer, id, target, comment, prompt);      
          if (reaction) await reactToCommentOfPost(peer, id, target, reaction);
        }      

      }
      await sleep(parseInt(getConfigItem('TELEGRAM_ITERATION_DELAY'), 10) * 1000);
    }  
  } catch (err) {
    console.log(err);
    return;
  }    
}

function stopPosting()
{
  IS_RUNNING = false;
}

module.exports.processGroups = processGroups;
module.exports.stopPosting = stopPosting;