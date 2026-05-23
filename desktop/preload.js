const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("voiceAssistantDesktop", {
  platform: process.platform,
  invoke: (channel, payload) => ipcRenderer.invoke(channel, payload),
  startRecording: () => ipcRenderer.invoke("desktop-recorder:start"),
  stopRecording: () => ipcRenderer.invoke("desktop-recorder:stop"),
  onRecorderEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("desktop-recorder:event", listener);
    return () => ipcRenderer.removeListener("desktop-recorder:event", listener);
  }
});
