// Price checker engine. Runs only inside the desktop app (window.okazje = bridge to the computer).
// Every 15 min: claim the "runner" lease (one computer at a time), check shop links + OLX searches,
// store prices/hits in the cloud, push new hits to the phone. Claude only writes the short verdict.
(function () {
  var B = window.okazje;
  if (!B) return;
  var sb = window.DB.sb;
  var running = false, sizesText = "";
  var CLOTHES = /clothes|shoe|sneaker|buty|hoodie|bluza|jeans|spodnie|kurtka|jacket|t-?shirt|koszul|czapk|cap\b|boxer/i;
  function must(r) { if (r.error) throw r.error; return r.data; }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function nowIso() { return new Date().toISOString(); }

  // Price on a product page. Structured data (JSON-LD) first: it holds the real current/sale price,
  // while "product:price:amount" meta tags often still show the old regular price.
  function ldPrice(html) {
    var re = /<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi, m;
    while ((m = re.exec(html))) {
      var j; try { j = JSON.parse(m[1].trim()); } catch (e) { continue; }
      var stack = [].concat(j), seen = 0;
      while (stack.length && seen++ < 200) {
        var x = stack.shift(); if (!x || typeof x !== "object") continue;
        if (Array.isArray(x)) { stack = stack.concat(x); continue; }
        if (x["@graph"]) stack = stack.concat(x["@graph"]);
        var t = [].concat(x["@type"] || []).join(" ");
        if (/Product/.test(t) && x.offers) {
          var vals = [].concat(x.offers).map(function (o) {
            if (!o) return null;
            var v = o.price != null ? o.price : o.lowPrice != null ? o.lowPrice : (o.priceSpecification && [].concat(o.priceSpecification)[0] || {}).price;
            if (o.availability && /OutOfStock|Discontinued/i.test(o.availability)) return null;
            v = parseFloat(String(v).replace(",", ".")); return v >= 5 ? v : null;
          }).filter(function (v) { return v != null; });
          if (vals.length) return Math.min.apply(null, vals);
        }
      }
    }
    return null;
  }
  function getPrice(html) {
    var v = ldPrice(html); if (v) return v;
    var pats = [/property="product:sale_price:amount"\s+content="([0-9]+(?:[.,][0-9]{1,2})?)"/g,
                /property="(?:product|og):price:amount"\s+content="([0-9]+(?:[.,][0-9]{1,2})?)"/g,
                /itemprop="price"[^>]*content="([0-9]+(?:[.,][0-9]{1,2})?)"/g,
                /"price"\s*:\s*"?([0-9]+(?:[.,][0-9]{1,2})?)/g];
    for (var i = 0; i < pats.length; i++) {
      var m; while ((m = pats[i].exec(html))) { var n = parseFloat(m[1].replace(",", ".")); if (n >= 5) return n; }
    }
    return null;
  }
  function blocked(r) {
    return r.status === 403 || r.status === 429 || /<title>\s*(Cierpliwości|Just a moment|Access Denied|Attention Required|Captcha)/i.test(r.text || "");
  }
  var CLOUD_BLOCKED = /mediaexpert\.pl|zalando\.|allegro\.pl/;   // these shops block scripts

  // Stores a hit once (unique key). Returns true only for the device that stored it first.
  function storeHit(key, data) {
    return sb.from("hits").upsert({ user_id: window.DB.uid, key: key, data: data }, { onConflict: "user_id,key", ignoreDuplicates: true })
      .select("id").then(function (r) { must(r); return r.data && r.data.length ? r.data[0].id : null; });
  }
  function push(topic, h) {
    var msg = h.price + " zł" + (h.city ? " - " + h.city : "") + (h.desc ? "\n" + h.desc : "");
    if (h.verdict) msg = "Claude: " + h.verdict + "\n\n" + msg;
    var p = { topic: topic, title: h.name, message: msg, tags: ["moneybag"], priority: 4 };
    if (h.url) { p.click = h.url; p.actions = [{ action: "view", label: "Open listing", url: h.url }]; }
    if (h.image) { p.attach = String(h.image).replace(":443/", "/"); p.filename = "photo.jpg"; }
    return B.fetchText("https://ntfy.sh/", { method: "POST", body: JSON.stringify(p), headers: { "Content-Type": "application/json; charset=utf-8" } });
  }

  // Used listings: keep copies of the photos in the cloud for PHOTO_DAYS (OLX deletes them when the listing ends)
  var PHOTO_DAYS = 14;
  async function savePhotos(id, h) {
    if (!B.fetchBytes || !(h.photos || []).length) return;
    var paths = [];
    for (var i = 0; i < h.photos.length && i < 8; i++) {
      try {
        var bytes = await B.fetchBytes(h.photos[i]); if (!bytes) continue;
        var p = window.DB.uid + "/" + id + "/" + (i + 1) + ".jpg";
        var r = await sb.storage.from("photos").upload(p, new Blob([bytes], { type: "image/jpeg" }), { contentType: "image/jpeg", upsert: true });
        if (r.error) { B.log("photo upload failed: " + r.error.message); break; }
        paths.push(p);
      } catch (e) { B.log("photo failed: " + e); }
    }
    if (paths.length) { h.stored = paths; h.storedUntil = new Date(Date.now() + PHOTO_DAYS * 864e5).toISOString(); }
  }
  async function cleanPhotos() {
    var cutoff = new Date(Date.now() - PHOTO_DAYS * 864e5).toISOString();
    var r = await sb.from("hits").select("id,data").lt("created_at", cutoff).not("data->stored", "is", null).limit(30);
    if (r.error || !r.data) return;
    for (var i = 0; i < r.data.length; i++) {
      var row = r.data[i], d = row.data;
      var rm = await sb.storage.from("photos").remove(d.stored || []);
      if (rm.error) { B.log("photo cleanup failed: " + rm.error.message); return; }
      delete d.stored; delete d.storedUntil;
      await sb.from("hits").update({ data: d }).eq("id", row.id);
    }
  }

  async function newHit(topic, key, h) {
    var id = await storeHit(key, h);
    if (!id) return false;                       // another computer already reported it
    await savePhotos(id, h);
    var crit = h.criteria || (h.name + ", target price " + h.target + " zł, new from a legit Polish shop");
    if (sizesText && (h.clothes || CLOTHES.test(h.name))) crit += ". Buyer's sizes: " + sizesText + ". Say if the listed size likely fits.";
    if (h.target && h.price > h.target) crit += ". This price is " + Math.round(h.price - h.target) + " zł above the target, but the buyer wants every real discount: the target is a wish, not a hard limit. Answer BUY if it is a genuine discount and a good price for this exact product, and say how far above target it is.";
    try { h.verdict = await B.verdict(h, crit); } catch (e) { h.verdict = null; }
    if (h.verdict) {                              // line 1 = short opinion (push), the rest = full analysis (app)
      var parts = String(h.verdict).split(/\n\s*\n/);
      h.verdict = parts[0].trim().slice(0, 300);
      var rest = parts.slice(1).join("\n\n").trim();
      if (rest) h.analysis = rest;
    }
    if (h.verdict && /^SKIP/.test(h.verdict) && /Apple Watch/.test(h.name)) {   // junk watch listings: drop silently
      await sb.from("hits").delete().eq("id", id); return false;
    }
    if (h.verdict || h.stored) await sb.from("hits").update({ data: h }).eq("id", id);
    if (topic && h.verdict && /^BUY/.test(h.verdict)) { try { await push(topic, h); } catch (e) { B.log("push failed: " + e); } }
    B.notify("Okazje: " + h.name, h.price + " zł" + (h.verdict ? " · " + h.verdict.split(".")[0] : ""));
    return true;
  }

  async function checkItems(topic, items, oldStatus, force) {
    var rows = [], n = 0;
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (it.bought || !/^https:\/\//.test(it.url || "") || /olx\.pl|pepper\.pl|\/search|query=/.test(it.url) || (CLOUD_BLOCKED.test(it.url) && !B.fetchRendered) || (B.primary && CLOUD_BLOCKED.test(it.url))) continue;
      var prev = oldStatus[it.id] || {}, fails = prev.fails || 0;
      if (!force && fails >= 3 && prev.checked && Date.now() - new Date(prev.checked) < 6 * 3600e3) continue;
      var e = { name: it.name, url: it.url, target: it.target, price: null, lastPrice: prev.price || prev.lastPrice || null, ok: false, checked: nowIso(), by: curDev };
      if (prev.best) e.best = prev.best;
      try {
        var r = CLOUD_BLOCKED.test(it.url) ? await B.fetchRendered(it.url) : await B.fetchText(it.url);
        if ((r.status >= 400 || !getPrice(r.text)) && B.fetchRendered && !CLOUD_BLOCKED.test(it.url)) r = await B.fetchRendered(it.url);   // blocked or price drawn by JS: try the hidden browser
        var price = r.status < 400 ? getPrice(r.text) : null;
        var img = (r.text.match(/property="og:image"\s+content="([^"]+)"/) || [])[1] || null;
        if (price) {
          e.price = price; e.ok = true;
          var hit = (it.target && price <= it.target) || (e.lastPrice && price <= 0.95 * e.lastPrice);   // under target, or any drop of 5%+
          if (hit && price !== e.lastPrice) {
            if (await newHit(topic, it.id + ":" + price, { name: it.name, clothes: it.category === "clothes", criteria: it.name + (it.size ? ", wanted size " + it.size : "") + ", target price " + it.target + " zł, new from a legit Polish shop" + (it.notes ? ". Notes: " + it.notes : ""), price: price, target: it.target, was: e.lastPrice, url: it.url, image: img, desc: (e.lastPrice ? "Was " + e.lastPrice + " zł" : "") + (it.target && price > it.target ? " · above your target " + it.target + " zł, but discounted" : "") })) n++;
          }
        } else {
          fails++; e.error = blocked(r) ? "The shop blocked the check" : r.status >= 400 ? "Shop error " + r.status : "Price not found on the page";
          if (prev.price) { e.price = prev.price; e.stale = prev.staleSince || prev.checked || true; e.staleSince = prev.staleSince || prev.checked; }
          if (fails <= 3) B.log(e.error + ": " + it.name);
        }
      } catch (ex) { fails++; e.error = "Couldn't open the page"; if (prev.price) { e.price = prev.price; e.staleSince = prev.staleSince || prev.checked; } if (fails <= 3) B.log("failed (" + ex + "): " + it.name); }
      e.fails = e.ok ? 0 : fails;
      // A computer read this shop fine recently: don't overwrite its price with our "blocked"
      if (!e.ok && prev.ok && prev.by && prev.by !== curDev && Date.now() - new Date(prev.checked) < 3 * 3600e3) { await sleep(2000); continue; }
      rows.push({ user_id: window.DB.uid, id: it.id, data: e });
      await sleep(3000 + Math.random() * 6000);
    }
    if (rows.length) must(await sb.from("status").upsert(rows));
    return n;
  }

  var STOP = /^(and|or|the|with|for|new|only|used|like|similar|standard|official|lub|oraz|dla|cali|cale|inch|size|edition|from|price|any)$/;
  function norm(t) { return String(t || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ł/g, "l"); }
  function words(t) { return norm(t).split(/[^a-z0-9]+/).filter(function (w) { return w.length >= 3 && !STOP.test(w); }); }
  function xmlTag(x, t) { var m = x.match(new RegExp("<" + t + "[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</" + t + ">")); return m ? m[1].trim() : ""; }
  var pepperSeen = {}, PEPPER_FEEDS = ["wszystkie", "grupa/elektronika", "grupa/moda", "grupa/dom-i-mieszkanie", "grupa/komputery"];
  // Pepper.pl watcher (server only): matches deals from Pepper's public RSS feeds against the wishlist
  async function checkPepper(topic, wishlist) {
    var items = wishlist.filter(function (i) { return !i.bought && i.used !== "yes"; });
    if (!items.length) return 0;
    var xml = "";
    for (var f = 0; f < PEPPER_FEEDS.length; f++) {
      try { var r = await B.fetchText("https://www.pepper.pl/rss/" + PEPPER_FEEDS[f]); if (r.status < 400) xml += r.text; } catch (e) {}
      await sleep(2000);
    }
    var seenLink = {};
    var deals = (xml.match(/<item>[\s\S]*?<\/item>/g) || []).map(function (x) {
      var m = x.match(/<pepper:merchant name="([^"]*)" price="([^"]*)"/) || [];
      var desc = xmlTag(x, "description").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      return { title: xmlTag(x, "title"), link: xmlTag(x, "link"), shop: m[1] || "", price: parseFloat(String(m[2] || "").replace(/[^0-9,.]/g, "").replace(",", ".")) || null,
        image: (x.match(/<media:content[^>]*url="([^"]+)"/) || [])[1] || null, desc: desc.slice(0, 400) };
    }).filter(function (d) { if (!d.link || !d.price || seenLink[d.link]) return false; seenLink[d.link] = 1; return true; });
    var MARKET = /allegro|aliexpress|temu|shein|ebay|wish\b|joom|banggood|dhgate|amazon\s*marketplace/i;
    deals.forEach(function (d) { if (MARKET.test(d.shop + " " + d.link)) return; if (!dealPool[d.link]) dealPool[d.link] = Object.assign({ seen: Date.now() }, d); });
    var n = 0, judged = 0;
    for (var i = 0; i < items.length; i++) {
      var it = items[i], want = words(it.name + " " + (it.size || "")).filter(function (w, k, a) { return a.indexOf(w) === k; });
      if (!want.length) continue;
      for (var j = 0; j < deals.length && judged < 6; j++) {
        var d = deals[j], have = words(d.title), hits = want.filter(function (w) { return have.indexOf(w) >= 0; }).length;
        if (hits < Math.min(2, want.length)) continue;
        if (it.target && d.price > it.target * 1.3) continue;
        if (it.max && d.price > it.max) continue;
        if (pepperSeen[it.id + d.link]) continue;
        pepperSeen[it.id + d.link] = 1;
        if (await newHit(topic, "pepper:" + it.id + ":" + d.link, { name: it.name + ": " + d.title.slice(0, 120), clothes: it.category === "clothes",
          criteria: critFor(it, "deal posted on Pepper.pl: " + d.title + " — " + d.desc), price: d.price, target: it.target, url: d.link, image: d.image,
          desc: joinDesc("Pepper · " + d.shop, overTarget(it, d.price)) })) { n++; judged++; }
      }
    }
    if (n) B.log("Pepper: " + n + " new hit(s)");
    return n;
  }
  // ---- Claude's picks: every ~3 h (or when asked from the app) Claude reads the wishlist + recent Pepper deals
  // and suggests discounts worth it, even when a target price was set too low. Saved in settings "suggestions".
  var dealPool = {}, suggesting = false;
  async function makeSuggestions(d) {
    if (suggesting || !B.suggest) return;
    suggesting = true;
    try {
      var cut = Date.now() - 36 * 3600e3;
      Object.keys(dealPool).forEach(function (k) { if (dealPool[k].seen < cut) delete dealPool[k]; });
      var deals = Object.keys(dealPool).map(function (k) { return dealPool[k]; }).sort(function (a, b) { return b.seen - a.seen; }).slice(0, 180);
      if (!deals.length) { B.log("suggestions: no Pepper deals collected yet"); return; }
      var sz = await window.DB.getSetting("sizes").catch(function () { return null; });
      var wants = d.wishlist.filter(function (i) { return !i.bought; }).map(function (i) {
        var st = d.status[i.id] || {};
        return { id: i.id, name: i.name, category: i.category, size: i.size || "", used: i.used, target: i.target, max: i.max, notes: String(i.notes || "").slice(0, 300),
          nowAt: st.price || null, cheapestFound: st.best ? st.best.price + " zł at " + st.best.shop : null };
      });
      var promos = await window.DB.getSetting("promos").catch(function () { return ""; });
      var list = await B.suggest({ wishlist: wants, sizes: sz, promos: promos, deals: deals.map(function (x, n) { return { n: n + 1, title: x.title, price: x.price, shop: x.shop, desc: x.desc.slice(0, 200) }; }) });
      if (!Array.isArray(list)) { B.log("suggestions: no answer from Claude"); return; }
      var out = list.map(function (x) {
        var deal = deals[(x.n | 0) - 1]; if (!deal) return null;
        var it = d.wishlist.find(function (i) { return i.id === x.item; });
        return { title: deal.title, price: deal.price, shop: deal.shop, url: deal.link, image: deal.image, item: it ? it.id : null, itemName: it ? it.name : null,
          pick: /^BUY/i.test(x.pick) ? "BUY" : "LOOK", why: String(x.why || "").slice(0, 300) };
      }).filter(Boolean).slice(0, 20);
      await window.DB.setSetting("suggestions", { at: nowIso(), deals: deals.length, list: out });
      B.log("suggestions: " + out.length + " pick(s) from " + deals.length + " deals");
    } finally { suggesting = false; }
  }
  // ---- Resell finds (server, 2x a day 07-22): Claude searches public Vinted pages for clothes with 50+ zł resale profit
  async function makeResell() {
    if (!B.resell) return;
    var cur = await window.DB.getSetting("resell").catch(function () { return null; });
    var ask = await window.DB.getSetting("resellRequest").catch(function () { return null; });
    var asked = ask && (!cur || !cur.at || ask > cur.at);
    if (!asked && cur && cur.at && Date.now() - new Date(cur.at) < 11 * 3600e3) return;
    if (new Date().getHours() < 7) return;
    var cfg = (await window.DB.getSetting("resellCfg").catch(function () { return null; })) || {};
    await window.DB.setSetting("resell", Object.assign({}, cur || {}, { at: nowIso(), busy: true }));
    B.log("resell search started");
    var res = await B.resell({ brands: cfg.brands, minProfit: cfg.minProfit || 50, maxPrice: cfg.maxPrice || 200 });
    var list = (res || []).filter(function (x) { return x && /^https:\/\/(www\.)?vinted\.pl\//.test(x.url || "") && Number(x.profit) >= (cfg.minProfit || 50); }).slice(0, 10);
    await window.DB.setSetting("resell", { at: nowIso(), list: res ? list : ((cur && cur.list) || []), error: res ? null : "Claude gave no answer" });
    B.log("resell search done: " + list.length);
  }
  function overTarget(it, price) { return it.target && price > it.target ? Math.round(price - it.target) + " zł above your target (" + it.target + " zł), but discounted" : ""; }
  function joinDesc() { return Array.prototype.filter.call(arguments, Boolean).join(" · "); }
  function critFor(it, extra) {
    return it.name + (it.size ? ", wanted size " + it.size : "") + (it.target ? ", target price " + it.target + " zł" : "") + (extra ? ". " + extra : "") +
      (it.notes ? ". Notes: " + it.notes : "") + ". Judge whether this exact deal matches what the buyer wants; SKIP if it is a different product.";
  }

  // Claude price search (desktop only, 1-2x a day, one computer): cheapest current offer across shops for every item
  async function claudeSearch(topic, d) {
    if (!B.priceSearch || !B.getPref) return 0;
    var mode = (await B.getPref("priceSearch")) || "daily";
    if (mode === "off" || new Date().getHours() < 7) return 0;
    var last = await window.DB.getSetting("lastPriceSearch").catch(function () { return null; });
    if (last && Date.now() - new Date(last) < (mode === "twice" ? 11 : 22) * 3600e3) return 0;
    var items = d.wishlist.filter(function (i) { return !i.bought && !(i.used === "yes" && !/^https:/.test(i.url || "")); });
    if (!items.length) return 0;
    await window.DB.setSetting("lastPriceSearch", nowIso());          // claim it so the other computer doesn't run it too
    var sz = await window.DB.getSetting("sizes").catch(function () { return null; });
    B.log("Claude price search started (" + items.length + " items)");
    var res = await B.priceSearch(items.map(function (i) { return { id: i.id, name: i.name, size: i.size, target: i.target, used: i.used, url: i.url, notes: i.notes }; }),
      { sizes: sz ? Object.keys(sz).map(function (k) { return k + ": " + sz[k]; }).join("; ") : "", promos: await window.DB.getSetting("promos").catch(function () { return ""; }) });
    if (!res) { B.log("Claude price search: no result"); return 0; }
    var fresh = {}, r0 = await sb.from("status").select("id,data").in("id", items.map(function (i) { return i.id; }));
    (r0.data || []).forEach(function (x) { fresh[x.id] = x.data; });
    var rows = [], n = 0;
    for (var k = 0; k < res.length; k++) {
      var r = res[k], it = items.find(function (i) { return i.id === r.id; });
      if (!it || !(Number(r.price) > 0) || !/^https:\/\//.test(r.url || "")) continue;
      var prev = fresh[it.id] || {}, price = Number(r.price);
      var best = { price: price, shop: String(r.shop || "").slice(0, 40), url: r.url, note: String(r.note || "").slice(0, 160), at: nowIso() };
      var ref = prev.price || prev.lastPrice;
      if (((it.target && price <= it.target) || (ref && price <= 0.9 * ref)) && !(prev.best && prev.best.price === price && prev.best.url === r.url)) {
        if (await newHit(topic, it.id + ":best:" + price + ":" + best.shop, { name: it.name, clothes: it.category === "clothes",
          criteria: it.name + (it.size ? ", wanted size " + it.size : "") + ", target price " + it.target + " zł" + (it.notes ? ". Notes: " + it.notes : ""),
          price: price, target: it.target, url: r.url, desc: best.shop + (best.note ? " · " + best.note : "") + (it.target && price > it.target ? " · above your target " + it.target + " zł, but " + Math.round(100 - 100 * price / ref) + "% under the tracked price" : "") })) n++;
      }
      rows.push({ user_id: window.DB.uid, id: it.id, data: Object.assign({}, prev, { name: it.name, best: best }) });
    }
    if (rows.length) must(await sb.from("status").upsert(rows));
    B.log("Claude price search done: " + rows.length + " prices, " + n + " hit(s)");
    return n;
  }

  async function checkSearches(topic, searches) {
    var n = 0;
    for (var i = 0; i < searches.length; i++) {
      var s = searches[i];
      var url = "https://www.olx.pl/api/v1/offers/?offset=0&limit=50&query=" + encodeURIComponent(s.query) +
        "&filter_float_price:from=" + s.min + "&filter_float_price:to=" + s.max + "&sort_by=created_at:desc";
      try {
        var r = await B.fetchText(url);
        if (r.status >= 400) throw new Error("HTTP " + r.status);
        var offers = (JSON.parse(r.text).data || []);
        var firstRun = !(await sb.from("seen").select("offer_id", { head: true, count: "exact" }).eq("search_id", s.id)).count;
        var fresh = await sb.rpc("mark_seen", { sid: s.id, ids: offers.map(function (o) { return String(o.id); }) }).then(must);
        if (!firstRun) for (var j = 0; j < offers.length; j++) {
          var o = offers[j], t = String(o.title || "").toLowerCase();
          if (fresh.indexOf(String(o.id)) < 0) continue;
          if (!(s.mustMatch || []).every(function (m) { return new RegExp(m, "i").test(t); })) continue;
          if ((s.exclude || []).some(function (x) { return t.indexOf(x) >= 0; })) continue;
          var pp = (o.params || []).find(function (p) { return p.key === "price"; });
          var price = pp && pp.value ? pp.value.value : null;
          if (!price || price < s.min || price > s.max) continue;
          var ph = o.photos || [];
          var desc = String(o.description || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
          var h = {
            criteria: s.criteria, name: s.name + ": " + o.title, price: price, target: s.max, url: o.url,
            city: o.location && o.location.city ? o.location.city.name : null,
            image: ph[0] ? ph[0].link.replace("{width}", "1600").replace("{height}", "1200") : null,
            photos: ph.slice(0, 6).map(function (x) { return x.link.replace("{width}", "1200").replace("{height}", "900").replace(":443/", "/"); }),
            desc: desc.length > 220 ? desc.slice(0, 220) + "..." : desc, fullDesc: desc.slice(0, 3000)
          };
          if (await newHit(topic, "olx:" + o.id, h)) n++;
        }
        await sb.from("status").upsert({ user_id: window.DB.uid, id: "search-" + s.id, data: { name: s.name, ok: true, checked: nowIso() } });
      } catch (ex) { B.log("OLX search failed (" + ex + "): " + s.name); }
    }
    return n;
  }

  var curDev = null;
  async function runOnce(force) {
    if (running) return "busy";
    running = true;
    try {
      if (!(await window.DB.session())) return "not logged in";
      var dev = await B.device(); curDev = dev;
      var mine = await sb.rpc("claim_runner", { dev: force ? dev : dev }).then(must);
      if (!mine && !force) {
        if (B.cloud) return "a computer is checking";
        // The home server is the main checker: it always takes over
        if (B.primary) { await sb.from("runner").upsert({ user_id: window.DB.uid, device: dev, beat: nowIso() }); }
        else {
        // A computer always takes over from the cloud backup right away
        var rr = await sb.from("runner").select("device").maybeSingle();
        if (!(rr.data && /^Cloud/.test(rr.data.device))) {
          // The home server checks everything else; this computer only checks the shops that block the server
          if (rr.data && /^Home server/.test(rr.data.device) && B.fetchRendered) {
            var d0 = await window.DB.loadAll(), topic0 = await window.DB.getSetting("ntfy");
            var left = d0.wishlist.filter(function (it) {
              var st = d0.status[it.id] || {};
              return CLOUD_BLOCKED.test(it.url || "") || (!st.ok && /^Home server/.test(st.by || "") && /blocked|Shop error|not found|open the page/.test(st.error || ""));
            });
            var m0 = left.length ? await checkItems(topic0, left, d0.status, force) : 0;
            return "the home server is checking" + (left.length ? "; " + left.length + " blocked shop page(s) checked here, " + m0 + " new hit(s)" : "");
          }
          return "another computer is checking";
        }
        await sb.from("runner").upsert({ user_id: window.DB.uid, device: dev, beat: nowIso() });
        }
      }
      if (!mine && force) await sb.from("runner").upsert({ user_id: window.DB.uid, device: dev, beat: nowIso() });
      var d = await window.DB.loadAll();
      var topic = await window.DB.getSetting("ntfy");
      var sz = await window.DB.getSetting("sizes").catch(function () { return null; });
      sizesText = sz ? Object.keys(sz).map(function (k) { return k + ": " + sz[k]; }).join("; ") : "";
      var n = await checkItems(topic, d.wishlist, d.status, force) + await checkSearches(topic, d.searches);
      try { n += await claudeSearch(topic, d); } catch (e) { B.log("Claude price search error: " + (e.message || e)); }
      await sb.from("runner").update({ beat: nowIso() }).eq("user_id", window.DB.uid);
      if (topic) B.fetchText("https://ntfy.sh/" + topic + "-hb", { method: "POST", body: "up" }).catch(function () {});
      if (Math.random() < 0.05) sb.rpc("cleanup");
      await cleanPhotos().catch(function (e) { B.log("photo cleanup: " + e); });
      B.log("check done, " + n + " new hit(s)");
      return n + " new hit(s)";
    } catch (ex) { B.log("check error: " + (ex.message || ex)); return "error: " + (ex.message || ex); }
    finally { running = false; }
  }

  window.Checker = { runOnce: runOnce };
  // "Check now" pressed on the phone website: it saves the time in settings; the device currently checking runs a check
  if (!B.cloud) {
    var lastAsk = null;
    setInterval(function () {
      if (!window.DB.uid || running) return;
      window.DB.getSetting("checkNow").then(function (ask) {
        if (!ask) return;
        if (lastAsk === null) { lastAsk = ask; if (Date.now() - new Date(ask) > 120e3) return; }
        else if (ask === lastAsk) return;
        lastAsk = ask;
        return Promise.all([B.device(), sb.from("runner").select("device").maybeSingle()]).then(function (x) {
          if (x[1].data && x[1].data.device !== x[0] && !B.primary) return;   // another device is the checker
          B.log("check requested from the phone");
          return runOnce(true).then(function (r) { return window.DB.setSetting("checkNowDone", { at: nowIso(), by: x[0], result: r }); });
        });
      }).catch(function () {});
    }, 30000);
  }
  // Every 15 minutes (the app also calls runOnce on start and after the computer wakes up)
  setTimeout(function () { runOnce(false); }, 8000);
// Random timing: wait 10-20 min (a new random number every time), check, then plan the next one
(function next() {
  var wait = (10 + Math.random() * 10) * 60e3;
  B.log("next check in " + (wait / 60e3).toFixed(1) + " min");
  setTimeout(function () { runOnce(false).finally(next); }, wait);
})();
  B.onWake(function () { setTimeout(function () { runOnce(false); }, 20000); });
  if (B.platform === "server") setInterval(async function () {
    try {
      if (window.DB.uid && !running) {
        var d = await window.DB.loadAll(), topic = await window.DB.getSetting("ntfy");
        await checkPepper(topic, d.wishlist);
      }
    } catch (e) { B.log("Pepper watch error: " + (e.message || e)); }
  }, 5 * 60e3);
  if (B.platform === "server") {
    var lastSug = 0, lastSugAsk = null;
    setInterval(async function () {
      if (!window.DB.uid || suggesting) return;
      try {
        var ask = await window.DB.getSetting("suggestRequest");
        var asked = ask && ask !== lastSugAsk && Date.now() - new Date(ask) < 30 * 60e3;
        if (!asked && Date.now() - lastSug < 3 * 3600e3) return;
        if (!asked && !Object.keys(dealPool).length) return;          // wait until the Pepper watcher collected deals
        if (asked && !Object.keys(dealPool).length) {                  // asked right after a restart: collect now
          var d0 = await window.DB.loadAll(); await checkPepper(await window.DB.getSetting("ntfy"), d0.wishlist);
        }
        lastSugAsk = ask; lastSug = Date.now();
        await makeSuggestions(await window.DB.loadAll());
      } catch (e) { B.log("suggestions error: " + (e.message || e)); }
    }, 60000);
    var resellBusy = false;
    setInterval(async function () {
      if (!window.DB.uid || resellBusy) return;
      resellBusy = true;
      try { await makeResell(); } catch (e) { B.log("resell error: " + (e.message || e)); } finally { resellBusy = false; }
    }, 5 * 60e3);
  }
})();
