const { getConfigItem } = require('../config');
const { readAccounts } = require('../accounts');
const MTProto = require('@mtproto/core');
const { app } = require('electron');
const path = require('node:path');

const config = {
  api_id: getConfigItem('TELEGRAM_API_ID'),
  api_hash: getConfigItem('TELEGRAM_API_HASH'),
};

const clientCache = new Map();
let currentIndex = 0;

function isMultiAccountMode() {
  return Boolean(getConfigItem('MULTI_ACCOUNT_MODE') || null);
}

function getAccountList() {
  if (!isMultiAccountMode()) {
    const phone = getConfigItem('TELEGRAM_PHONE_NUM');
    return phone ? [{ phone }] : [];
  }
  const accounts = readAccounts();
  return accounts.length ? accounts : [{ phone: getConfigItem('TELEGRAM_PHONE_NUM') }].filter((a) => a.phone);
}

function getClient(phone) {
  if (!phone) return null;
  if (clientCache.has(phone)) return clientCache.get(phone);
  const client = new MTProto({
    ...config,
    storageOptions: {
      path: path.join(app.getPath('userData'), `${phone}-session.json`),
    },
  });
  clientCache.set(phone, client);
  return client;
}

function getCurrentClient() {
  const list = getAccountList();
  if (!list.length) return null;
  const idx = currentIndex % list.length;
  return getClient(list[idx].phone);
}

function getCurrentPhone() {
  const list = getAccountList();
  if (!list.length) return getConfigItem('TELEGRAM_PHONE_NUM');
  return list[currentIndex % list.length].phone;
}

function advanceToNextAccount() {
  const list = getAccountList();
  if (list.length <= 1) return;
  currentIndex = (currentIndex + 1) % list.length;
}

function setCurrentIndex(index) {
  const list = getAccountList();
  if (!list.length) {
    currentIndex = 0;
    return;
  }
  const len = list.length;
  currentIndex = ((index % len) + len) % len;
}

module.exports.authenticate = async (requestCode) => {
  const list = getAccountList();
  if (!list.length) {
    throw new Error('No account configured. Add TELEGRAM_PHONE_NUM or enable multi-account and add accounts.');
  }

  const authDelay = parseInt(String(getConfigItem('MULTI_ACCOUNT_AUTH_DELAY') || '0'), 60) || 0;

  for (let i = 0; i < list.length; i++) {
    const { phone } = list[i];
    const client = getClient(phone);
    try {
      await client.call('users.getUsers', {
        id: [{ _: 'inputUserSelf' }],
      });
    } catch (error) {
      if (error.error_message === 'AUTH_KEY_UNREGISTERED') {
        const { phone_code_hash } = await client.call('auth.sendCode', {
          phone_number: phone,
          settings: { _: 'codeSettings' },
        });
        const code = await requestCode(phone);
        await client.call('auth.signIn', {
          phone_number: phone,
          phone_code_hash,
          phone_code: code,
        });
      } else {
        throw error;
      }
    }

    if (authDelay > 0 && i < list.length - 1) {
      await new Promise(resolve => setTimeout(resolve, authDelay * 1000));
    }
  }
};

module.exports.mtproto = null;
module.exports.getCurrentClient = getCurrentClient;
module.exports.getCurrentPhone = getCurrentPhone;
module.exports.advanceToNextAccount = advanceToNextAccount;
module.exports.isMultiAccountMode = isMultiAccountMode;
module.exports.getAccountList = getAccountList;
module.exports.setCurrentIndex = setCurrentIndex;
