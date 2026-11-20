import { getStore } from "@netlify/blobs";
import zlib from "node:zlib";

// Shared data store for the Aldora Quote Tracker.
//  GET  /api/data            -> returns the latest snapshot { quotes, log, updatedAt } (public, read-only)
//  POST /api/data            -> merges the posted { quotes?, log? } into the snapshot (requires x-sync-key)
// Reps' phones GET this on load; the admin's uploads POST to it. Same Netlify domain = no CORS issues.

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type,x-sync-key,x-access-code,x-encoding",
};

// ---- Personal access codes ----
// REP_ACCESS_CODES (Netlify env var) = JSON map of code -> who:
//   "first-last"        a rep: sees only their own calls, quotes and scorecard
//   "@branch:louisville" a branch manager: sees that branch's reps
//   "@view" / "@all"    ownership: sees everything
// Login is only enforced when LOGIN_REQUIRED is set to 1/true. Until then the app works as before.
const loginRequired = () => /^(1|true|yes|on)$/i.test(String(process.env.LOGIN_REQUIRED || "").trim());
const codeMap = () => {
  const raw = process.env.REP_ACCESS_CODES || process.env.ACCESS_CODES || process.env.REP_CODES || "{}";
  try { const m = JSON.parse(raw); return m && typeof m === "object" ? m : {}; } catch (e) { return {}; }
};
const titleName = (slug) => String(slug).split(/[-_\s]+/).filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" ");
const whoIs = (req) => {
  // Dashes and spaces don't matter: "VCDR-TDMR", "vcdrtdmr" and "VCDR TDMR" all match.
  const norm = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const code = norm(req.headers.get("x-access-code"));
  if (!code) return null;
  const m = codeMap();
  const hit = Object.keys(m).find((k) => norm(k) === code);
  if (!hit) return null;
  return parseWho(m[hit]);
};
const parseWho = (raw) => {
  const v = String(raw || "").trim();
  if (!v) return null;
  // "@all" / "@all:first-last" = everything;  "@branch:louisville" or "@branch:louisville:first-last" = one branch
  const a = v.match(/^@(view|all|owner|ownership|admin)(?::(.+))?$/i);
  if (a) return { role: "all", label: a[2] ? titleName(a[2]) : "Ownership" };
  // "@reps:ben-gless+other-rep:manager-name" = a manager who sees only the listed reps
  const t = v.match(/^@reps:([^:]+)(?::(.+))?$/i);
  if (t) { const reps = t[1].split("+").map(s => titleName(s.trim())).filter(Boolean);
    return { role: "team", reps, label: (t[2] ? titleName(t[2]) + " · " : "") + reps.join(", ") }; }
  const b = v.match(/^@branch:([^:]+)(?::(.+))?$/i);
  if (b) return { role: "branch", branch: b[1].trim().toLowerCase().replace(/-/g, " "), label: (b[2] ? titleName(b[2]) + " · " : "") + titleName(b[1]) };
  return { role: "rep", rep: titleName(v), label: titleName(v) };
};

