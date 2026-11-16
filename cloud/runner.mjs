// Cloud backup checker (no Claude). Runs on GitHub Actions every ~20 min and only checks
// when no Mac/PC has checked in the last 25 minutes (same "runner" lease as the app).
// It runs the very same web/checker.js + web/db.js as the app, with a small Node bridge.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import * as supabase from "@supabase/supabase-js";

const here = path.dirname(fileURLToPath(import.meta.url));
const web = path.join(here, "..", "web");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const { OKAZJE_EMAIL, OKAZJE_PASSWORD } = process.env;
if (!OKAZJE_EMAIL || !OKAZJE_PASSWORD) { console.log("Secrets OKAZJE_EMAIL / OKAZJE_PASSWORD are not set; nothing to do."); process.exit(0); }

const timers = [];
const window = {
  supabase,
  setTimeout: (f, ms) => { const t = setTimeout(f, ms); timers.push(t); return t; },
  setInterval: (f, ms) => { const t = setInterval(f, ms); timers.push(t); return t; },
  okazje: {
    cloud: true,
    platform: "cloud",
    device: async () => "Cloud (backup)",
    log: async (m) => console.log(m),
    notify: async () => {},
    onWake: () => {},
    verdict: async () => null,                       // no Claude in the cloud
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
  setTimeout: window.setTimeout, setInterval: window.setInterval, clearTimeout, clearInterval }));
for (const f of ["config.js", "db.js", "checker.js"]) vm.runInContext(fs.readFileSync(path.join(web, f), "utf8"), ctx, { filename: f });

const out = await (async () => {
  await window.DB.login(OKAZJE_EMAIL, OKAZJE_PASSWORD);
  return window.Checker.runOnce(false);
})().catch((e) => "error: " + (e.message || e));
console.log("Result:", out);
timers.forEach((t) => { clearTimeout(t); clearInterval(t); });
process.exit(String(out).startsWith("error") ? 1 : 0);
