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
  const v = String(m[hit] || "").trim();
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

export default async (req) => {
  const store = getStore("aldora-data");
  const url = new URL(req.url);
  const who = whoIs(req);
  const required = loginRequired();

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
    const data = await store.get("snapshot", { type: "text" });
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
    if (incoming.log !== undefined) merged.log = incoming.log;
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

    // Live appends from reps' phones — accumulate, de-dupe by uid, keep newest.
    const appendInto = (field, items, cap) => {
      if (!Array.isArray(items) || !items.length) return;
      const cur = Array.isArray(merged[field]) ? merged[field] : [];
      const seen = new Set(cur.map((x) => x && x.uid).filter(Boolean));
      const add = items.filter((x) => x && x.uid && !seen.has(x.uid));
      let next = [...cur, ...add];
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
    if (Array.isArray(incoming.updateHighFives) && incoming.updateHighFives.length) {
      const cur = Array.isArray(merged.highFives) ? merged.highFives : [];
      const byUid = new Map(incoming.updateHighFives.filter((x) => x && x.uid).map((x) => [x.uid, x]));
      merged.highFives = cur.map((h) => (h && byUid.has(h.uid) ? { ...h, ...byUid.get(h.uid) } : h));
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
      merged.closedKeys = [...new Set([...cur, ...incoming.appendClosed])].slice(-20000);
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
