import { getStore } from "@netlify/blobs";

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
    const key = req.headers.get("x-sync-key") || "";
    const expected = process.env.SYNC_KEY || "";
    if (!expected || key !== expected) {
      return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
        status: 401, headers: { "content-type": "application/json", ...CORS },
      });
    }
    let incoming = {};
    try { incoming = JSON.parse(await req.text() || "{}"); }
    catch (e) { return new Response(JSON.stringify({ ok: false, error: "bad json" }), { status: 400, headers: { "content-type": "application/json", ...CORS } }); }

    let existing = {};
    try { existing = JSON.parse((await store.get("snapshot", { type: "text" })) || "{}"); } catch (e) {}

    const merged = { ...existing };
    if (incoming.quotes !== undefined) merged.quotes = incoming.quotes;
    if (incoming.log !== undefined) merged.log = incoming.log;
    merged.updatedAt = Date.now();

    await store.set("snapshot", JSON.stringify(merged));
    return new Response(JSON.stringify({ ok: true, updatedAt: merged.updatedAt }), {
      headers: { "content-type": "application/json", ...CORS },
    });
  }

  return new Response("method not allowed", { status: 405, headers: CORS });
};

export const config = { path: "/api/data" };
