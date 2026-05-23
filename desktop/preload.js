const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("voiceAssistantDesktop", {
  platform: process.platform,
  invoke: (channel, payload) => ipcRenderer.invoke(channel, payload)
});
