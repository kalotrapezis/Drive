const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('drive', {
  info: () => ipcRenderer.invoke('library:info'),
  list: () => ipcRenderer.invoke('library:list'),
  scan: () => ipcRenderer.invoke('library:scan'),
  show: id => ipcRenderer.invoke('library:show', id),
  favorite: (shas, on) => ipcRenderer.invoke('photos:favorite', shas, on),
  trash: ids => ipcRenderer.invoke('photos:trash', ids),
  collections: () => ipcRenderer.invoke('collections:list'),
  createCollection: name => ipcRenderer.invoke('collections:create', name),
  deleteCollection: id => ipcRenderer.invoke('collections:delete', id),
  members: id => ipcRenderer.invoke('collections:members', id),
  setMembership: (id, shas, member) => ipcRenderer.invoke('collections:set', id, shas, member),
  onScanProgress: fn => {
    const listener = (_, p) => fn(p)
    ipcRenderer.on('scan-progress', listener)
    return () => ipcRenderer.off('scan-progress', listener)
  },
})
