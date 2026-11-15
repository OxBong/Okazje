// Okazje desktop app (Mac + Windows). Shows the wishlist window, lives in the tray / menu bar,
// starts at login and runs the 15-minute checker in the background.
const { app, BrowserWindow, Tray, Menu, ipcMain, shell, Notification, powerMonitor, net, nativeImage, safeStorage } = require("electron");
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

// Local app preferences (this computer only). The API key is encrypted with the system keychain.
const prefsFile = () => path.join(dataDir(), "prefs.json");
function prefs() { try { return Object.assign({ autoUpdate: true, claudeMode: "cli" }, JSON.parse(fs.readFileSync(prefsFile(), "utf8"))); } catch { return { autoUpdate: true, claudeMode: "cli" }; } }
function setPref(k, v) { const p = prefs(); p[k] = v; fs.writeFileSync(prefsFile(), JSON.stringify(p)); }
function apiKey() {
  const enc = prefs().apiKey; if (!enc) return null;
  try { return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(Buffer.from(enc, "base64")) : null; } catch { return null; }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180, height: 820, minWidth: 380, minHeight: 500, show: false, backgroundColor: "#000000",
    title: "Okazje", icon: path.join(__dirname, "build", "icon.png"),
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  });
  // The page comes from the website, so page fixes arrive without reinstalling.
  // Offline or website down: fall back to the copy built into the app.
  const local = () => win.loadFile(path.join(__dirname, "web", "index.html"));
  win.webContents.on("did-fail-load", (_e, code, _d, url, isMain) => {
    if (isMain && code !== -3 && url.startsWith("https:")) { log("website failed (" + code + "), using built-in page"); local(); }
  });
  win.loadURL(WEB_URL).catch(() => {});
  // Links open in the normal browser
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: "deny" }; });
  win.webContents.on("will-navigate", (e, url) => { if (!url.startsWith("file:") && !url.startsWith(WEB_URL)) { e.preventDefault(); shell.openExternal(url); } });
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
    { label: `Version: build ${BUILD || "dev"}`, enabled: false },
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
ipcMain.handle("fetchBytes", async (_e, url) => {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 30000);
  try { const r = await net.fetch(url, { headers: { "User-Agent": UA }, signal: ctrl.signal }); if (!r.ok) return null; return new Uint8Array(await r.arrayBuffer()); }
  finally { clearTimeout(t); }
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
  const mode = prefs().claudeMode;
  if (mode === "off") return null;
  if (mode === "api" ? !apiKey() : !findClaude()) return null;
  const capFile = path.join(dataDir(), "claude-count.json"), today = new Date().toISOString().slice(0, 10);
  let cap = { day: today, n: 0 };
  try { const c = JSON.parse(fs.readFileSync(capFile, "utf8")); if (c.day === today) cap = c; } catch {}
  if (cap.n >= 10) return null;
  cap.n++; fs.writeFileSync(capFile, JSON.stringify(cap));

  const out = mode === "api" ? await askApi(hit, criteria) : await askCli(hit, criteria);
  if (!/^(BUY|MAYBE|SKIP)/.test(out)) { if (out) log("claude error: " + out.slice(0, 300)); return null; }
  return out.length > 2500 ? out.slice(0, 2500) + "..." : out;
}
function basePrompt(hit, criteria) {
  return `You judge a deal for a student in Poland. Plain text, English, no markdown except "- " bullets. Flag scam signs. Don't claim a defect you can't clearly see; say "looks like" when unsure.
Answer in exactly this shape:
Line 1: BUY, MAYBE or SKIP, then one short sentence why (max 200 characters).
Blank line, then "Details:" and 3-6 short lines starting with "- ": what each photo shows (say photo numbers; does it match the title: model, size, colour; stock photos; damage, scratches, missing parts, iCloud lock, battery or spec screens), the key facts from the description, and a fair offer price in zl for used listings.
For used listings only: blank line, then "Ask the seller:" and one short message in Polish starting "Dzień dobry," with only the most important question(s) the photos and description don't already answer. No price offer in it.
Buyer wants: ${criteria}
Listing: ${hit.name}
Price: ${hit.price} zl${hit.city ? " in " + hit.city : ""}
Description: ${hit.fullDesc || hit.desc || ""}
Link: ${hit.url}
`;
}
// Claude Code on this computer (uses the Claude subscription it's logged in with)
async function askCli(hit, criteria) {
  const exe = findClaude(); if (!exe) return "";
  let prompt = basePrompt(hit, criteria);
  const pdir = path.join(os.tmpdir(), "okazje-photos");
  fs.rmSync(pdir, { recursive: true, force: true }); fs.mkdirSync(pdir, { recursive: true });
  const files = [];
  for (const [i, u] of (hit.photos || []).entries()) {
    try { const r = await net.fetch(u); if (r.ok) { const f = path.join(pdir, `${i + 1}.jpg`); fs.writeFileSync(f, Buffer.from(await r.arrayBuffer())); files.push(f); } } catch {}
  }
  const args = ["-p", "--model", "haiku"];
  if (files.length) {
    prompt += `Photos of the listing (read every one with the Read tool before answering; check they show the same item as the title and description (model, size, colour; not stock photos) and point out anything that shouldn't be there: damage, scratches, missing parts or charger, wrong item, iCloud/activation lock, battery health or spec screens that don't match): ${files.join(", ")}`;
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
  return out;
}
// Anthropic API key (no Claude Code needed; billed per use on console.anthropic.com)
async function askApi(hit, criteria) {
  const key = apiKey(); if (!key) return "";
  const content = (hit.photos || []).slice(0, 6).map((u) => ({ type: "image", source: { type: "url", url: u } }));
  content.push({ type: "text", text: basePrompt(hit, criteria) + (content.length ? "Photos of the listing are attached; check they show the same item as the title and description (model, size, colour; not stock photos) and point out anything that shouldn't be there: damage, scratches, missing parts or charger, wrong item, iCloud/activation lock, battery health or spec screens that don't match." : "") });
  try {
    const r = await net.fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-haiku-5-5", max_tokens: 900, messages: [{ role: "user", content }] })
    });
    const j = await r.json();
    if (!r.ok) return "API error: " + ((j.error && j.error.message) || r.status);
    return (j.content || []).filter((c) => c.type === "text").map((c) => c.text).join("").trim();
  } catch (e) { return "API error: " + e.message; }
}

