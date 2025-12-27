const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const { readData, writeData, readConfig, writeConfig, getConfigItem, getReqKeys } = require('./config');
const { processGroups, getIsRunning, setIsRunning, getMessagesSent } = require('./telegram/poster');
const fs = require('fs');
const path = require('node:path');

let TASK_COUNT = 0;

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

ipcMain.handle('open-devtools', () => {
  if (mainWindow) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
});

ipcMain.handle('get-messages-sent', () => {
  return getMessagesSent();
});

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

ipcMain.handle('get-required-keys', () => {
  return getReqKeys();
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
  if (TASK_COUNT > 0) {    
    console.log(`already running`);
    return;
  }
  TASK_COUNT++;      
  const task = processGroups(requestCode);
  task.then(() => TASK_COUNT--);
  console.log(`started`);
});

ipcMain.handle('stop', (_) => {
  setIsRunning(false);  
  console.log(`stopped`);
});

ipcMain.handle('get-is-running', () => {
  return getIsRunning();
});

ipcMain.handle('request-restart', async (_, reason) => {
  await requestRestart(reason);
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

ipcMain.handle('export-data', async () => {
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: 'Export data',
    defaultPath: 'data.json',
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });

  if (canceled || !filePath) return;

  const data = readData();
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
});

ipcMain.handle('import-data', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: 'Import data',
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile']
  });

  if (canceled || !filePaths.length) return false;

  const raw = fs.readFileSync(filePaths[0], 'utf8');
  const parsed = JSON.parse(raw);

  if (!Array.isArray(parsed)) {
    throw new Error('Невірний формат JSON');
  }

  // опціональна валідація
  parsed.forEach(i => {
    if (!i.id) {
      throw new Error('Некоректний запис у JSON');
    }
  });

  writeData(parsed);
  return true;
});

async function requestRestart(
  reason = 'Ваша сесія змінилась, потрібен перезапуск програми!'
) {
  await dialog.showMessageBox({
    type: 'warning',
    title: 'Системне повідомлення',
    message: '',
    detail: `${reason}`,
    buttons: ['OK'],
    defaultId: 0
  });
  app.quit();
}