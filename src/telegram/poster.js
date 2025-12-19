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

async function sendMessage(groupid, message, prompt, target) {
  try {
    const { peer } = await ensureMembership(groupid);

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

async function reactToMessage(groupid, reaction, target) {
  try {
    const { peer } = await ensureMembership(groupid);
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

async function findDiscussionMessageId(linkedChatPeer, channelPeer, channelPostId, msgId) {
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

async function sendCommentToPost(channelGroupId, target, comment) {
  try {
    const { peer: channelPeer } = await ensureMembership(channelGroupId);
    
    let channelPostId;
    if (target === '$') {
      channelPostId = await getLastChannelPost(channelPeer);
      console.log(`🔍 Last post ID: ${channelPostId}`);
    } else if (target === '*') {
      channelPostId = await getRandomChannelPost(channelPeer);
      console.log(`🔍 Random post ID: ${channelPostId}`);
    }

    // Ensure membership in linked chat
    const linkedChat = await getLinkedChatPeer(channelPeer);
    if (linkedChat.peer.username) {
      await ensureMembership(`@${linkedChat.peer.username}`);
    } else if (linkedChat.peer.id && linkedChat.access_hash) {
      await ensureMembership(`${linkedChat.peer.id}:${linkedChat.access_hash}`);
    } else {
      const fullLinkedChat = await mtprotoCall('channels.getFullChannel', {
        channel: { 
          _: 'inputChannel', 
          channel_id: linkedChat.peer.id, 
          access_hash: linkedChat.peer.access_hash 
        }
      });
      const inviteLink = fullLinkedChat.full_chat?.exported_invite?.link;
      if (!inviteLink) throw new Error('No invite link for linked chat');
      const inviteHash = extractInviteHash(inviteLink);
      if (!inviteHash) throw new Error('Failed to extract invite hash');
      await ensureMembership(inviteHash);
    }

    const discussionMsgId = await findDiscussionMessageId(linkedChat.peer, channelPeer, channelPostId);
    await mtprotoCall('messages.sendMessage', {
      peer: { 
        _: 'inputPeerChannel', 
        channel_id: linkedChat.peer.id, 
        access_hash: linkedChat.peer.access_hash 
      },
      message: comment,
      reply_to: {
        _: 'inputReplyToMessage',
        reply_to_msg_id: discussionMsgId,
      },
      random_id: BigInt(Math.floor(Math.random() * 1e18)).toString(),
    });    
  } catch (error) {
    console.error(`❌ Ultimate error:`, error);
  }
}

async function reactToComment(channelGroupId, target, reaction) {
  try {
    const { peer: channelPeer } = await ensureMembership(channelGroupId);
    const linkedChat = await getLinkedChatPeer(channelPeer);

    // Ensure membership in linked chat
    if (linkedChat.peer.username) {
      await ensureMembership(`@${linkedChat.peer.username}`);
    } else if (linkedChat.peer.id && linkedChat.access_hash) {
      await ensureMembership(`${linkedChat.peer.id}:${linkedChat.access_hash}`);
    } else {
      const fullLinkedChat = await mtprotoCall('channels.getFullChannel', {
        channel: { 
          _: 'inputChannel', 
          channel_id: linkedChat.peer.id, 
          access_hash: linkedChat.peer.access_hash 
        }
      });
      const inviteLink = fullLinkedChat.full_chat?.exported_invite?.link;
      if (!inviteLink) throw new Error('No invite link for linked chat');
      const inviteHash = extractInviteHash(inviteLink);
      if (!inviteHash) throw new Error('Failed to extract invite hash');
      await ensureMembership(inviteHash);
    }

    let actualMsgId ;
    if (target === '$') {
      const history = await mtprotoCall('messages.getHistory', {
        peer: { _: 'inputPeerChannel', channel_id: linkedChat.peer.id, access_hash: linkedChat.peer.access_hash },
        limit: 1,
      });

      const validMessages = (history.messages || []).filter(
        (m) => m?.id && m._ === 'message'
      );

      if (!validMessages.length) {
        throw new Error('No valid messages to reply to.');
      }

      actualMsgId = validMessages[0]?.id;
      if (!actualMsgId) throw new Error('No comments found');
      console.log(`🔍 Last comment ID: ${actualMsgId}`);
    } else if (target === '*') {
      const history = await mtprotoCall('messages.getHistory', {
        peer: { _: 'inputPeerChannel', channel_id: linkedChat.peer.id, access_hash: linkedChat.peer.access_hash },
        limit: 20,
      });

      const validMessages = (history.messages || []).filter(
        (m) => m?.id && m._ === 'message'
      );

      if (!validMessages.length) {
        throw new Error('No valid messages to reply to.');
      }

      actualMsgId = validMessages[getRandomNumber(0, validMessages.length - 1)]?.id;
      if (!actualMsgId) throw new Error('No comments found');
      console.log(`🔍 Last comment ID: ${actualMsgId}`);
    }

    await mtprotoCall('messages.sendReaction', {
      peer: { _: 'inputPeerChannel', channel_id: linkedChat.peer.id, access_hash: linkedChat.peer.access_hash },
      msg_id: actualMsgId,
      reaction: [{ _: 'reactionEmoji', emoticon: reaction }],
      big: false,
    });
    
    console.log(`✅ Reacted to comment ${actualMsgId} in ${channelGroupId}`);
  } catch (error) {
    console.error(`❌ Comment react error ${msgId}:`, error);
  }
}

async function processGroups(requestCode) {
  try { 
    await authenticate(requestCode);
  } catch (err) {
    console.log(err);
    return;
  }  

  IS_RUNNING = true;
  while (IS_RUNNING) {
    const data = readData();
    for (const group of data) {
      const { id, comment, reaction, prompt, target } = group;
      
      if (comment) await sendMessage(id, comment, prompt, target);
      if (reaction) await reactToMessage(id, reaction, target || '*');
      
      /*
        await sendCommentToPost(id, target, comment);      
        await reactToComment(id, target, reaction);
      */              
    }
    await sleep(parseInt(getConfigItem('TELEGRAM_ITERATION_DELAY'), 10) * 1000);
  }  
}

function stopPosting()
{
  IS_RUNNING = false;
}

module.exports.processGroups = processGroups;
module.exports.stopPosting = stopPosting;