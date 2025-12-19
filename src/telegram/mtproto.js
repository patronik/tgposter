const { getConfigItem } = require('../config');
const MTProto = require('@mtproto/core');
const { app } = require('electron');
const path = require('node:path');

const config = {
  api_id: getConfigItem('TELEGRAM_API_ID'), 
  api_hash: getConfigItem('TELEGRAM_API_HASH'),
};

const mtproto = new MTProto({
  ...config,
  storageOptions: {
    path: path.join(app.getPath('userData'), 
    `${getConfigItem('TELEGRAM_PHONE_NUM')}-session.json`)
  }
});

module.exports.authenticate = async (requestCode) => {
  try {
    await mtproto.call('users.getUsers', {
      id: [{ _: 'inputUserSelf' }]
    });
  } catch (error) {
    if (error.error_message === 'AUTH_KEY_UNREGISTERED') {
      const { phone_code_hash } = await mtproto.call('auth.sendCode', {
        phone_number: getConfigItem('TELEGRAM_PHONE_NUM'),
        settings: { _: 'codeSettings' }
      });
      const code = await requestCode();
      await mtproto.call('auth.signIn', {
        phone_number: getConfigItem('TELEGRAM_PHONE_NUM'),
        phone_code_hash,
        phone_code: code
      });    
    }
  }
}

module.exports.mtproto = mtproto;