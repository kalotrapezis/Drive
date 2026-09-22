const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('drive', {
  info: () => ipcRenderer.invoke('library:info'),
  list: () => ipcRenderer.invoke('library:list'),
  scan: () => ipcRenderer.invoke('library:scan'),
  show: id => ipcRenderer.invoke('library:show', id),
  onScanProgress: fn => {
    const listener = (_, p) => fn(p)
    ipcRenderer.on('scan-progress', listener)
    return () => ipcRenderer.off('scan-progress', listener)
  },
})
