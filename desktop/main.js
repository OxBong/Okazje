// Okazje desktop app (Mac + Windows). Shows the wishlist window, lives in the tray / menu bar,
// starts at login and runs the 15-minute checker in the background.
const { app, BrowserWindow, Tray, Menu, ipcMain, shell, Notification, powerMonitor, net, nativeImage } = require("electron");
const path = require("path"), fs = require("fs"), os = require("os"), { spawn } = require("child_process");

const WEB_URL = "https://oxbong.github.io/Okazje/";
const UA = process.platform === "darwin"
  ? "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"
  : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
let win = null, tray = null, quitting = false;
const wakeListeners = [];

if (!app.requestSingleInstanceLock()) { app.quit(); }
app.on("second-instance", () => show());

const dataDir = () => app.getPath("userData");
function log(msg) {
  try { fs.appendFileSync(path.join(dataDir(), "log.txt"), `${new Date().toISOString().slice(0, 16).replace("T", " ")} ${msg}\n`); } catch {}
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180, height: 820, minWidth: 380, minHeight: 500, show: false, backgroundColor: "#000000",
    title: "Okazje", icon: path.join(__dirname, "build", "icon.png"),
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  });
  win.loadFile(path.join(__dirname, "web", "index.html"));
  // Links open in the normal browser
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: "deny" }; });
  win.webContents.on("will-navigate", (e, url) => { if (!url.startsWith("file:")) { e.preventDefault(); shell.openExternal(url); } });
  // Closing the window keeps the checker running in the tray
  win.on("close", (e) => { if (!quitting) { e.preventDefault(); win.hide(); if (process.platform === "darwin") app.dock.hide(); } });
  win.once("ready-to-show", () => { if (!app.getLoginItemSettings().wasOpenedAsHidden && !process.argv.includes("--hidden")) show(); });
}
function show() {
  if (!win) return;
  if (process.platform === "darwin") app.dock.show();
  win.show(); win.focus();
}

function createTray() {
  const icon = process.platform === "darwin"
    ? nativeImage.createFromPath(path.join(__dirname, "assets", "trayTemplate.png"))
    : nativeImage.createFromPath(path.join(__dirname, "assets", "tray-win.png"));
  if (process.platform === "darwin") icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip("Okazje price checker");
  const menu = () => Menu.buildFromTemplate([
    { label: "Open Okazje", click: show },
    { label: "Check now", click: () => win && win.webContents.executeJavaScript("window.Checker && Checker.runOnce(true)") },
    { label: "Open website (for phone)", click: () => shell.openExternal(WEB_URL) },
    { type: "separator" },
    { label: "Start at login", type: "checkbox", checked: app.getLoginItemSettings().openAtLogin,
      click: (m) => setLogin(m.checked) },
    { label: "Show log", click: () => shell.openPath(path.join(dataDir(), "log.txt")) },
    { type: "separator" },
    { label: "Quit Okazje (stops checking)", click: () => { quitting = true; app.quit(); } }
  ]);
  tray.setContextMenu(menu());
  tray.on("click", () => { if (process.platform !== "darwin") show(); });
}
function setLogin(on) {
  app.setLoginItemSettings({ openAtLogin: on, openAsHidden: true, args: ["--hidden"] });
}

// ---- Bridge for the checker (web/checker.js) ----
ipcMain.handle("fetchText", async (_e, url, opts = {}) => {
  const headers = Object.assign({ "User-Agent": UA, "Accept-Language": "pl-PL,pl;q=0.9" }, opts.headers || {});
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 30000);
  try {
    const r = await net.fetch(url, { method: opts.method || "GET", headers, body: opts.body, signal: ctrl.signal });
    return { status: r.status, text: await r.text() };
  } finally { clearTimeout(t); }
});
ipcMain.handle("device", () => {
  const kind = process.platform === "darwin" ? "Mac" : process.platform === "win32" ? "PC" : "Linux";
  return `${kind} (${os.hostname().replace(/\.local$/, "")})`;
});
ipcMain.handle("log", (_e, msg) => log(msg));
ipcMain.handle("notify", (_e, title, body) => {
  if (Notification.isSupported()) { const n = new Notification({ title, body, silent: false }); n.on("click", show); n.show(); }
});
ipcMain.handle("verdict", (_e, hit, criteria) => verdict(hit, criteria));
ipcMain.handle("show", () => show());

