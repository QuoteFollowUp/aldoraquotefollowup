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
  // Sign-in for the hub's hidden frame only (#hubjob=1&ac=CODE). Normal visits are untouched.
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
