'use strict'
// The call bubble's window (calls.js): the call's state in, its buttons out.
const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('call', {
  on: cb => ipcRenderer.on('call', (_, s) => cb(s)),
  said: cb => ipcRenderer.on('said', (_, t) => cb(t)),
  press: what => ipcRenderer.invoke('call:press', what),
  height: h => ipcRenderer.invoke('call:height', h),
})
