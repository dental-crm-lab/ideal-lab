const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  saveServerUrl: (url) => ipcRenderer.invoke('save-server-url', url),
  getServerUrl: () => ipcRenderer.invoke('get-server-url')
});
