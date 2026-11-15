// Small, safe bridge between the page and the computer (used only by web/checker.js).
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("okazje", {
  platform: process.platform,
  fetchText: (url, opts) => ipcRenderer.invoke("fetchText", url, opts),
  fetchBytes: (url) => ipcRenderer.invoke("fetchBytes", url),
  verdict: (hit, criteria) => ipcRenderer.invoke("verdict", hit, criteria),
  notify: (title, body) => ipcRenderer.invoke("notify", title, body),
  device: () => ipcRenderer.invoke("device"),
  log: (msg) => ipcRenderer.invoke("log", msg),
  appInfo: () => ipcRenderer.invoke("appInfo"),
  setPref: (k, v) => ipcRenderer.invoke("setPref", k, v),
  setApiKey: (k) => ipcRenderer.invoke("setApiKey", k),
  checkUpdate: () => ipcRenderer.invoke("checkUpdate"),
  claudeTest: () => ipcRenderer.invoke("claudeTest"),
  claudeInstall: () => ipcRenderer.invoke("claudeInstall"),
  claudeLogin: () => ipcRenderer.invoke("claudeLogin"),
  chat: (messages, ctx) => ipcRenderer.invoke("chat", messages, ctx),
  onWake: (cb) => ipcRenderer.on("wake", () => cb())
});
