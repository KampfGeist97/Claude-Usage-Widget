'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('claudeWidget', {
  getStatus: () => ipcRenderer.invoke('session:status'),
  login: () => ipcRenderer.invoke('session:login'),
  logout: () => ipcRenderer.invoke('session:logout'),
  getUsage: () => ipcRenderer.invoke('usage:get'),
  refreshUsage: () => ipcRenderer.invoke('usage:refresh'),
  hide: () => ipcRenderer.invoke('window:hide'),
  quit: () => ipcRenderer.invoke('app:quit'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: patch => ipcRenderer.invoke('settings:update', patch),
  getAutostart: () => ipcRenderer.invoke('autostart:get'),
  setAutostart: enabled => ipcRenderer.invoke('autostart:set', Boolean(enabled)),
  openSessionDataFolder: () => ipcRenderer.invoke('session:open-data-folder'),
  onUsageUpdated: callback => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('usage:updated', listener);
    return () => ipcRenderer.removeListener('usage:updated', listener);
  },
  onSessionChanged: callback => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('session:changed', listener);
    return () => ipcRenderer.removeListener('session:changed', listener);
  }
});
