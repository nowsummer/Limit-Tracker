'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('limitTracker', {
  getState: () => ipcRenderer.invoke('state:get'),
  refresh: () => ipcRenderer.invoke('usage:refresh'),
  setSettings: patch => ipcRenderer.invoke('settings:set', patch),
  windowAction: action => ipcRenderer.invoke('window:action', action),
  openExternal: (action, accountId) => ipcRenderer.invoke('external:open', action, accountId),
  saveAccount: account => ipcRenderer.invoke('account:save', account),
  removeAccount: id => ipcRenderer.invoke('account:remove', id),
  reorderAccounts: ids => ipcRenderer.invoke('account:reorder', ids),
  testNotification: () => ipcRenderer.invoke('notification:test'),
  copyMobileUrl: () => ipcRenderer.invoke('mobile:copy'),
  checkUpdates: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  reportPopupSize: height => ipcRenderer.invoke('popup:size', height),
  reportMainSize: height => ipcRenderer.invoke('main:size', height),
  onState: callback => { const listener = (_event, state) => callback(state); ipcRenderer.on('state:changed', listener); return () => ipcRenderer.removeListener('state:changed', listener); }
});
