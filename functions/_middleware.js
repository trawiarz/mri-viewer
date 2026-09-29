// Password gate for the whole site (pages, /files/..., /api/...). Password comes from the D1 table
// settings (k='site_password'), else the Pages secret SITE_PASSWORD; any username is accepted.
// Without either, nothing is served.
const NOINDEX = { "X-Robots-Tag": "noindex, nofollow, noarchive, nosnippet, noimageindex" };

function same(a, b) {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let d = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] || 0) ^ (y[i] || 0);
  return d === 0;
}

function password(request) {
  const h = request.headers.get("Authorization") || "";
  if (!h.startsWith("Basic ")) return null;
  try { const s = atob(h.slice(6)); return s.slice(s.indexOf(":") + 1); } catch { return null; }
}

let cached = null, cachedAt = 0;
async function sitePassword(env) {
  if (cached !== null && Date.now() - cachedAt < 60000) return cached;
  let v = "";
  try { const r = await env.DB.prepare("SELECT v FROM settings WHERE k = 'site_password'").first(); v = (r && r.v) || ""; } catch {}
  cached = v || env.SITE_PASSWORD || ""; cachedAt = Date.now();
  return cached;
}

export async function onRequest({ request, env, next }) {
  const url = new URL(request.url);
  if (url.pathname === "/robots.txt")
    return new Response("User-agent: *\nDisallow: /\n", { headers: { "Content-Type": "text/plain", ...NOINDEX } });

  const secret = await sitePassword(env);
  if (!secret) return new Response("Site locked: no password configured.", { status: 503, headers: { "Cache-Control": "no-store", ...NOINDEX } });

  const given = password(request);
  if (given === null || !same(given, secret))
    return new Response("Password required.", {
      status: 401,
      headers: { "WWW-Authenticate": 'Basic realm="Viewer", charset="UTF-8"', "Cache-Control": "no-store", ...NOINDEX },
    });

  const res = await next();
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(NOINDEX)) out.headers.set(k, v);
  out.headers.set("Referrer-Policy", "no-referrer");
  return out;
}
