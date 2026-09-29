// One-time copy of the scan from the public Google Drive folder into R2 (runs on Cloudflare, no keys needed).
// GET  /api/import?s=scan1          -> progress { total, done, complete }
// POST /api/import?s=scan1&i=N      -> copy file N of the manifest
// POST /api/import?s=scan1&finish=1 -> write <scan>/files.json once every file is present
// Locked for good once <scan>/files.json exists. The file list (Drive ids) lives in the D1 table `files`.

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" } });

async function listKeys(bucket, prefix) {
  const keys = new Map();
  let cursor;
  do {
    const r = await bucket.list({ prefix, cursor, limit: 1000 });
    r.objects.forEach(o => keys.set(o.key, o.size));
    cursor = r.truncated ? r.cursor : undefined;
  } while (cursor);
  return keys;
}

async function download(env, id) {
  const urls = env.DRIVE_URL
    ? [env.DRIVE_URL.replace("{id}", id)]
    : ["https://drive.usercontent.google.com/download?id=" + id + "&export=download&confirm=t",
       "https://drive.google.com/uc?export=download&confirm=t&id=" + id];
  let last = "";
  for (const u of urls) {
    try {
      const r = await fetch(u, { redirect: "follow" });
      if (r.ok && !/text\/html/i.test(r.headers.get("content-type") || "")) return new Uint8Array(await r.arrayBuffer());
      last = "HTTP " + r.status + " " + (r.headers.get("content-type") || "");
    } catch (e) { last = String(e); }
  }
  throw new Error("Drive download failed (" + last + ")");
}

export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  const scan = url.searchParams.get("s") || "scan1";
  const { results: files } = await env.DB.prepare("SELECT path, id, size FROM files WHERE scan = ? ORDER BY path").bind(scan).all();
  const listKey = scan + "/files.json";
  const complete = !!(await env.BUCKET.head(listKey));
  if (!files.length) { // a CD image (.iso) registered in `sources` is imported by import.html via /api/iso
    const src = await env.DB.prepare("SELECT scan, type, title, date, kind FROM sources WHERE scan = ?").bind(scan).first();
    if (!src) return json({ error: "unknown scan" }, 404);
    return json(Object.assign({}, src, { complete }));
  }

  if (request.method === "GET") {
    const have = await listKeys(env.BUCKET, scan + "/");
    const done = files.filter(f => have.get(scan + "/" + f.path) === f.size).length;
    return json({ scan, total: files.length, done, complete });
  }
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
  if (complete) return json({ error: "already imported", complete: true }, 409);

  if (url.searchParams.has("finish")) {
    const have = await listKeys(env.BUCKET, scan + "/");
    const missing = files.filter(f => have.get(scan + "/" + f.path) !== f.size).map(f => f.path);
    if (missing.length) return json({ error: "files missing", missing }, 409);
    await env.BUCKET.put(listKey, JSON.stringify(files.map(f => f.path), null, 1), { httpMetadata: { contentType: "application/json" } });
    return json({ scan, total: files.length, complete: true });
  }

  const i = parseInt(url.searchParams.get("i"), 10);
  const f = files[i];
  if (!f) return json({ error: "bad index" }, 400);
  const key = scan + "/" + f.path;
  const existing = await env.BUCKET.head(key);
  if (existing && existing.size === f.size) return json({ i, path: f.path, skipped: true });
  let data;
  try { data = await download(env, f.id); }
  catch (e) { return json({ i, path: f.path, error: e.message }, 502); }
  if (data.length !== f.size) return json({ i, path: f.path, error: "size " + data.length + " != " + f.size }, 502);
  await env.BUCKET.put(key, data, { httpMetadata: { contentType: "application/dicom" } });
  return json({ i, path: f.path, bytes: data.length });
}
