// Cloud data layer (Supabase). Used by the page on every device and by the desktop checker.
(function () {
  var C = window.OKAZJE_CONFIG;
  var sb = window.supabase.createClient(C.supabaseUrl, C.supabaseAnonKey, { auth: { persistSession: true, autoRefreshToken: true } });
  function must(r) { if (r.error) throw r.error; return r.data; }
  var DB = {
    sb: sb,
    uid: null,
    session: function () { return sb.auth.getSession().then(function (r) { var s = r.data.session; DB.uid = s ? s.user.id : null; return s; }); },
    login: function (email, pw) { return sb.auth.signInWithPassword({ email: email, password: pw }).then(must).then(function (d) { DB.uid = d.user.id; return d; }); },
    signup: function (email, pw) { return sb.auth.signUp({ email: email, password: pw }).then(must); },
    logout: function () { return sb.auth.signOut(); },
    loadAll: function () {
      return Promise.all([
        sb.from("items").select("id,data"),
        sb.from("status").select("id,data"),
        sb.from("hits").select("id,data,created_at").order("created_at", { ascending: false }).limit(60),
        sb.from("searches").select("id,data"),
        sb.from("runner").select("device,beat").maybeSingle()
      ]).then(function (r) {
        r.forEach(must);
        var status = {}; r[1].data.forEach(function (x) { status[x.id] = x.data; });
        return {
          wishlist: r[0].data.map(function (x) { return Object.assign({}, x.data, { id: x.id }); }),
          status: status,
          hits: r[2].data.map(function (x) { return Object.assign({ time: x.created_at, hitId: x.id }, x.data); }),
          searches: r[3].data.map(function (x) { return Object.assign({}, x.data, { id: x.id }); }),
          lastRun: r[4].data ? r[4].data.beat : null,
          runner: r[4].data ? r[4].data.device : null
        };
      });
    },
    saveItem: function (it) {
      var d = Object.assign({}, it); delete d.id;
      return sb.from("items").upsert({ user_id: DB.uid, id: it.id, data: d, updated_at: new Date().toISOString() }).then(must);
    },
    deleteItem: function (id) { return sb.from("items").delete().eq("id", id).then(must); },
    saveSearch: function (s) { var d = Object.assign({}, s); delete d.id; return sb.from("searches").upsert({ user_id: DB.uid, id: s.id, data: d }).then(must); },
    deleteSearch: function (id) { return sb.from("searches").delete().eq("id", id).then(must); },
    // Short-lived links to the photos saved in the cloud (the bucket is private)
    photoUrls: function (paths) {
      if (!paths.length) return Promise.resolve({});
      return sb.storage.from("photos").createSignedUrls(paths, 6 * 3600).then(function (r) {
        var m = {}; (r.data || []).forEach(function (x) { if (x.signedUrl) m[x.path] = x.signedUrl; }); return m;
      }).catch(function () { return {}; });
    },
    getSetting: function (k) { return sb.from("settings").select("value").eq("key", k).maybeSingle().then(function (r) { must(r); return r.data ? r.data.value : null; }); },
    setSetting: function (k, v) { return sb.from("settings").upsert({ user_id: DB.uid, key: k, value: v }).then(must); },
    // Live updates: any change from another device refreshes the page
    onChange: function (cb) {
      var t; function fire() { clearTimeout(t); t = setTimeout(cb, 400); }
      sb.channel("okazje").on("postgres_changes", { event: "*", schema: "public", table: "items" }, fire)
        .on("postgres_changes", { event: "*", schema: "public", table: "hits" }, fire)
        .on("postgres_changes", { event: "*", schema: "public", table: "status" }, fire).subscribe();
    },
    // One-time import of the old PC files: { wishlist:[...], searches:[...], seen:{searchId:[ids]}, ntfy:"topic" }
    importOld: function (o) {
      var jobs = [];
      (o.wishlist || []).forEach(function (it) { if (it && it.id) jobs.push(DB.saveItem(it)); });
      (o.searches || []).forEach(function (s) { if (s && s.id) jobs.push(DB.saveSearch(s)); });
      Object.keys(o.seen || {}).forEach(function (sid) {
        var ids = (o.seen[sid] || []).map(String);
        for (var i = 0; i < ids.length; i += 200) jobs.push(sb.rpc("mark_seen", { sid: sid, ids: ids.slice(i, i + 200) }).then(must));
      });
      if (o.ntfy) jobs.push(DB.setSetting("ntfy", o.ntfy));
      return Promise.all(jobs).then(function () { return jobs.length; });
    }
  };
  window.DB = DB;
})();