// ---- Settings page helpers ----
const TEST_HIT = { name: "Test: Sony DualSense controller, white", price: 199, url: "https://example.com", desc: "New, sealed, from a Polish shop." };
ipcMain.handle("appInfo", () => {
  const p = prefs();
  return { build: BUILD, latest: latestBuild, platform: process.platform, autoUpdate: p.autoUpdate, claudeMode: p.claudeMode,
    hasKey: !!p.apiKey, claudePath: findClaude() };
});
ipcMain.handle("setPref", (_e, k, v) => { if (["autoUpdate", "claudeMode"].includes(k)) setPref(k, v); });
ipcMain.handle("setApiKey", (_e, key) => {
  key = String(key || "").trim();
  if (!key) { setPref("apiKey", null); return true; }
  if (!safeStorage.isEncryptionAvailable()) throw new Error("This computer can't store the key safely");
  setPref("apiKey", safeStorage.encryptString(key).toString("base64")); return true;
});
ipcMain.handle("claudeTest", async () => {
  const mode = prefs().claudeMode;
  if (mode === "off") return "Claude opinions are turned off.";
  if (mode === "api" && !apiKey()) return "No API key saved yet.";
  if (mode === "cli" && !findClaude()) return "Claude Code isn't installed on this computer. Click Install Claude.";
  const out = mode === "api" ? await askApi(TEST_HIT, "white DualSense, target 230 zł") : await askCli(TEST_HIT, "white DualSense, target 230 zł");
  if (/^(BUY|MAYBE|SKIP)/.test(out)) return "Working ✓ " + out.slice(0, 160);
  if (/log ?in|auth|credential|api key/i.test(out)) return "Claude isn't logged in. Click Log in to Claude.";
  return "Not working: " + (out || "no answer").slice(0, 200);
});
ipcMain.handle("claudeInstall", () => new Promise((resolve) => {
  const p = process.platform === "win32"
    ? spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "irm https://claude.ai/install.ps1 | iex"], { windowsHide: true })
    : spawn("/bin/bash", ["-lc", "curl -fsSL https://claude.ai/install.sh | bash"]);
  let out = ""; p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (out += d));
  const t = setTimeout(() => { p.kill(); resolve("Install timed out."); }, 300000);
  p.on("close", (c) => { clearTimeout(t); log("claude install: " + out.slice(-300)); resolve(findClaude() ? "Installed ✓ Now click Log in to Claude." : "Install failed: " + out.slice(-200)); });
  p.on("error", (e) => { clearTimeout(t); resolve("Install failed: " + e.message); });
}));
// Claude's login needs its own window once; this opens it ready to go.
ipcMain.handle("claudeLogin", () => {
  const exe = findClaude(); if (!exe) return "Install Claude first.";
  if (process.platform === "darwin") {
    const cmd = `clear; echo 'Log in to Claude in the browser that opens. When it says you are logged in, close this window.'; "${exe}" /login`;
    spawn("osascript", ["-e", `tell application "Terminal" to do script ${JSON.stringify(cmd)}`, "-e", 'tell application "Terminal" to activate']);
  } else {
    spawn("cmd.exe", ["/c", "start", "Claude login", "cmd", "/k", `echo Log in to Claude in the browser that opens. When done, close this window. && "${exe}" /login`], { windowsHide: false, shell: false });
  }
  return "A small login window opened. Finish there, then click Test.";
});
ipcMain.handle("checkUpdate", () => checkUpdate(true));

