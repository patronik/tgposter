const { app } = require('electron');
const path = require('node:path');
const fs = require('fs');

const DATA_FILE = path.join(app.getPath('userData'), 'data.json');
const CONFIG_FILE = path.join(app.getPath('userData'), 'config.json');

function readData() {
  if (!fs.existsSync(DATA_FILE)) return [];
  return JSON.parse(fs.readFileSync(DATA_FILE));
}

function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function readConfig() {
  if (!fs.existsSync(CONFIG_FILE)) return {};
  return JSON.parse(fs.readFileSync(CONFIG_FILE));  
}

function writeConfig(config) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));  
}

function getConfigItem(key) { 
  const config = readConfig();
  return config[key];
};

module.exports.readData = readData;
module.exports.writeData = writeData;
module.exports.readConfig = readConfig;
module.exports.writeConfig = writeConfig;
module.exports.getConfigItem = getConfigItem;