// ---- Claude verdict: the only part that uses Claude. Max 10 a day, only on new hits. ----
function findClaude() {
  const h = os.homedir();
  const c = process.platform === "win32"
    ? [path.join(h, ".local", "bin", "claude.exe"), path.join(process.env.APPDATA || "", "npm", "claude.cmd")]
    : [path.join(h, ".local", "bin", "claude"), path.join(h, ".claude", "local", "claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude"];
  return c.find((p) => p && fs.existsSync(p)) || null;
}
async function verdict(hit, criteria) {
  const exe = findClaude();
  if (!exe) return null;
  const capFile = path.join(dataDir(), "claude-count.json"), today = new Date().toISOString().slice(0, 10);
  let cap = { day: today, n: 0 };
  try { const c = JSON.parse(fs.readFileSync(capFile, "utf8")); if (c.day === today) cap = c; } catch {}
  if (cap.n >= 10) return null;
  cap.n++; fs.writeFileSync(capFile, JSON.stringify(cap));

  let prompt = `You judge a deal for a student in Poland. Reply in max 3 short sentences, English, no markdown. Start with BUY, MAYBE or SKIP, then why, and a fair offer price in zl if it's a used listing. Flag scam signs. Don't claim a defect you can't clearly see; say "looks like" when unsure.
Buyer wants: ${criteria}
Listing: ${hit.name}
Price: ${hit.price} zl${hit.city ? " in " + hit.city : ""}
Description: ${hit.fullDesc || hit.desc || ""}
Link: ${hit.url}
`;
  const pdir = path.join(os.tmpdir(), "okazje-photos");
  fs.rmSync(pdir, { recursive: true, force: true }); fs.mkdirSync(pdir, { recursive: true });
  const files = [];
  for (const [i, u] of (hit.photos || []).entries()) {
    try { const r = await net.fetch(u); if (r.ok) { const f = path.join(pdir, `${i + 1}.jpg`); fs.writeFileSync(f, Buffer.from(await r.arrayBuffer())); files.push(f); } } catch {}
  }
  const args = ["-p", "--model", "haiku"];
  if (files.length) {
    prompt += `Photos of the listing (read every one with the Read tool before answering; look for battery health, specs screens, damage, charger, serial/iCloud hints): ${files.join(", ")}`;
    args.push("--allowedTools", "Read", "--add-dir", pdir, "--max-turns", "10");
  }
  const out = await new Promise((resolve) => {
    let txt = "";
    const p = spawn(exe, args, { shell: exe.endsWith(".cmd"), windowsHide: true });
    const t = setTimeout(() => { p.kill(); resolve(""); }, 240000);
    p.stdout.on("data", (d) => (txt += d));
    p.on("error", () => { clearTimeout(t); resolve(""); });
    p.on("close", () => { clearTimeout(t); resolve(txt.trim()); });
    p.stdin.end(prompt);
  });
  if (!/^(BUY|MAYBE|SKIP)/.test(out)) { if (out) log("claude error: " + out.slice(0, 300)); return null; }
  return out.length > 300 ? out.slice(0, 300) + "..." : out;
}

app.whenReady().then(() => {
  if (process.platform === "darwin" && app.dock) app.dock.setIcon(path.join(__dirname, "build", "icon.png"));
  // First launch: start at login (can be turned off in the tray menu)
  const flag = path.join(dataDir(), "first-run-done");
  if (!fs.existsSync(flag)) { setLogin(true); fs.writeFileSync(flag, "1"); }
  createWindow(); createTray();
  const wake = () => win && win.webContents.send("wake");
  powerMonitor.on("resume", wake); powerMonitor.on("unlock-screen", wake);
});
app.on("activate", show);
app.on("before-quit", () => { quitting = true; });
app.on("window-all-closed", (e) => e.preventDefault());
