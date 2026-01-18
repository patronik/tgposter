require('dotenv').config();
const { app } = require('electron');
const path = require('node:path');
const fs = require('fs');

let REMOTE_CONFIG_DATA = {};

const DATA_FILE = path.join(app.getPath('userData'), 'data.json');
const CONFIG_FILE = path.join(app.getPath('userData'), 'config.json');

function readData() {
  if (!fs.existsSync(DATA_FILE)) return [];
  return JSON.parse(fs.readFileSync(DATA_FILE));
}

function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function getReqKeys() {   
  return [
    'TELEGRAM_API_ID',
    'TELEGRAM_API_HASH',
    'TELEGRAM_PHONE_NUM'
  ];
};

function readConfig() {
  if (!fs.existsSync(CONFIG_FILE)) return {...REMOTE_CONFIG_DATA};
  const LOCAL_CONFIG_DATA = JSON.parse(fs.readFileSync(CONFIG_FILE));  
  return {
    ...LOCAL_CONFIG_DATA,
    ...REMOTE_CONFIG_DATA
  };
}

function writeConfig(config) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));  
}

function getConfigItem(key) { 
  if (REMOTE_CONFIG_DATA[key]) {
    return REMOTE_CONFIG_DATA[key];
  }
  const config = readConfig();
  return config[key];
};

async function loadRemote() {
  try {
    if (!process.env.REMOTE_CONFIG_URL 
        || !process.env.REMOTE_CONFIG_USER
    ) {
      throw new Error("Remote configuration is missing");
    }

    const response = await fetch(process.env.REMOTE_CONFIG_URL);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const content = await response.text();
    if (!content) {
      throw new Error("Config is empty");
    }
           
    let data;
    try {
      data = JSON.parse(
        Buffer.from(content, 'base64').toString('utf8')
      );    
    } catch (e) {
      throw new Error(`Failed to parse config`);
    }

    if (!data) {
      throw new Error("Config is empty");
    }

    if (data[process.env.REMOTE_CONFIG_USER]) {
      REMOTE_CONFIG_DATA = data[process.env.REMOTE_CONFIG_USER];
    }
    
  } catch (error) {
    console.error("Fetching remote config failed:", error);
  }
}

module.exports.readData = readData;
module.exports.writeData = writeData;
module.exports.getReqKeys = getReqKeys;
module.exports.readConfig = readConfig;
module.exports.writeConfig = writeConfig;
module.exports.getConfigItem = getConfigItem;
module.exports.loadRemote = loadRemote;
