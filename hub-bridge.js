/* Aldora Sales Hub bridge for the Quote Follow-Up & Call Log app.
   Lives in its own file so a new index.html export from Claude Design never removes it.
   An edge function (netlify/edge-functions/hub-bridge.mjs) adds it to the page on every load.

   Weekly quote upload from the Sales Hub. The hub opens this page in a hidden frame with
   #hubjob=1&ac=<code> and posts the week's FeneVision files. This runs the app's OWN upload
   (the same code as the Admin buttons "Upload This Week's Open Quotes" and "Upload This Week's
   Closed Quotes"), so quotes are added to the shared list, closed quotes are matched and logged,
   and everything is published to the reps exactly as if the files were uploaded in Admin.
   Only the Aldora Sales Hub (aldora*.netlify.app) can ask, and only a company-wide code. */
(function () {
  "use strict";
  // Sign-in for the hub's hidden frame (#hubjob=1&ac=CODE). Hub links to one quote are handled below.
  try {
    var h = location.hash || "";
    if (/(?:^#|&)hubjob=1(?:&|$)/.test(h)) {
      var m = h.match(/(?:^#|&)ac=([^&]+)/);
      if (m) localStorage.setItem("aq_access", JSON.stringify({ code: decodeURIComponent(m[1]) }));
      history.replaceState(null, "", location.pathname + location.search);
    }
  } catch (e) {}

  var HUB = /^https:\/\/(?:[a-z0-9-]+--)?aldora[a-z0-9-]*\.netlify\.app$/i;
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var busy = false;

  // The app's logic object, found through React (the Claude Design runtime keeps it on the host component).
  function findLogic() {
    var els = document.querySelectorAll("body *");
    for (var i = 0; i < els.length && i < 600; i++) {
      var el = els[i], k = null;
      for (var key in el) { if (key.indexOf("__reactFiber$") === 0 || key.indexOf("__reactInternalInstance$") === 0) { k = key; break; } }
      if (!k) continue;
      for (var f = el[k]; f; f = f.return) {
        var s = f.stateNode;
        if (s && s.logic && typeof s.logic.onUpload === "function" && typeof s.logic.applyClosedQuotes === "function") return s.logic;
      }
    }
    return null;
  }
  async function readyLogic() {
    for (var i = 0; i < 240; i++) {
      var L = findLogic();
      if (L && L.state) {
        if (L.state.accessGate) return { L: L, gate: true };
        if (L._quotesPayload && !L.state.loading) return { L: L };
      }
      await sleep(250);
    }
    return { L: findLogic(), timeout: true };
  }
  // Open one record straight from the Sales Hub:
  //   #ac=CODE&go=quote&q=QUOTE#&c=CUSTOMER&job=JOB   Biggest opportunities: the quote's follow-up record
  //                                                     (or Open Quotes narrowed to it)
  //   #ac=CODE&go=rem&uid=UID                           Accounts due a visit, scheduled or overdue: that reminder
  //   #ac=CODE&go=attn&br=BRANCH                       Manager needs attention: the Call Log, that branch's flagged calls
  //   #ac=CODE&go=log                                   Log a call button: the Log a Call / Visit form
  //   #ac=CODE&go=visit&c=CUSTOMER&rep=REP              Accounts due a visit, gone quiet: a new Visit reminder
  //                                                     for that customer and rep, ready to pick a date
  // Sign-in: a device that isn't signed in takes the hub's code. A device already signed in keeps its
  // own sign-in, so opening a rep's record while viewing as that rep in the hub never turns this
  // device into that rep. (A sign-in that came from an earlier hub link is replaced.)
  var GO = null;
  try {
    var gh = location.hash || "";
    var gm = /(?:^#|&)go=(quote|rem|visit|log|attn)(?:&|$)/.exec(gh);
    if (gm && !/(?:^#|&)hubjob=1(?:&|$)/.test(gh)) {
      var gp = new URLSearchParams(gh.slice(1));
      GO = { go: gm[1], q: gp.get("q") || "", c: gp.get("c") || "", job: gp.get("job") || "", uid: gp.get("uid") || "", rep: gp.get("rep") || "", br: gp.get("br") || "" };
      var gc = gp.get("ac");
      if (gc) {
        var sv = null; try { sv = JSON.parse(localStorage.getItem("aq_access") || "null"); } catch (e) {}
        var fromHub = localStorage.getItem("aq_access_hub") === "1";
        if (!sv || !sv.code || (fromHub && sv.code !== gc)) {
          localStorage.setItem("aq_access", JSON.stringify({ code: gc }));
          localStorage.setItem("aq_access_hub", "1");
        }
      }
      history.replaceState(null, "", location.pathname + location.search);
    }
  } catch (e) { GO = null; }

  var normQ = function (v) { return String(v || "").toUpperCase().replace(/\s+/g, "").replace(/[^A-Z0-9-]/g, ""); };
  var normC = function (v) { return String(v || "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").replace(/\b(inc|llc|co|corp|the)\b/g, " ").replace(/\s+/g, " ").trim(); };
  function pick(list, go) {
    var qn = normQ(go.q), cn = normC(go.c), jn = String(go.job || "").trim().toLowerCase();
    var hits = (list || []).filter(function (r) {
      if (!r) return false;
      if (qn) return normQ(r.quoteNo) === qn;
      return cn && normC(r.customer) === cn && jn && String(r.jobName || "").trim().toLowerCase() === jn;
    });
    if (hits.length > 1 && cn) { var same = hits.filter(function (r) { return normC(r.customer) === cn; }); if (same.length) hits = same; }
    hits.sort(function (a, b) { return (b.loggedAt || 0) - (a.loggedAt || 0); });
    return hits[0] || null;
  }
  async function openFromHub(go) {
    var r = await readyLogic();
    var L = r.L;
    if (!L || r.gate || r.timeout) return;
    if (go.go === "attn") { try { L.goCalls(); setTimeout(function () { try { L.setState({ cl_branches: go.br ? [go.br] : [], cl_attn: !!go.br, attnDismissed: false, callPage: 0 }); } catch (e) {} }, 60); } catch (e) {} return; }
    if (go.go === "log") { try { L.goCalls(); setTimeout(function () { try { L.openCallForm(); } catch (e) {} }, 60); } catch (e) {} return; }
    if (go.go === "rem") return openReminder(L, go);
    if (go.go === "visit") return newVisit(L, go);
    var find = go.q || go.job;
    var clear = { page: 0, f_search: find, f_customers: [], f_outcome: "", f_month: "", f_facilities: [], f_division: "", f_quotedBy: "", f_product: "", f_amtBands: [], f_min: "", f_max: "", f_days: "" };
    try {
      var logged = pick(typeof L.mergedLogged === "function" ? L.mergedLogged() : [], go);
      if (logged) {
        L.setState(Object.assign({ view: "logged", loggedInit: true }, clear));
        setTimeout(function () { try { L.openDetail(logged); } catch (e) {} }, 50);
        return;
      }
      L.setState(Object.assign({ view: "open" }, clear));
    } catch (e) {}
  }
  // A visit reminder: open Reminders with that reminder's card open
  async function openReminder(L, go) {
    try {
      L.setState({ remOpen: true, rem_rep: "" });
      // Reminders can arrive a moment after the quotes
      for (var i = 0; i < 60; i++) {
        var r = (L.state.reminders || []).find(function (x) { return x && !x.deleted && String(x.uid) === go.uid; });
        if (r) { L.setState({ remDetail: r.uid, remReschedOpen: false, remNewDate: "" }); return; }
        await sleep(250);
      }
    } catch (e) {}
  }
  // An account gone quiet: open a new Visit reminder for that customer and rep, ready to pick a date
  function newVisit(L, go) {
    try {
      var rep = typeof L.normalizeRep === "function" ? L.normalizeRep(go.rep) : go.rep;
      L.setState({ remOpen: true, rem_rep: "" });
      L.openRemForm();
      setTimeout(function () {
        try {
          L.setState({ rf_type: "Visit", rf_rep: (L._scope && L._scope.role === "rep") ? L._scope.rep : rep });
          L._rf = Object.assign({}, L._rf || {}, { customer: go.c });
          var tries = 0;
          (function fill() {
            var inp = document.querySelector('input[list="rem-custs"]');
            if (!inp && tries++ < 40) { setTimeout(fill, 100); return; }
            if (inp) { inp.value = go.c; L._rf.customer = go.c; }
            var d = document.querySelector('input[type="date"]');
            if (d) try { d.focus(); } catch (e) {}
          })();
        } catch (e) {}
      }, 60);
    } catch (e) {}
  }
  if (GO) openFromHub(GO);

  // Wait for the publish that the app starts after each upload
  async function waitPush(L) {
    for (var i = 0; i < 480; i++) {
      var msg = String((L.state && L.state.cloudPushMsg) || "");
      if (/^[✓✗]/.test(msg)) return msg;
      await sleep(250);
    }
    return "✗ No publish confirmation within 2 minutes.";
  }
  function kindOf(XLSX, wb) {
    // Same sheet choice and detection as the app's onUpload
    var sheet = wb.SheetNames.find(function (n) { return /my open quotes/i.test(n); }) || wb.SheetNames.find(function (n) { return /open quotes/i.test(n); }) || wb.SheetNames.find(function (n) { return /quote.?history/i.test(n); }) || wb.SheetNames[0];
    var aoa = XLSX.utils.sheet_to_json(wb.Sheets[sheet], { header: 1, raw: true, defval: "" });
    var hdr = (aoa[0] || []).map(function (c) { return String(c).toLowerCase(); }).join("|");
    var closed = hdr.indexOf("ordernumber") >= 0 && (hdr.indexOf("closeddate") >= 0 || hdr.indexOf("order/quote close status") >= 0 || hdr.indexOf("copiedtoordernumber") >= 0) && hdr.indexOf("ordertotal") < 0;
    return closed ? "closed" : "open";
  }

  window.addEventListener("message", async function (ev) {
    var d = ev.data;
    if (!d || d.type !== "aldora-quotes-upload") return;
    var reply = function (m) { try { ev.source.postMessage(Object.assign({ type: "aldora-quotes-upload", id: d.id }, m), ev.origin); } catch (e) {} };
    if (!HUB.test(ev.origin) || ev.source !== window.parent) { reply({ ok: false, error: "The Call Log app only takes uploads from the Aldora Sales Hub." }); return; }
    if (busy) { reply({ ok: false, error: "An upload is already running." }); return; }
    busy = true;
    var alertOrig = window.alert, alerts = [];
    window.alert = function (t) { alerts.push(String(t)); };
    try {
      var r = await readyLogic(), L = r.L;
      if (!L) throw new Error("The Call Log app didn't finish loading.");
      if (r.gate) throw new Error("The Call Log app asked for an access code. Open it once from the hub and sign in.");
      if (r.timeout) throw new Error("The Call Log app didn't finish loading its shared quotes.");
      if (L._scope && L._scope.role !== "all") throw new Error("Only a company-wide code can upload quotes.");
      if (!L.state.cloudKey) {
        var ck = ""; try { ck = localStorage.getItem("aq_cloudKey") || ""; } catch (e) {}
        L.setState({ cloudKey: ck || L.BUILTIN_SYNC_KEY || "" });
        await sleep(50);
      }
      var XLSX = await L.ensureXLSX();
      var files = Array.isArray(d.files) ? d.files : [], open = [], closed = [];
      for (var i = 0; i < files.length; i++) {
        var wb = XLSX.read(await files[i].arrayBuffer(), { type: "array" });
        (kindOf(XLSX, wb) === "closed" ? closed : open).push(files[i]);
      }
      var done = [];
      // Open quotes first, so closed quotes can match them
      for (var j = 0; j < open.length; j++) {
        reply({ progress: "adding open quotes from " + open[j].name });
        L.setState({ cloudPushMsg: "" }); await sleep(50); alerts = [];
        await L.onUploadGlass({ target: { files: [open[j]], value: "" } });
        if (alerts.length) throw new Error(open[j].name + ": " + alerts[0]);
        var p0 = await waitPush(L);
        if (p0.charAt(0) !== "✓") throw new Error(open[j].name + ": quotes were read but not published. " + p0);
        done.push(open[j].name + ": " + String(L.state.dataMeta || "").replace(/^[^·]*·\s*/, ""));
        await sleep(300);
      }
      for (var c = 0; c < closed.length; c++) {
        reply({ progress: "logging closed quotes from " + closed[c].name });
        // Start from the shared follow-up history, not this frame's empty local copy
        var snap = await L.fetchCloud();
        if (!snap || !snap.log || !Array.isArray(snap.log.records)) throw new Error("Couldn't read the shared follow-up history, so closed quotes were not applied (nothing was changed).");
        await L.idbSet("importedLog", snap.log);
        L.setState({ cloudPushMsg: "" }); await sleep(50); alerts = [];
        await L.onUploadMetal({ target: { files: [closed[c]], value: "" } });
        if (alerts.length) throw new Error(closed[c].name + ": " + alerts[0]);
        var p1 = await waitPush(L);
        if (p1.charAt(0) !== "✓") throw new Error(closed[c].name + ": closed quotes were read but not published. " + p1);
        var n = (L.state.imported || []).length;
        done.push(closed[c].name + ": closed quotes applied, " + n.toLocaleString() + " follow-ups on file");
        await sleep(300);
      }
      reply({ ok: true, done: done, open: open.length, closed: closed.length });
    } catch (e) {
      reply({ ok: false, error: String((e && e.message) || e) });
    } finally {
      window.alert = alertOrig;
      busy = false;
    }
  });
})();

/* Account lists shared with the Sales Hub (Nov 15 2026). The hub (/api/account-flags) decides what is
   on each rep's account list; this keeps the Call Log in step:
   1. Approved changes: accounts Fred confirmed are not the rep's come off the rep's list here (customer
      picker, "your accounts", quotes on the list); approved new accounts go on it.
   2. New customers: when a rep logs a call with "New customer" checked for a customer that is not on
      their list, the customer, contact, phone and email go to Fred to approve. Once he does, the account
      is on the rep's list in every app (Call Log, My Territory, Hub Home, Card File, Quote Trends).
   3. 90 days: the customer picker marks accounts with no call logged in 90+ days, and accounts flagged
      as not the rep's while Fred decides. */
(function () {
  "use strict";
  var HUB = "https://aldora-sales-hub.netlify.app";
  var QUIET = 90, DAY = 86400000;
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var repKey = function (r) { return String(r || "").toLowerCase().replace(/[^a-z]/g, "").replace(/(.)\1/g, "$1"); };
  var changes = null, lastSync = 0;
  function code() { try { var a = JSON.parse(localStorage.getItem("aq_access") || "null"); return a && a.code ? a.code : ""; } catch (e) { return ""; } }
  function logic() {
    var els = document.querySelectorAll("body *");
    for (var i = 0; i < els.length && i < 600; i++) {
      var el = els[i], k = null;
      for (var key in el) { if (key.indexOf("__reactFiber$") === 0 || key.indexOf("__reactInternalInstance$") === 0) { k = key; break; } }
      if (!k) continue;
      for (var f = el[k]; f; f = f.return) { var s = f.stateNode; if (s && s.logic && typeof s.logic.publishCalls === "function" && s.logic.REP_ACCOUNTS) return s.logic; }
    }
    return null;
  }

  // 1. Apply the hub's approved changes to the Call Log's account lists (from the original lists every time)
  function applyLists(L) {
    if (!changes) return;
    if (!L.__origAccounts) L.__origAccounts = JSON.parse(JSON.stringify(L.REP_ACCOUNTS));
    var out = JSON.parse(JSON.stringify(L.__origAccounts));
    Object.keys(changes).forEach(function (hubRep) {
      var ch = changes[hubRep], rk = repKey(hubRep);
      var key = Object.keys(out).find(function (r) { return repKey(r) === rk; }) || L.normalizeRep(hubRep);
      var list = out[key] || (out[key] = []);
      var gone = new Set((ch.remove || []).map(function (n) { return L._acctKey(n); }));
      list = list.filter(function (n) { return !gone.has(L._acctKey(n)); });
      var have = new Set(list.map(function (n) { return L._acctKey(n); }));
      (ch.add || []).forEach(function (n) { if (!have.has(L._acctKey(n))) { list.push(n); have.add(L._acctKey(n)); } });
      out[key] = list;
    });
    L.REP_ACCOUNTS = out;
    L._repAcctCache = {};
  }
  async function sync(L, force) {
    var c = code(); if (!c) return;
    if (!force && Date.now() - lastSync < 300000) return;
    lastSync = Date.now();
    try {
      var r = await fetch(HUB + "/api/account-flags?lists=1", { headers: { "x-hub-code": c } });
      if (!r.ok) return;
      var d = await r.json();
      changes = d.changes || {};
      applyLists(L);
      if (L.forceUpdate) L.forceUpdate(); else if (L.setState) L.setState({});
    } catch (e) {}
  }

  // 2. New customer on a logged call -> request to add it to the rep's list
  var SENT = "aq_hub_adds";
  function sent() { try { return JSON.parse(localStorage.getItem(SENT) || "{}"); } catch (e) { return {}; } }
  async function requestAdd(L, rec) {
    var k = repKey(rec.rep) + "|" + L._acctKey(rec.customer), s = sent();
    if (s[k]) return;
    if (L.repAcctKeys(rec.rep).has(L._acctKey(rec.customer))) return;
    try {
      var r = await fetch(HUB + "/api/account-flags", { method: "POST", headers: { "x-hub-code": code(), "content-type": "application/json" },
        body: JSON.stringify({ action: "add", rep: rec.rep, account: rec.customer, contact: rec.contactName || "", email: rec.contactEmail || "", phone: rec.contactPhone || "", source: "Call Log", callDate: String(rec.date || "").slice(0, 20) }) });
      var d = await r.json().catch(function () { return {}; });
      if (!r.ok) return;
      s[k] = Date.now(); try { localStorage.setItem(SENT, JSON.stringify(s)); } catch (e) {}
      if (d.pending && L.toast) setTimeout(function () { L.toast(rec.customer + " sent to Fred to add to your account list."); }, 3000);
    } catch (e) {}
  }
  // Call date in ms: "2026-11-16", "11/16/2026" or a Date; 0 when it can't be read
  function callDate(rec) {
    var v = rec && (rec.date || rec.callDate || rec.loggedAt || rec.ts);
    if (!v) return 0;
    if (typeof v === "number") return v > 1e11 ? v : 0;
    var m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})/) || null;
    if (m) return new Date(+m[1], +m[2] - 1, +m[3]).getTime();
    m = String(v).match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
    if (m) return new Date(+m[3] < 100 ? 2000 + +m[3] : +m[3], +m[1] - 1, +m[2]).getTime();
    var t = Date.parse(v); return isNaN(t) ? 0 : t;
  }
  function hookPublish(L) {
    if (L.__hubPublish) return;
    var orig = L.publishCalls;
    L.__hubPublish = true;
    L.publishCalls = function (list) {
      var res = orig.apply(this, arguments);
      // Only a call being logged right now (one record at a time). The app also re-sends every stored call
      // when it opens and on imports; those are old calls, not new customers, so they never go to Fred.
      try {
        if (Array.isArray(list) && list.length === 1) {
          var rec = list[0], d = callDate(rec);
          if (rec && !rec.deleted && /^yes$/i.test(rec.isNew || "") && rec.customer && rec.rep && d && Date.now() - d < 14 * 864e5) requestAdd(L, rec);
        }
      } catch (e) {}
      return res;
    };
  }

  // 3. Customer picker: no call in 90+ days, and flagged as not the rep's
  function hookPicker(L) {
    if (L.__hubPicker) return;
    var orig = L.ncCustomerPicker;
    L.__hubPicker = true;
    L.ncCustomerPicker = function () {
      var out = orig.apply(this, arguments);
      try {
        var rep = L.normalizeRep(L.state.nc_rep || ""); if (!rep || !out || !out.ncCustMatches) return out;
        var last = {}, pend = new Set();
        (L._callsFull || L.state.calls || []).forEach(function (c) {
          if (!c || c.deleted || L.normalizeRep(c.rep || "") !== rep) return;
          var m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(String(c.date || "")); // the call date, not when it was typed in
          var t = m ? Date.UTC(+m[3], +m[1] - 1, +m[2]) : (L.callLoggedTs ? L.callLoggedTs(c) : 0), k = L._acctKey(c.customer);
          if (t && t > (last[k] || 0)) last[k] = t;
        });
        Object.keys(changes || {}).forEach(function (r) { if (repKey(r) === repKey(rep)) (changes[r].pending || []).forEach(function (n) { pend.add(L._acctKey(n)); }); });
        out.ncCustMatches = out.ncCustMatches.map(function (m) {
          var k = L._acctKey(m.name), t = last[k], bits = [];
          if (pend.has(k)) bits.push("Flagged: not your account, waiting for Fred");
          if (L.repAcctKeys(rep).has(k)) {
            if (!t) bits.push("No call logged yet");
            else if ((Date.now() - t) / DAY >= QUIET) bits.push("No call in " + Math.floor((Date.now() - t) / DAY) + " days");
          }
          return bits.length ? Object.assign({}, m, { sub: bits.join(" · ") + (m.sub && m.sub.trim() ? " · " + m.sub : "") }) : m;
        });
      } catch (e) {}
      return out;
    };
  }

  (async function boot() {
    for (var i = 0; i < 240; i++) {
      var L = logic();
      if (L && L.state && !L.state.accessGate && L._acctKey) {
        hookPublish(L); hookPicker(L);
        await sync(L, true);
        setInterval(function () { sync(L, false); }, 60000);
        return;
      }
      await sleep(500);
    }
  })();
})();