// ---- Customer name fixes ----
// Two different companies share a name. Christian Kelley's customer is "Riverside Glass & Mirror" (no LLC).
// "Riverside Glass & Mirror, LLC" is Michael Eidson's account in Kingston, GA. Christian's calls are renamed
// so they never land on the Georgia account. Applied to saved calls and to every call a phone sends.
const NAME_FIXES = [
  { rep: /christian|kelley/i, from: /^\s*riverside\s+glass\s*(?:&|and)\s*mirror\s*,?\s*llc\.?\s*$/i, to: "Riverside Glass & Mirror" },
  // "J & L Glass Inc" is Clarke Haas's. Christian's J&L is "J & L Glass LLC."
  { rep: /christian|kelley/i, from: /^\s*j\s*(?:&|and)?\s*l\s+glass\s*,?\s*(?:inc\.?)?\s*$/i, to: "J & L Glass LLC." },
  // Clarke's Rick's is in Savannah ("Rick's Glass, LLC."). "Ricks Glass Co" in Spartanburg is Zachary Mangum's.
  { rep: /clarke|chaas/i, from: /^\s*ricks?\s+glass\s*(?:co\.?|company)?\s*$/i, to: "Rick's Glass, LLC." },
  // Anthony's Capitol City is "Capitol City Glass, Inc. VA" (Richmond). "CAPITOL CITY GLASS INC" (Indianapolis) is Christian Kelley's.
  { rep: /anthony|aante|\bante\b/i, from: /^\s*capitol\s+city\s+glass\s*,?\s*(?:inc\.?)?\s*$/i, to: "Capitol City Glass, Inc. VA" },
];
const fixRecord = (r) => {
  if (!r || typeof r !== "object" || !r.customer) return r;
  const who = String(r.rep || "") + " " + String(r.email || "");
  for (const f of NAME_FIXES) if (f.rep.test(who) && f.from.test(String(r.customer))) return { ...r, customer: f.to };
  return r;
};
const FIX_FIELDS = ["calls", "liveLog", "liveQuotes"];
const fixLog = (log) => (log && Array.isArray(log.records) ? { ...log, records: log.records.map(fixRecord) } : log);

// ---- Usage log ----
// One record per person per day (Eastern time): how many times they opened each app, first/last time.
// Kept in its own blob so it never slows down the main snapshot. 400 days are kept.
const dayET = (ms) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
const logUsage = async (store, who, app) => {
  if (!who) return;
  const now = Date.now(), day = dayET(now);
  let u = {};
  try { u = JSON.parse((await store.get("usage", { type: "text" })) || "{}"); } catch (e) {}
  const days = (u.days && typeof u.days === "object") ? u.days : {};
  const key = who.label || who.rep || "Unknown";
  const today = days[day] || (days[day] = {});
  const rec = today[key] || (today[key] = { n: 0, first: now, last: now, role: who.role, apps: {} });
  rec.n++; rec.last = now; rec.role = who.role;
  const a = String(app || "quote-followup").slice(0, 40);
  rec.apps[a] = (rec.apps[a] || 0) + 1;
  const cutoff = dayET(now - 400 * 86400000);
  Object.keys(days).forEach((k) => { if (k < cutoff) delete days[k]; });
  await store.set("usage", JSON.stringify({ days }));
};
const isFred = (who) => !!who && who.role === "all" && /fred\s*haas/i.test(who.label || "");

