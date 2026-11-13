// Adds the Sales Hub bridge (/hub-bridge.js) to the Call Log app page on every load,
// so a new index.html from Claude Design never drops it.
export default async (request, context) => {
  const res = await context.next();
  const type = res.headers.get("content-type") || "";
  if (!type.includes("text/html")) return res;
  const html = await res.text();
  if (html.includes("/hub-bridge.js")) return new Response(html, { status: res.status, headers: res.headers });
  const out = html.replace(/<head([^>]*)>/i, (m) => m + '<script src="/hub-bridge.js"></script>');
  const headers = new Headers(res.headers);
  headers.delete("content-length");
  return new Response(out, { status: res.status, headers });
};

export const config = { path: ["/", "/index.html"] };
