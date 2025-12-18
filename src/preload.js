const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getItems: () => ipcRenderer.invoke('get-items'),
  getItem: (id) => ipcRenderer.invoke('get-item', id),
  addItem: (item) => ipcRenderer.invoke('add-item', item),
  updateItem: (item) => ipcRenderer.invoke('update-item', item),
  deleteItem: (id) => ipcRenderer.invoke('delete-item', id)
});