export default async (req) => {
  const store = getStore({ name: "aldora-data", consistency: "strong" });
  const url = new URL(req.url);
  const who = whoIs(req);
  const required = loginRequired();
  const JSONH = { "content-type": "application/json", "cache-control": "no-store", ...CORS };

  // Usage ping: the app calls this once each time it's opened (other Aldora apps can call it too
  // with &app=their-name and the same x-access-code header).
  if (req.method === "GET" && url.searchParams.get("usage") === "open") {
    try { await logUsage(store, who, url.searchParams.get("app")); } catch (e) {}
    return new Response(JSON.stringify({ ok: !!who }), { headers: JSONH });
  }
  // Usage report: Fred only.
  if (req.method === "GET" && url.searchParams.get("usage") === "report") {
    if (!isFred(who)) return new Response(JSON.stringify({ ok: false, error: "forbidden" }), { status: 403, headers: JSONH });
    let u = {};
    try { u = JSON.parse((await store.get("usage", { type: "text" })) || "{}"); } catch (e) {}
    const from = url.searchParams.get("from") || "0000-00-00", to = url.searchParams.get("to") || "9999-99-99";
    const days = {};
    Object.entries((u.days || {})).forEach(([k, v]) => { if (k >= from && k <= to) days[k] = v; });
    const roster = Object.values(codeMap()).map(parseWho).filter(Boolean).map((w) => ({ label: w.label || w.rep, role: w.role }));
    return new Response(JSON.stringify({ ok: true, days, roster }), { headers: JSONH });
  }

  if (req.method === "GET" && url.searchParams.get("auth") === "check") {
    return new Response(JSON.stringify({ required, ok: !!who, ...(who || {}) }), {
      headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS },
    });
  }
  if (required && req.method !== "OPTIONS" && !who) {
    return new Response(JSON.stringify({ ok: false, error: "login-required" }), {
      status: 401, headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS },
    });
  }

  if (req.method === "OPTIONS") {
    return new Response("", { headers: CORS });
  }

  if (req.method === "GET") {
    let data = await store.get("snapshot", { type: "text" });
    // Rewrite saved calls once when a name fix applies, so every app reading the snapshot sees the fixed name
    try {
      if (data && /riverside\s+glass|j\s*&\s*l\s+glass|ricks?\s+glass|capitol\s+city/i.test(data)) {
        const snap = JSON.parse(data);
        let changed = false;
        const before = JSON.stringify(snap.log || null);
        snap.log = fixLog(snap.log);
        if (JSON.stringify(snap.log || null) !== before) changed = true;
        // Calls, live follow-ups and verbal quotes are saved in their own lists
        for (const f of FIX_FIELDS) if (Array.isArray(snap[f])) {
          snap[f] = snap[f].map((r) => { const n = fixRecord(r); if (n !== r) changed = true; return n; });
        }
        if (changed) { data = JSON.stringify(snap); await store.set("snapshot", data); }
      }
    } catch (e) {}
    return new Response(data || JSON.stringify({ quotes: null, log: null, updatedAt: 0 }), {
      headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS },
    });
  }

  if (req.method === "POST") {
    const key = (req.headers.get("x-sync-key") || "").trim();
    const expected = (process.env.SYNC_KEY || process.env.sync_key || process.env.Sync_Key || "").trim();
    if (!expected || key !== expected) {
      return new Response(JSON.stringify({ ok: false, error: "unauthorized", hasEnv: !!expected }), {
        status: 401, headers: { "content-type": "application/json", ...CORS },
      });
    }
    let incoming = {};
    try {
      let raw;
      if ((req.headers.get("x-encoding") || "") === "gzip") {
        const buf = Buffer.from(await req.arrayBuffer());
        raw = zlib.gunzipSync(buf).toString("utf-8");
      } else {
        raw = await req.text();
      }
      incoming = JSON.parse(raw || "{}");
    } catch (e) { return new Response(JSON.stringify({ ok: false, error: "bad json" }), { status: 400, headers: { "content-type": "application/json", ...CORS } }); }

    let existing = {};
    try { existing = JSON.parse((await store.get("snapshot", { type: "text" })) || "{}"); } catch (e) {}

    const merged = { ...existing };
    if (incoming.quotes !== undefined) merged.quotes = incoming.quotes;
    // Follow-up history only ever grows: a device with fewer records can't wipe out what others sent.
    // Clearing on purpose sends _meta "cleared".
    if (incoming.log !== undefined) {
      const cur = (existing.log && Array.isArray(existing.log.records)) ? existing.log.records.map(fixRecord) : [];
      const inc = (incoming.log && Array.isArray(incoming.log.records)) ? incoming.log.records.map(fixRecord) : [];
      if (incoming.log && incoming.log._meta === "cleared") merged.log = incoming.log;
      else if (incoming.log && incoming.log._replaceUpload === true) {
        // Closed Quotes upload cleanup: FeneVision close records ("Per upload") are replaced by the incoming set.
        // Rep-entered follow-ups are never dropped here; they are carried over and de-duped as usual.
        const isUp = (r) => /per upload/i.test(String(((r && r.answers) || {}).details || ""));
        const k = (r) => { const a = (r && r.answers) || {};
          const q = String((r && (r.quoteNo || r.quote)) || "").toUpperCase().replace(/[^A-Z0-9]/g, "") || String((r && r.customer) || "").toLowerCase();
          const n = String((r && r.notes) || a.notes || a.details || "").replace(/\s+/g, " ").trim().toLowerCase().slice(0, 80);
          return q + "|" + String(a.outcome || "").toLowerCase() + "|" + n; };
        const seen = new Set(), out = [];
        for (const r of [...inc, ...cur.filter((x) => !isUp(x))]) { if (!r) continue; const kk = k(r); if (seen.has(kk)) continue; seen.add(kk); out.push(r); }
        const { _replaceUpload, ...rest } = incoming.log;
        merged.log = { ...rest, records: out };
      }
      else {
        const k = (r) => { const a = (r && r.answers) || {};
          const q = String((r && (r.quoteNo || r.quote)) || "").toUpperCase().replace(/[^A-Z0-9]/g, "") || String((r && r.customer) || "").toLowerCase();
          const n = String((r && r.notes) || a.notes || a.details || "").replace(/\s+/g, " ").trim().toLowerCase().slice(0, 80);
          return q + "|" + String(a.outcome || "").toLowerCase() + "|" + n; };
        const seen = new Set(), out = [];
        for (const r of [...inc, ...cur]) { if (!r) continue; const kk = k(r); if (seen.has(kk)) continue; seen.add(kk); out.push(r); }
        merged.log = { ...(incoming.log || {}), records: out };
      }
    }
    if (incoming.marketIntel !== undefined) merged.marketIntel = incoming.marketIntel;
    if (incoming.salesData !== undefined) merged.salesData = incoming.salesData;
    // Rep flags (vacation / in-office weeks, new-rep status) — merge per sub-map so one device's
    // edit never erases another device's edit made since the last sync.
    if (incoming.flags && typeof incoming.flags === "object") {
      const curFlags = (merged.flags && typeof merged.flags === "object") ? merged.flags : {};
      const nextFlags = { ...curFlags };
      for (const sub of ["vacationWeeks", "officeWeeks", "newReps", "offDays"]) {
        if (incoming.flags[sub] && typeof incoming.flags[sub] === "object") {
          nextFlags[sub] = { ...(curFlags[sub] || {}), ...incoming.flags[sub] };
        }
      }
      merged.flags = nextFlags;
    }
    // Explicit key removal — a plain merge above can only add/overwrite, never delete a key.
    if (incoming.removeFlagKeys && typeof incoming.removeFlagKeys === "object") {
      const curFlags = (merged.flags && typeof merged.flags === "object") ? merged.flags : {};
      const nextFlags = { ...curFlags };
      for (const sub of ["vacationWeeks", "officeWeeks", "newReps", "offDays"]) {
        const keys = incoming.removeFlagKeys[sub];
        if (Array.isArray(keys) && keys.length) {
          const m = { ...(nextFlags[sub] || {}) };
          keys.forEach((k) => { delete m[k]; });
          nextFlags[sub] = m;
        }
      }
      merged.flags = nextFlags;
    }

    // Live appends from reps' phones — one record per uid. When the same uid comes in again
    // (an edit), the newer version replaces the old one. "Newer" = later editedAt/updatedAt/loggedAt.
    const stamp = (x) => Math.max(+(x && x.editedAt) || 0, +(x && x.updatedAt) || 0, +(x && x.deletedAt) || 0, +(x && x.loggedAt) || 0, +(x && x.at) || 0);
    const appendInto = (field, items, cap) => {
      if (!Array.isArray(items) || !items.length) return;
      const cur = Array.isArray(merged[field]) ? merged[field].slice() : [];
      const pos = new Map(); cur.forEach((x, i) => { if (x && x.uid) pos.set(x.uid, i); });
      for (let x of items) {
        if (!x || !x.uid) continue;
        if (FIX_FIELDS.includes(field)) x = fixRecord(x);
        if (pos.has(x.uid)) { const i = pos.get(x.uid); if (stamp(x) >= stamp(cur[i])) cur[i] = x; }
        else { pos.set(x.uid, cur.length); cur.push(x); }
      }
      let next = cur;
      if (cap && next.length > cap) next = next.slice(next.length - cap);
      merged[field] = next;
    };
    appendInto("liveLog", incoming.appendLog, 12000);
    appendInto("marketIntel", incoming.appendMarket, 6000);
    appendInto("liveQuotes", incoming.appendVerbal, 6000);
    appendInto("calls", incoming.appendCalls, 40000);
    appendInto("highFives", incoming.appendHighFives, 8000);
    // Likes — union/remove a single name on one High Five so concurrent likes from different
    // devices don't clobber each other (a whole-object replace would).
    if (Array.isArray(incoming.likeHighFives) && incoming.likeHighFives.length) {
      const cur = Array.isArray(merged.highFives) ? merged.highFives : [];
      merged.highFives = cur.map((h) => {
        if (!h || !h.uid) return h;
        let next = h;
        incoming.likeHighFives.forEach((op) => {
          if (!op || op.uid !== h.uid || !op.name) return;
          const likes = Array.isArray(next.likes) ? next.likes : [];
          const has = likes.some((n) => String(n).toLowerCase() === String(op.name).toLowerCase());
          if (op.on && !has) next = { ...next, likes: [...likes, op.name] };
          else if (!op.on && has) next = { ...next, likes: likes.filter((n) => String(n).toLowerCase() !== String(op.name).toLowerCase()) };
        });
        return next;
      });
    }
    // Edits to an existing High Five — replace in place by uid (appendInto skips known uids).
    // Only the post's own words change; likes, reactions and comments other people added are kept.
    if (Array.isArray(incoming.updateHighFives) && incoming.updateHighFives.length) {
      const cur = Array.isArray(merged.highFives) ? merged.highFives : [];
      const byUid = new Map(incoming.updateHighFives.filter((x) => x && x.uid).map((x) => [x.uid, x]));
      merged.highFives = cur.map((h) => {
        if (!h || !byUid.has(h.uid)) return h;
        const u = byUid.get(h.uid), keep = {};
        ["to", "what", "from", "editedAt"].forEach((k) => { if (k in u) keep[k] = u[k]; });
        return { ...h, ...keep };
      });
    }
    // Reactions (Nov 20 2026) — one name per emoji per High Five, added or taken off one at a time so people
    // reacting from different devices never undo each other. 👏 is the original Like, kept in h.likes.
    const HF_EMOJI = ["👏", "❤️", "🔥", "🎉", "🙌"];
    const sameName = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
    if (Array.isArray(incoming.reactHighFives) && incoming.reactHighFives.length) {
      const cur = Array.isArray(merged.highFives) ? merged.highFives : [];
      merged.highFives = cur.map((h) => {
        if (!h || !h.uid) return h;
        let next = h;
        incoming.reactHighFives.forEach((op) => {
          if (!op || op.uid !== h.uid || !op.name || !HF_EMOJI.includes(op.emoji)) return;
          const name = String(op.name).trim().slice(0, 60);
          if (op.emoji === "👏") {
            const likes = Array.isArray(next.likes) ? next.likes : [];
            const has = likes.some((n) => sameName(n, name));
            if (op.on && !has) next = { ...next, likes: [...likes, name] };
            else if (!op.on && has) next = { ...next, likes: likes.filter((n) => !sameName(n, name)) };
            return;
          }
          const R = { ...(next.reactions || {}) };
          const list = Array.isArray(R[op.emoji]) ? R[op.emoji] : [];
          const has = list.some((n) => sameName(n, name));
          if (op.on && !has) R[op.emoji] = [...list, name];
          else if (!op.on && has) R[op.emoji] = list.filter((n) => !sameName(n, name));
          else return;
          if (!R[op.emoji].length) delete R[op.emoji];
          next = { ...next, reactions: R };
        });
        return next;
      });
    }
    // Comments (Nov 20 2026) — short replies under a High Five. Added by their own uid; deleted ones leave a
    // tombstone so a device that still has the comment cached never brings it back.
    if ((Array.isArray(incoming.commentHighFives) && incoming.commentHighFives.length) ||
        (Array.isArray(incoming.deleteHfComments) && incoming.deleteHfComments.length)) {
      const adds = Array.isArray(incoming.commentHighFives) ? incoming.commentHighFives : [];
      const dels = Array.isArray(incoming.deleteHfComments) ? incoming.deleteHfComments : [];
      const cur = Array.isArray(merged.highFives) ? merged.highFives : [];
      merged.highFives = cur.map((h) => {
        if (!h || !h.uid) return h;
        const mineAdds = adds.filter((op) => op && op.uid === h.uid && op.comment && op.comment.uid);
        const mineDels = dels.filter((op) => op && op.uid === h.uid && op.cuid);
        if (!mineAdds.length && !mineDels.length) return h;
        const gone = new Set([...(Array.isArray(h.commentsGone) ? h.commentsGone : []), ...mineDels.map((op) => String(op.cuid))]);
        const list = (Array.isArray(h.comments) ? h.comments : []).filter((c) => c && !gone.has(c.uid));
        const have = new Set(list.map((c) => c.uid));
        mineAdds.forEach((op) => {
          const c = op.comment, cuid = String(c.uid).slice(0, 40);
          const text = String(c.text || "").replace(/\s+/g, " ").trim().slice(0, 280);
          if (!text || have.has(cuid) || gone.has(cuid)) return;
          have.add(cuid);
          list.push({ uid: cuid, name: String(c.name || "").trim().slice(0, 60), text, at: Number(c.at) || Date.now() });
        });
        return { ...h, comments: list.slice(-100), commentsGone: [...gone].slice(-300) };
      });
    }

    // Reminders — insert or replace by uid (newest edit wins), so check-offs sync across devices.
    if (Array.isArray(incoming.upsertReminders) && incoming.upsertReminders.length) {
      const cur = Array.isArray(merged.reminders) ? merged.reminders : [];
      const byUid = new Map(cur.filter((x) => x && x.uid).map((x) => [x.uid, x]));
      incoming.upsertReminders.forEach((r) => {
        if (!r || !r.uid) return;
        const p = byUid.get(r.uid);
        if (!p || (r.editedAt || r.createdAt || 0) >= (p.editedAt || p.createdAt || 0)) byUid.set(r.uid, r);
      });
      merged.reminders = [...byUid.values()].slice(-20000);
    }
    // Call attention-done keys (plain strings)
    if (Array.isArray(incoming.appendAttnDone) && incoming.appendAttnDone.length) {
      const cur = Array.isArray(merged.attnDoneKeys) ? merged.attnDoneKeys : [];
      merged.attnDoneKeys = [...new Set([...cur, ...incoming.appendAttnDone])].slice(-20000);
    }

    // Emailed-quote keys (plain strings) — accumulate as a de-duped set so no estimator is emailed twice.
    if (Array.isArray(incoming.appendEmailed) && incoming.appendEmailed.length) {
      const cur = Array.isArray(merged.emailedKeys) ? merged.emailedKeys : [];
      merged.emailedKeys = [...new Set([...cur, ...incoming.appendEmailed])].slice(-20000);
    }
    // Closed-in-Fenevision keys — add or remove (rep/estimator can toggle)
    if (Array.isArray(incoming.appendClosed) && incoming.appendClosed.length) {
      const cur = Array.isArray(merged.closedKeys) ? merged.closedKeys : [];
      merged.closedKeys = [...new Set([...cur, ...incoming.appendClosed])].slice(-60000);
    }
    if (Array.isArray(incoming.removeClosed) && incoming.removeClosed.length) {
      const rm = new Set(incoming.removeClosed);
      merged.closedKeys = (Array.isArray(merged.closedKeys) ? merged.closedKeys : []).filter(k => !rm.has(k));
      if (merged.closedDates && typeof merged.closedDates === "object") {
        incoming.removeClosed.forEach((k) => { delete merged.closedDates[k]; });
      }
    }
    // When each quote was marked closed — first write wins so the original date sticks
    if (incoming.setClosedDates && typeof incoming.setClosedDates === "object") {
      const cur = (merged.closedDates && typeof merged.closedDates === "object") ? merged.closedDates : {};
      for (const [k, v] of Object.entries(incoming.setClosedDates)) {
        if (typeof v === "string" && v && !cur[k]) cur[k] = v;
      }
      merged.closedDates = cur;
    }

    merged.updatedAt = Date.now();

    await store.set("snapshot", JSON.stringify(merged));
    return new Response(JSON.stringify({ ok: true, updatedAt: merged.updatedAt }), {
      headers: { "content-type": "application/json", ...CORS },
    });
  }

  return new Response("method not allowed", { status: 405, headers: CORS });
};

export const config = { path: "/api/data" };
