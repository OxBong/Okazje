// Okazje home server: the same checker as the app (web/checker.js), running 24/7 on an always-on Linux PC.
// It is the main checker: it takes over from the Mac/PC and the cloud backup; they only check when it's off.
// Shops that block plain requests are opened in a hidden Chromium (Playwright), like the app's hidden browser.
// Claude verdicts / price search work if Claude Code is installed and logged in on this PC (optional).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as supabase from "@supabase/supabase-js";
import { chromium } from "playwright";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, "..");
const web = path.join(repo, "web");
const data = path.join(os.homedir(), ".okazje");
fs.mkdirSync(data, { recursive: true });
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36";
const { OKAZJE_EMAIL, OKAZJE_PASSWORD } = process.env;
if (!OKAZJE_EMAIL || !OKAZJE_PASSWORD) { console.log("OKAZJE_EMAIL / OKAZJE_PASSWORD missing (see ~/.okazje/env)"); process.exit(1); }
const log = (m) => console.log(new Date().toISOString().slice(0, 19), m);

// ---- hidden browser (one shared Chromium profile so cookies persist) ----
let ctxP = null, queue = Promise.resolve();
function browser() {
  if (!ctxP) ctxP = chromium.launchPersistentContext(path.join(data, "chromium"), {
    headless: true, userAgent: UA, locale: "pl-PL", viewport: { width: 1280, height: 900 },
    extraHTTPHeaders: { "Accept-Language": "pl-PL,pl;q=0.9" }
  }).catch((e) => { ctxP = null; throw e; });
  return ctxP;
}
function fetchRendered(url) {
  const job = queue.then(async () => {
    let page;
    try {
      page = await (await browser()).newPage();
      let status = 200;
      const r = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => null);
      if (r) status = r.status();
      // Wait out "checking your browser" pages until real product data is there (max ~35 s)
      const start = Date.now();
      while (Date.now() - start < 35000) {
        const ready = await page.evaluate(() => {
          const t = document.title || "", h = document.documentElement.innerHTML;
          if (/Cierpliwo|Just a moment|Attention Required|Access Denied|captcha/i.test(t)) return false;
          return /application\/ld\+json|product:price:amount|itemprop="price"/.test(h);
        }).catch(() => false);
        if (ready) { await page.waitForTimeout(1500); if (status === 403) status = 200; break; }
        await page.waitForTimeout(2500);
      }
      return { status, text: await page.content().catch(() => "") };
    } catch (e) { log("hidden browser: " + e.message); return { status: 0, text: "" }; }
    finally { if (page) await page.close().catch(() => {}); }
  });
  queue = job.catch(() => {});
  return job;
}

