import { getStore } from "@netlify/blobs";
import zlib from "node:zlib";

// Shared data store for the Aldora Quote Tracker.
//  GET  /api/data            -> returns the latest snapshot { quotes, log, updatedAt } (public, read-only)
//  POST /api/data            -> merges the posted { quotes?, log? } into the snapshot (requires x-sync-key)
// Reps' phones GET this on load; the admin's uploads POST to it. Same Netlify domain = no CORS issues.

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type,x-sync-key",
};

export default async (req) => {
  const store = getStore("aldora-data");

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
