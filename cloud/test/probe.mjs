import { chromium } from "playwright";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const b = await chromium.launch(); const ctx = await b.newContext({ userAgent: UA, locale: "pl-PL" });
for (const u of process.argv.slice(2)) {
  const p = await ctx.newPage(); await p.goto(u, { timeout: 45000 }); await p.waitForTimeout(4000); const h = await p.content();
  const rows = [...h.matchAll(/<div[^>]*class="[^"]*cat-prod-row[^"]*"[^>]*>/g)].slice(0, 4).map((m) => m[0].slice(0, 600));
  console.log("\n## " + u + "\nrows:", rows.length ? rows.join("\n---\n") : "none");
  const attrs = [...new Set([...h.matchAll(/data-[a-z-]*price[a-z-]*/g)].map((m) => m[0]))];
  console.log("price attrs:", attrs.join(", "));
  await p.close();
}
await b.close();