// ---- Auto-update: checks GitHub releases on start and every 6 hours, installs a newer build by itself ----
const BUILD = (() => { try { return require("./build-info.json").build; } catch { return 0; } })();
let updating = false, latestBuild = null;
async function checkUpdate(manual) {
  if (!BUILD) return "Development copy, no updates.";
  if (updating) return "Updating…";
  if (!manual && !prefs().autoUpdate) return "";
  try {
    const r = await net.fetch("https://api.github.com/repos/OxBong/okazje/releases/latest", { headers: { "User-Agent": "Okazje" } });
    if (!r.ok) return "Couldn't check (GitHub " + r.status + ").";
    const rel = await r.json(), n = parseInt(String(rel.tag_name).replace("build-", ""), 10);
    latestBuild = n;
    if (!(n > BUILD)) return "You have the newest version (build " + BUILD + ").";
    const ext = process.platform === "darwin" ? ".dmg" : ".exe";
    const asset = (rel.assets || []).find((a) => a.name.endsWith(ext));
    if (!asset) return "Build " + n + " is still being made, try again in a few minutes.";
    updating = true; log(`update: build ${BUILD} -> ${n}`);
    const f = path.join(os.tmpdir(), "okazje-update" + ext);
    const d = await net.fetch(asset.browser_download_url);
    if (!d.ok) throw new Error("download HTTP " + d.status);
    fs.writeFileSync(f, Buffer.from(await d.arrayBuffer()));
    if (process.platform === "darwin") {
      const bundle = path.resolve(process.execPath, "../../..");
      const mnt = path.join(os.tmpdir(), "okazje-mnt");
      const sh = `sleep 2; hdiutil attach -nobrowse -quiet -mountpoint "${mnt}" "${f}" && ` +
        `rm -rf "${bundle}.old" && mv "${bundle}" "${bundle}.old" && ditto "${mnt}/Okazje.app" "${bundle}" && rm -rf "${bundle}.old"; ` +
        `[ -d "${bundle}" ] || mv "${bundle}.old" "${bundle}"; hdiutil detach -quiet "${mnt}"; xattr -cr "${bundle}"; open "${bundle}" --args --hidden`;
      spawn("/bin/bash", ["-c", sh], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn(f, ["/S", "--force-run"], { detached: true, stdio: "ignore" }).unref();
    }
    setTimeout(() => { quitting = true; app.quit(); }, 1500);
    return "Installing build " + n + "… the app will restart.";
  } catch (e) { updating = false; log("update failed: " + e); return "Update failed: " + e.message; }
}

app.whenReady().then(() => {
  if (process.platform === "darwin" && app.dock) app.dock.setIcon(path.join(__dirname, "build", "icon.png"));
  // First launch: start at login (can be turned off in the tray menu)
  const flag = path.join(dataDir(), "first-run-done");
  if (!fs.existsSync(flag)) { setLogin(true); fs.writeFileSync(flag, "1"); }
  createWindow(); createTray();
  const wake = () => win && win.webContents.send("wake");
  powerMonitor.on("resume", wake); powerMonitor.on("unlock-screen", wake);
  setTimeout(() => checkUpdate(false), 30e3); setInterval(() => checkUpdate(false), 6 * 3600e3);
});
app.on("activate", show);
app.on("before-quit", () => { quitting = true; });
app.on("window-all-closed", (e) => e.preventDefault());
