import { chromium } from "playwright";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const urls = process.argv.slice(2);
function getPrice(html) {
  const pats = [/property="product:price:amount"\s+content="([0-9]+(?:[.,][0-9]{1,2})?)"/g, /itemprop="price"[^>]*content="([0-9]+(?:[.,][0-9]{1,2})?)"/g, /"price"\s*:\s*"?([0-9]+(?:[.,][0-9]{1,2})?)/g];
  for (const p of pats) { let m; while ((m = p.exec(html))) { const v = parseFloat(m[1].replace(",", ".")); if (v >= 5) return v; } }
  return null;
}
function ld(html) {
  const out = [];
  for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g)) {
    try { const j = JSON.parse(m[1]); const arr = [].concat(j["@graph"] || j); for (const x of arr) { if (/Product/.test(x["@type"])) { const o = [].concat(x.offers || []); out.push({ name: x.name, offers: o.map((y) => y.price || y.lowPrice || (y.priceSpecification && y.priceSpecification.price)) }); } } } catch {}
  }
  return out;
}
const b = await chromium.launch();
const ctx = await b.newContext({ userAgent: UA, locale: "pl-PL" });
for (const u of urls) {
  let plain = "";
  try { const r = await fetch(u, { headers: { "User-Agent": UA, "Accept-Language": "pl-PL" } }); const t = await r.text(); plain = r.status + " price=" + getPrice(t) + " ld=" + JSON.stringify(ld(t)).slice(0, 200); } catch (e) { plain = "ERR " + e.message; }
  let rend = "";
  try { const p = await ctx.newPage(); const r = await p.goto(u, { timeout: 45000 }); await p.waitForTimeout(5000); const h = await p.content(); rend = (r && r.status()) + " title=" + (await p.title()).slice(0, 60) + " price=" + getPrice(h) + " ld=" + JSON.stringify(ld(h)).slice(0, 300); await p.close(); } catch (e) { rend = "ERR " + e.message; }
  console.log("\n## " + u + "\nplain: " + plain + "\nrendered: " + rend);
}
await b.close();
