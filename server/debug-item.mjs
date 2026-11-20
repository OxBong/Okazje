// Debug helper: opens one wishlist item in the hidden browser and prints where the price could be.
// Usage on the server: node server/debug-item.mjs "puma"   (part of the item name)
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
const env = Object.fromEntries(fs.readFileSync(path.join(os.homedir(), ".okazje/env"), "utf8").split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const cfg = fs.readFileSync(new URL("../web/config.js", import.meta.url), "utf8");
const sb = createClient(cfg.match(/supabaseUrl:\s*"([^"]+)"/)[1], cfg.match(/supabaseAnonKey:\s*"([^"]+)"/)[1]);
await sb.auth.signInWithPassword({ email: env.OKAZJE_EMAIL, password: env.OKAZJE_PASSWORD });
const q = (process.argv[2] || "").toLowerCase();
const { data } = await sb.from("items").select("id,data");
const it = data.map((x) => x.data).find((d) => (d.name || "").toLowerCase().includes(q));
if (!it) { console.log("No item matches", q); process.exit(1); }
console.log("ITEM:", it.name, "\nURL:", it.url);
const ctx = await chromium.launchPersistentContext(path.join(os.homedir(), ".okazje/chromium-debug"), { headless: true, locale: "pl-PL", viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
const r = await page.goto(it.url, { waitUntil: "domcontentloaded", timeout: 45000 }).catch((e) => (console.log("goto:", e.message), null));
console.log("STATUS:", r && r.status());
await page.waitForTimeout(12000);
console.log("TITLE:", await page.title());
const html = await page.content();
console.log("HTML length:", html.length, "| ld+json blocks:", (html.match(/application\/ld\+json/g) || []).length);
const show = (label, re) => { const m = html.match(re); console.log(label, m ? m.slice(0, 4).map((s) => s.slice(0, 160)) : "none"); };
show("META price:", /<meta[^>]+price[^>]*>/gi);
show("itemprop price:", /itemprop="price"[^>]{0,120}/gi);
show("JSON price:", /"(?:price|salePrice|sale_price|amount|value)"\s*:\s*"?[0-9]+(?:[.,][0-9]+)?/gi);
show("zł in text:", /[0-9]{2,4}(?:[.,][0-9]{2})?\s*(?:zł|PLN)/gi);
const vis = await page.evaluate(() => [...document.querySelectorAll('[data-test-id*="price" i], [class*="price" i]')].slice(0, 6).map((e) => e.outerHTML.slice(0, 200))).catch(() => []);
console.log("PRICE ELEMENTS:", vis);
await ctx.close(); process.exit(0);
