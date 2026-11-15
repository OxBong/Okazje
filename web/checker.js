// Price checker engine. Runs only inside the desktop app (window.okazje = bridge to the computer).
// Every 15 min: claim the "runner" lease (one computer at a time), check shop links + OLX searches,
// store prices/hits in the cloud, push new hits to the phone. Claude only writes the short verdict.
(function () {
  var B = window.okazje;
  if (!B) return;
  var sb = window.DB.sb;
  var running = false;
  function must(r) { if (r.error) throw r.error; return r.data; }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function nowIso() { return new Date().toISOString(); }

  function getPrice(html) {
    var pats = [/property="product:price:amount"\s+content="([0-9]+(?:[.,][0-9]{1,2})?)"/g,
                /itemprop="price"[^>]*content="([0-9]+(?:[.,][0-9]{1,2})?)"/g,
                /"price"\s*:\s*"?([0-9]+(?:[.,][0-9]{1,2})?)/g];
    for (var i = 0; i < pats.length; i++) {
      var m; while ((m = pats[i].exec(html))) { var v = parseFloat(m[1].replace(",", ".")); if (v >= 5) return v; }
    }
    return null;
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

  async function newHit(topic, key, h) {
    var id = await storeHit(key, h);
    if (!id) return false;                       // another computer already reported it
    var crit = h.criteria || (h.name + ", target price " + h.target + " zł, new from a legit Polish shop");
    try { h.verdict = await B.verdict(h, crit); } catch (e) { h.verdict = null; }
    if (h.verdict && /^SKIP/.test(h.verdict) && /Apple Watch/.test(h.name)) {   // junk watch listings: drop silently
      await sb.from("hits").delete().eq("id", id); return false;
    }
    if (h.verdict) await sb.from("hits").update({ data: h }).eq("id", id);
    if (topic) { try { await push(topic, h); } catch (e) { B.log("push failed: " + e); } }
    B.notify("Okazje: " + h.name, h.price + " zł" + (h.verdict ? " · " + h.verdict.split(".")[0] : ""));
    return true;
  }

  async function checkItems(topic, items, oldStatus) {
    var rows = [], n = 0;
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (it.bought || !/^https:\/\//.test(it.url || "") || /olx\.pl|pepper\.pl|\/search|query=/.test(it.url) || CLOUD_BLOCKED.test(it.url)) continue;
      var prev = oldStatus[it.id] || {}, fails = prev.fails || 0;
      if (fails >= 3 && prev.checked && Date.now() - new Date(prev.checked) < 6 * 3600e3) continue;
      var e = { name: it.name, url: it.url, target: it.target, price: null, lastPrice: prev.price || prev.lastPrice || null, ok: false, checked: nowIso() };
      try {
        var r = await B.fetchText(it.url);
        var price = r.status < 400 ? getPrice(r.text) : null;
        var img = (r.text.match(/property="og:image"\s+content="([^"]+)"/) || [])[1] || null;
        if (price) {
          e.price = price; e.ok = true;
          var hit = (it.target && price <= it.target) || (!it.target && e.lastPrice && price <= 0.95 * e.lastPrice);
          if (hit && price !== e.lastPrice) {
            if (await newHit(topic, it.id + ":" + price, { name: it.name, price: price, target: it.target, was: e.lastPrice, url: it.url, image: img, desc: e.lastPrice ? "Was " + e.lastPrice + " zł" : "" })) n++;
          }
        } else { fails++; if (fails <= 3) B.log("no price found: " + it.name); }
      } catch (ex) { fails++; if (fails <= 3) B.log("failed (" + ex + "): " + it.name); }
      e.fails = e.ok ? 0 : fails;
      rows.push({ user_id: window.DB.uid, id: it.id, data: e });
      await sleep(3000 + Math.random() * 6000);
    }
    if (rows.length) must(await sb.from("status").upsert(rows));
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
            image: ph[0] ? ph[0].link.replace("{width}", "800").replace("{height}", "600") : null,
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

  async function runOnce(force) {
    if (running) return "busy";
    running = true;
    try {
      if (!(await window.DB.session())) return "not logged in";
      var dev = await B.device();
      var mine = await sb.rpc("claim_runner", { dev: force ? dev : dev }).then(must);
      if (!mine && !force) return "another computer is checking";
      if (!mine && force) await sb.from("runner").upsert({ user_id: window.DB.uid, device: dev, beat: nowIso() });
      var d = await window.DB.loadAll();
      var topic = await window.DB.getSetting("ntfy");
      var n = await checkItems(topic, d.wishlist, d.status) + await checkSearches(topic, d.searches);
      await sb.from("runner").update({ beat: nowIso() }).eq("user_id", window.DB.uid);
      if (topic) B.fetchText("https://ntfy.sh/" + topic + "-hb", { method: "POST", body: "up" }).catch(function () {});
      if (Math.random() < 0.05) sb.rpc("cleanup");
      B.log("check done, " + n + " new hit(s)");
      return n + " new hit(s)";
    } catch (ex) { B.log("check error: " + (ex.message || ex)); return "error: " + (ex.message || ex); }
    finally { running = false; }
  }

  window.Checker = { runOnce: runOnce };
  // Every 15 minutes (the app also calls runOnce on start and after the computer wakes up)
  setTimeout(function () { runOnce(false); }, 8000);
  setInterval(function () { runOnce(false); }, 15 * 60e3);
  B.onWake(function () { setTimeout(function () { runOnce(false); }, 20000); });
})();
