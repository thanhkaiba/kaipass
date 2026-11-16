// The only bridge between the page and the desktop app: named calls, and named events back.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('KaiPassDesktop', {
  call: (method, args) => ipcRenderer.invoke('kaipass', method, args),
  on: (event, fn) => {
    const listener = (_e, name) => name === event && fn();
    ipcRenderer.on('kaipass-event', listener);
    return () => ipcRenderer.removeListener('kaipass-event', listener);
  },
});
