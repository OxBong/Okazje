// Small, safe bridge between the page and the computer (used only by web/checker.js).
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("okazje", {
  platform: process.platform,
  fetchText: (url, opts) => ipcRenderer.invoke("fetchText", url, opts),
  verdict: (hit, criteria) => ipcRenderer.invoke("verdict", hit, criteria),
  notify: (title, body) => ipcRenderer.invoke("notify", title, body),
  device: () => ipcRenderer.invoke("device"),
  log: (msg) => ipcRenderer.invoke("log", msg),
  onWake: (cb) => ipcRenderer.on("wake", () => cb())
});
