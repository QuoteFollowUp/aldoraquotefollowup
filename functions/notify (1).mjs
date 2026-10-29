// Sends "Needs Immediate Attention" emails through Resend.
// Netlify env vars:
//   RESEND_API_KEY  your Resend API key (starts with re_)
//   RESEND_FROM     sender, e.g.  Aldora Call Log <alerts@aldoraglass.com>  (domain must be verified in Resend)
// Only @aldoraglass.com recipients are allowed, so the endpoint can't be used to email outsiders.

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST,OPTIONS",
  "access-control-allow-headers": "content-type,x-access-code",
};
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json" } });
const okAddr = (a) => /^[^\s@,;<>]+@aldoraglass\.com$/i.test(String(a || "").trim());

export default async (req) => {
  if (req.method === "OPTIONS") return new Response("", { status: 204, headers: CORS });
  if (req.method !== "POST") return json(405, { error: "POST only" });
  const key = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM;
  if (!key || !from) return json(503, { error: "Email not configured" });
  let b;
  try { b = await req.json(); } catch (e) { return json(400, { error: "Bad JSON" }); }
  const to = (Array.isArray(b.to) ? b.to : [b.to]).map((x) => String(x || "").trim()).filter(okAddr);
  const bcc = (Array.isArray(b.bcc) ? b.bcc : [b.bcc]).map((x) => String(x || "").trim()).filter(okAddr);
  if (!to.length) return json(400, { error: "No valid recipients" });
  const payload = {
    from, to, subject: String(b.subject || "Customer issue").slice(0, 200),
    text: String(b.text || "").slice(0, 20000),
    html: String(b.html || "").slice(0, 40000) || undefined,
  };
  if (bcc.length) payload.bcc = bcc;
  if (okAddr(b.replyTo)) payload.reply_to = String(b.replyTo).trim();
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: "Bearer " + key, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) return json(502, { error: out.message || "Resend error", status: r.status });
  return json(200, { ok: true, id: out.id });
};

export const config = { path: "/api/notify" };