// ---- optional Claude (Claude Code CLI logged in on this PC) ----
function findClaude() {
  const c = [path.join(os.homedir(), ".local", "bin", "claude"), path.join(os.homedir(), ".claude", "local", "claude"), "/usr/local/bin/claude", "/usr/bin/claude"];
  return c.find((p) => fs.existsSync(p)) || null;
}
function runClaude(args, prompt, ms) {
  const exe = findClaude(); if (!exe) return Promise.resolve("");
  return new Promise((resolve) => {
    let txt = "";
    const p = spawn(exe, args);
    const t = setTimeout(() => { p.kill(); resolve(txt); }, ms);
    p.stdout.on("data", (d) => (txt += d));
    p.on("error", () => { clearTimeout(t); resolve(""); });
    p.on("close", () => { clearTimeout(t); resolve(txt.trim()); });
    p.stdin.end(prompt);
  });
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
async function verdict(hit, criteria) {
  if (!findClaude()) return null;
  const capFile = path.join(data, "claude-count.json"), today = new Date().toISOString().slice(0, 10);
  let cap = { day: today, n: 0 };
  try { const c = JSON.parse(fs.readFileSync(capFile, "utf8")); if (c.day === today) cap = c; } catch {}
  if (cap.n >= 10) return null;
  cap.n++; fs.writeFileSync(capFile, JSON.stringify(cap));
  let prompt = basePrompt(hit, criteria);
  const pdir = path.join(os.tmpdir(), "okazje-photos");
  fs.rmSync(pdir, { recursive: true, force: true }); fs.mkdirSync(pdir, { recursive: true });
  const files = [];
  for (const [i, u] of (hit.photos || []).entries()) {
    try { const r = await fetch(u); if (r.ok) { const f = path.join(pdir, `${i + 1}.jpg`); fs.writeFileSync(f, Buffer.from(await r.arrayBuffer())); files.push(f); } } catch {}
  }
  const args = ["-p", "--model", "haiku"];
  if (files.length) {
    prompt += `Photos of the listing (read every one with the Read tool before answering; check they show the same item as the title and description (model, size, colour; not stock photos) and point out anything that shouldn't be there: damage, scratches, missing parts or charger, wrong item, iCloud/activation lock, battery health or spec screens that don't match): ${files.join(", ")}`;
    args.push("--allowedTools", "Read", "--add-dir", pdir, "--max-turns", "10");
  }
  const out = await runClaude(args, prompt, 240000);
  if (!/^(BUY|MAYBE|SKIP)/.test(out)) { if (out) log("claude: " + out.slice(0, 200)); return null; }
  return out.length > 2500 ? out.slice(0, 2500) + "..." : out;
}
async function priceSearch(items, ctx) {
  if (!findClaude() || !items || !items.length) return null;
  const list = items.map((i, n) => `${n + 1}. id=${i.id} | ${i.name}${i.size ? " | size " + i.size : ""}${i.target ? " | target " + i.target + " zl" : ""}${i.used === "yes" ? " | used OK" : " | new only"}${i.url ? " | tracked link: " + i.url : ""}${i.notes ? " | notes: " + String(i.notes).slice(0, 200) : ""}`).join("\n");
  const prompt = `Find the cheapest CURRENT price for each product below, for a buyer in Gdynia, Poland. Search the web: Polish shops (Zalando, x-kom, Media Expert, RTV Euro AGD, Morele, Allegro (only "Allegro Smart"/business sellers), Notino, Rossmann, Sportano, 50style, Answear, Decathlon, IKEA, Pepper.pl deals, Ceneo) and EU shops that ship to PL. Same exact product (model, colour, size if given). Include valid public promo codes only if shown on the shop page. Skip out-of-stock, marketplace scams and fake discounts. Buyer's sizes: ${(ctx && ctx.sizes) || "unknown"}.
${list}

Reply with ONLY a JSON array, one object per product, no other text:
[{"id":"<id>","price":<number in zl or null>,"shop":"<shop name>","url":"<direct https product link>","note":"<max 120 chars: e.g. -20% until Sunday, size 44 in stock>"}]`;
  const out = await runClaude(["-p", "--model", "sonnet", "--allowedTools", "WebSearch,WebFetch", "--max-turns", "40"], prompt, 900000);
  const m = String(out || "").match(/\[[\s\S]*\]/);
  try { const a = m && JSON.parse(m[0]); return Array.isArray(a) ? a : null; } catch { return null; }
}

// ---- run the app's checker in a sandbox with this bridge ----
const window = {
  supabase,
  okazje: {
    primary: true,
    platform: "server",
    device: async () => "Home server",
    log: async (m) => log(m),
    notify: async () => {},
    onWake: () => {},
    verdict,
    priceSearch,
    getPref: async (k) => (k === "priceSearch" ? (process.env.OKAZJE_PRICE_SEARCH || "daily") : null),
    fetchRendered,
    fetchText: async (url, opts = {}) => {
      const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 30000);
      try {
        const r = await fetch(url, { method: opts.method || "GET", body: opts.body, signal: ctrl.signal,
          headers: Object.assign({ "User-Agent": UA, "Accept-Language": "pl-PL,pl;q=0.9" }, opts.headers || {}) });
        return { status: r.status, text: await r.text() };
      } finally { clearTimeout(t); }
    },
    fetchBytes: async (url) => { const r = await fetch(url, { headers: { "User-Agent": UA } }); return r.ok ? new Uint8Array(await r.arrayBuffer()) : null; }
  }
};
const ctx = vm.createContext(Object.assign(window, { window, console, Promise, Date, Math, JSON, Blob, URL, fetch,
  setTimeout, setInterval, clearTimeout, clearInterval }));
for (const f of ["config.js", "db.js", "checker.js"]) vm.runInContext(fs.readFileSync(path.join(web, f), "utf8"), ctx, { filename: f });
// checker.js starts itself (first run after 8 s, then every 15 min) once we're logged in
await window.DB.login(OKAZJE_EMAIL, OKAZJE_PASSWORD);
log("Okazje home server started" + (findClaude() ? " (Claude verdicts on)" : " (no Claude: hits without verdicts)"));
window.Checker.runOnce(false).then((r) => log("first check: " + r));

// ---- self-update: pull the repo every 6 h; if it changed, exit so systemd restarts the new version ----
setInterval(() => {
  try {
    const before = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"]).toString().trim();
    execFileSync("git", ["-C", repo, "pull", "--ff-only", "-q"], { timeout: 120000 });
    const after = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"]).toString().trim();
    if (before !== after) {
      log("updated to " + after.slice(0, 7) + ", restarting");
      execFileSync("npm", ["install", "--omit=dev", "--no-audit", "--no-fund"], { cwd: here, timeout: 600000 });
      process.exit(0);
    }
  } catch (e) { log("update check failed: " + e.message); }
}, 6 * 3600e3);
