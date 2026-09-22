const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('drive', {
  info: () => ipcRenderer.invoke('library:info'),
  list: () => ipcRenderer.invoke('library:list'),
  scan: () => ipcRenderer.invoke('library:scan'),
  show: id => ipcRenderer.invoke('library:show', id),
  openMap: (lat, lon) => ipcRenderer.invoke('open-map', lat, lon),
  favorite: (shas, on) => ipcRenderer.invoke('photos:favorite', shas, on),
  trash: ids => ipcRenderer.invoke('photos:trash', ids),
  collections: () => ipcRenderer.invoke('collections:list'),
  createCollection: name => ipcRenderer.invoke('collections:create', name),
  deleteCollection: id => ipcRenderer.invoke('collections:delete', id),
  members: id => ipcRenderer.invoke('collections:members', id),
  setMembership: (id, shas, member) => ipcRenderer.invoke('collections:set', id, shas, member),
  files: {
    root: () => ipcRenderer.invoke('files:root'),
    call: (method, ...args) => ipcRenderer.invoke('files:call', method, ...args),
    open: rel => ipcRenderer.invoke('files:open', rel),
    reveal: rel => ipcRenderer.invoke('files:reveal', rel),
  },
  vault: {
    status: () => ipcRenderer.invoke('vault:status'),
    setup: pass => ipcRenderer.invoke('vault:setup', pass),
    unlock: pass => ipcRenderer.invoke('vault:unlock', pass),
    lock: () => ipcRenderer.invoke('vault:lock'),
    list: () => ipcRenderer.invoke('vault:list'),
    hide: ids => ipcRenderer.invoke('vault:hide', ids),
    restore: ids => ipcRenderer.invoke('vault:restore', ids),
  },
  people: {
    status: () => ipcRenderer.invoke('people:status'),
    start: () => ipcRenderer.invoke('people:start'),
    pause: () => ipcRenderer.invoke('people:pause'),
    list: () => ipcRenderer.invoke('people:list'),
    shas: id => ipcRenderer.invoke('people:shas', id),
    names: () => ipcRenderer.invoke('people:names'),
    rename: (id, name) => ipcRenderer.invoke('people:rename', id, name),
    merge: (source, target) => ipcRenderer.invoke('people:merge', source, target),
    undoMerge: undo => ipcRenderer.invoke('people:undoMerge', undo),
    nextReview: () => ipcRenderer.invoke('people:nextReview'),
    answer: (faceId, personId, answer) => ipcRenderer.invoke('people:answer', faceId, personId, answer),
    onProgress: fn => { const l = (_, p) => fn(p); ipcRenderer.on('people-progress', l); return () => ipcRenderer.off('people-progress', l) },
  },
  onScanProgress: fn => {
    const listener = (_, p) => fn(p)
    ipcRenderer.on('scan-progress', listener)
    return () => ipcRenderer.off('scan-progress', listener)
  },
})
