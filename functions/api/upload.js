// Upload a study into R2 (behind the site password, see _middleware.js).
// PUT  /api/upload?s=<id>&path=<relative path>   body = file bytes
// POST /api/upload?s=<id>&finish=1                body = { type, title, date, files: [paths] }
//      -> writes <id>/files.json and adds/updates the entry in index.json
// DELETE /api/upload?s=<id>                        -> removes the entry from index.json (files stay)
import { readLibrary } from "./library.js";

const TYPES = ["mri", "ct", "xray", "docs"];
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
const okId = id => /^[a-z0-9][a-z0-9-]{0,63}$/.test(id || "");
const okPath = p => p && p.length < 400 && !p.startsWith("/") && !p.split("/").some(x => !x || x === "." || x === "..");

export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  const id = url.searchParams.get("s");
  if (!okId(id)) return json({ error: "bad study id" }, 400);

  if (request.method === "PUT") {
    const path = url.searchParams.get("path");
    if (!okPath(path) || path === "files.json") return json({ error: "bad path" }, 400);
    const type = request.headers.get("Content-Type") || "application/octet-stream";
    const obj = await env.BUCKET.put(id + "/" + path, request.body, { httpMetadata: { contentType: type } });
    return json({ path, size: obj.size });
  }

  if (request.method === "POST" && url.searchParams.has("finish")) {
    let body;
    try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
    const files = Array.isArray(body.files) ? body.files.filter(okPath) : [];
    if (!TYPES.includes(body.type) || !files.length) return json({ error: "type and files required" }, 400);
    const have = new Set(); // one listing instead of a HEAD per file (large CDs have 1000+ images)
    let cursor;
    do {
      const r = await env.BUCKET.list({ prefix: id + "/", cursor, limit: 1000 });
      r.objects.forEach(o => have.add(o.key));
      cursor = r.truncated ? r.cursor : undefined;
    } while (cursor);
    const missing = files.find(p => !have.has(id + "/" + p));
    if (missing) return json({ error: "missing file", path: missing }, 409);
    await env.BUCKET.put(id + "/files.json", JSON.stringify(files, null, 1), { httpMetadata: { contentType: "application/json" } });
    const lib = (await readLibrary(env.BUCKET)).filter(e => e.id !== id);
    lib.push({ id, type: body.type, title: String(body.title || id).slice(0, 120), date: String(body.date || "").slice(0, 10), count: files.length });
    await env.BUCKET.put("index.json", JSON.stringify(lib, null, 1), { httpMetadata: { contentType: "application/json" } });
    return json({ id, count: files.length });
  }

  if (request.method === "DELETE") {
    const lib = (await readLibrary(env.BUCKET)).filter(e => e.id !== id);
    await env.BUCKET.put("index.json", JSON.stringify(lib, null, 1), { httpMetadata: { contentType: "application/json" } });
    return json({ removed: id });
  }
  return json({ error: "method not allowed" }, 405);
}
