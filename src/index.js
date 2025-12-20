const { app, BrowserWindow, ipcMain } = require('electron');
const { readData, writeData, readConfig, writeConfig, getConfigItem } = require('./config');
const { processGroups, getIsRunning, setIsRunning } = require('./telegram/poster');
const path = require('node:path');

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (require('electron-squirrel-startup')) {
  app.quit();
}

let mainWindow;
let codeResolver;

const createWindow = async () => {
  // Create the browser window.
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  // and load the index.html of the app.
  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  // Open the DevTools.
  // mainWindow.webContents.openDevTools();  
};

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  createWindow();

  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and import them here.

function externalLogger(data) {
  mainWindow.webContents.send('log', data);
}

ipcMain.handle('get-items', () => {
  return readData();
});

ipcMain.handle('get-item', (_, id) => {
  const result = readData().filter(i => i.id == id);
  return result[0];
});

ipcMain.handle('add-item', (_, item) => {
  const data = readData();
  data.push(item);
  writeData(data);
  return data;
});

ipcMain.handle('update-item', (_, updated) => {
  let data = readData();
  data = data.map(i => (i.id === updated.id ? updated : i));
  writeData(data);
  return data;
});

ipcMain.handle('delete-item', (_, id) => {
  const data = readData().filter(i => i.id !== id);
  writeData(data);
  return data;
});

ipcMain.handle('get-config', () => {
  return readConfig();
});

ipcMain.handle('get-config-item', (_, key) => {
  return getConfigItem(key);
});

ipcMain.handle('set-config', (_, config) => {
  writeConfig(config);
  return config;
});

ipcMain.handle('start', (_) => {
  setIsRunning(true);  
  externalLogger(`started`);
  processGroups(requestCode, externalLogger);  
});

ipcMain.handle('stop', (_) => {
  setIsRunning(false);  
  externalLogger(`stopped`);
});

ipcMain.handle('get-is-running', () => {
  return getIsRunning();
});

/**
 * Ask renderer for password and wait for it
 */
function requestCode() {
  return new Promise((resolve, reject) => {
    codeResolver = resolve;
    mainWindow.webContents.send('request-code');
  });
}

// Renderer responds here
ipcMain.handle('submit-code', (_, code) => {
  if (!code) {
    throw new Error('Invalid code');
  }

  if (codeResolver) {
    codeResolver(code);
    codeResolver = null;
  }
});