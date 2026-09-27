// Serves R2 objects from the "mri-viewer" bucket (binding BUCKET) at /files/<key>.
// Same origin as the viewer, so no CORS and no public bucket are needed.
export async function onRequest({ request, env, params }) {
  if (request.method !== "GET" && request.method !== "HEAD")
    return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  const key = (Array.isArray(params.path) ? params.path : [params.path]).filter(Boolean).join("/");
  if (!key || key.split("/").some(p => p === ".." || p === ".")) return new Response("Not found", { status: 404 });

  const obj = request.method === "HEAD"
    ? await env.BUCKET.head(key)
    : await env.BUCKET.get(key, { onlyIf: request.headers, range: request.headers });
  if (!obj) return new Response("Not found", { status: 404, headers: { "X-Robots-Tag": "noindex, nofollow", "Cache-Control": "no-store" } });

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("ETag", obj.httpEtag);
  headers.set("X-Robots-Tag", "noindex, nofollow");
  headers.set("Cache-Control", key.endsWith("/files.json") ? "private, max-age=60" : "private, max-age=86400");
  if (!headers.has("Content-Type"))
    headers.set("Content-Type", key.endsWith(".json") ? "application/json" : "application/dicom");

  if (request.method === "HEAD") { headers.set("Content-Length", String(obj.size)); return new Response(null, { headers }); }
  if (!("body" in obj)) return new Response(null, { status: 304, headers }); // precondition (If-None-Match) matched
  let status = 200;
  if (obj.range && request.headers.has("Range")) {
    const r = obj.range, off = r.offset ?? (r.suffix != null ? obj.size - r.suffix : 0);
    const len = r.length ?? (r.suffix != null ? r.suffix : obj.size - off);
    headers.set("Content-Range", `bytes ${off}-${off + len - 1}/${obj.size}`);
    status = 206;
  }
  return new Response(obj.body, { status, headers });
}
