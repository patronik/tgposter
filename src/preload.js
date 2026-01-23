const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // data
  getItems: () => ipcRenderer.invoke('get-items'),
  getItem: (id) => ipcRenderer.invoke('get-item', id),
  addItem: (item) => ipcRenderer.invoke('add-item', item),
  updateItem: (item) => ipcRenderer.invoke('update-item', item),
  deleteItem: (id) => ipcRenderer.invoke('delete-item', id),
   // config
  getConfig: () => ipcRenderer.invoke('get-config'),  
  getRequiredKeys: () => ipcRenderer.invoke('get-required-keys'),  
  getConfigItem: (key) => ipcRenderer.invoke('get-config-item', key),
  setConfig: (config) => ipcRenderer.invoke('set-config', config),
  // auth
  onCodeRequest: (callback) => ipcRenderer.on('request-code', callback),
  submitCode: (code) => ipcRenderer.invoke('submit-code', code),
  logout: () => ipcRenderer.invoke('logout'),
  // control
  start: () => ipcRenderer.invoke('start'),
  stop: () => ipcRenderer.invoke('stop'),   
  exportData: () => ipcRenderer.invoke('export-data'),
  importData: () => ipcRenderer.invoke('import-data'),
  getIsRunning: () => ipcRenderer.invoke('get-is-running'),
  requestRestart: (reason) => ipcRenderer.invoke('request-restart', reason),
  // info
  getTotalSent: () => ipcRenderer.invoke('get-total-sent')
});
