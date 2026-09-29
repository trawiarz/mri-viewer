// Import a study straight from a OneDrive "anyone with the link" share (runs on Cloudflare).
// POST /api/remote?op=list  { link, itemId?, driveId? }  -> { root?, items: [{ id, name, folder, size, url, driveId }] }
// POST /api/remote?op=peek  { url }                      -> { modality, date, time, desc } read from a DICOM header
// POST /api/remote?op=copy  { url, s, path, size }       -> copies one file into R2 at <s>/<path>
// Finishing (files.json + home page entry) reuses POST /api/upload?finish=1.
const APP_ID = "5cbed6ac-a083-4e14-b191-b4ba07653de2"; // OneDrive web app id used for anonymous share access
const BASES = ["https://my.microsoftpersonalcontent.com/_api/v2.0", "https://api.onedrive.com/v1.0"];
const DL_HOSTS = [".microsoftpersonalcontent.com", ".sharepoint.com", ".1drv.com", ".svc.ms", ".live.com", ".onedrive.com"];
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

function shareLink(link) {
  const u = new URL(link);
  const redeem = u.searchParams.get("redeem"); // onedrive.live.com/?...&redeem=<base64 of the 1drv.ms link>
  if (redeem) return atob(redeem.replace(/-/g, "+").replace(/_/g, "/"));
  return link;
}
function shareId(link) {
  const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(shareLink(link))));
  return "u!" + b64.replace(/=+$/, "").replace(/\//g, "_").replace(/\+/g, "-");
}
async function badger() {
  try {
    const r = await fetch("https://api-badgerp.svc.ms/v1.0/token", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ appId: APP_ID }) });
    if (r.ok) return (await r.json()).token || null;
  } catch {}
  return null;
}
async function getJson(paths, tok) { // try each API base / path until one answers
  const errs = [];
  for (const base of BASES) for (const p of paths) {
    const url = p.startsWith("https://") ? p : base + p;
    const headers = { Accept: "application/json", Prefer: "autoredeem" };
    if (tok && url.includes("microsoftpersonalcontent")) headers.Authorization = "Badger " + tok;
    try {
      const r = await fetch(url, { headers });
      if (r.ok) return { j: await r.json(), base };
      errs.push(new URL(url).host + " " + r.status);
    } catch (e) { errs.push(new URL(url).host + " " + e.message); }
    if (p.startsWith("https://")) break;
  }
  throw new Error("OneDrive refused the request (" + errs.join("; ") + ")");
}
const item = (it, driveId) => ({
  id: it.id, name: it.name, folder: !!it.folder, size: it.size || 0,
  url: it["@content.downloadUrl"] || it["@microsoft.graph.downloadUrl"] || null,
  driveId: (it.parentReference && it.parentReference.driveId) || driveId,
});
function okHost(u) { try { const h = new URL(u).hostname; return new URL(u).protocol === "https:" && DL_HOSTS.some(d => h.endsWith(d)); } catch { return false; } }

export function dicomInfo(u8) { // a few text tags from the start of a DICOM file (explicit or implicit little endian)
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), out = {};
  const want = { "00080060": "modality", "00080020": "date", "00080030": "time", "00081030": "desc", "0008103e": "series" };
  const LONG = ["OB", "OW", "OF", "SQ", "UT", "UN", "OD", "OL", "UC", "UR", "OV", "SV", "UV"];
  let p = u8[128] === 68 && u8[129] === 73 && u8[130] === 67 && u8[131] === 77 ? 132 : 0;
  for (let n = 0; p + 8 <= u8.length && n < 3000; n++) {
    const g = dv.getUint16(p, true), e = dv.getUint16(p + 2, true);
    if (g > 0x0010) break;
    const vr = String.fromCharCode(u8[p + 4], u8[p + 5]);
    let len, hdr;
    if (/^[A-Z]{2}$/.test(vr)) { if (LONG.includes(vr)) { len = dv.getUint32(p + 8, true); hdr = 12; } else { len = dv.getUint16(p + 6, true); hdr = 8; } }
    else { len = dv.getUint32(p + 4, true); hdr = 8; }
    if (len === 0xFFFFFFFF) break;
    const key = g.toString(16).padStart(4, "0") + e.toString(16).padStart(4, "0");
    if (want[key]) out[want[key]] = new TextDecoder().decode(u8.subarray(p + hdr, p + hdr + len)).replace(/\0/g, "").trim();
    p += hdr + len;
  }
  return out;
}
const TYPES = { ".pdf": "application/pdf", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp", ".txt": "text/plain" };
const okId = id => /^[a-z0-9][a-z0-9-]{0,63}$/.test(id || "");
const okPath = p => p && p.length < 400 && !p.startsWith("/") && !p.split("/").some(x => !x || x === "." || x === "..");

export async function onRequestPost({ request, env }) {
  const op = new URL(request.url).searchParams.get("op");
  let b; try { b = await request.json(); } catch { return json({ error: "bad json" }, 400); }
  try {
    if (op === "list") {
      if (!b.link) return json({ error: "link required" }, 400);
      const sid = shareId(b.link), tok = await badger();
      let root = null, itemId = b.itemId, driveId = b.driveId;
      if (!itemId) {
        const { j } = await getJson(["/shares/" + sid + "/driveItem"], tok);
        root = { id: j.id, name: j.name, driveId: j.parentReference && j.parentReference.driveId };
        itemId = root.id; driveId = root.driveId;
      }
      const items = [];
      let paths = ["/shares/" + sid + "/items/" + itemId + "/children?$top=1000", "/drives/" + driveId + "/items/" + itemId + "/children?$top=1000", "/shares/" + sid + "/driveItem/children?$top=1000"];
      if (!b.itemId) paths = ["/shares/" + sid + "/driveItem/children?$top=1000"].concat(paths);
      let { j } = await getJson(paths, tok);
      for (let guard = 0; ; guard++) {
        (j.value || []).forEach(it => items.push(item(it, driveId)));
        const next = j["@odata.nextLink"];
        if (!next || guard > 50) break;
        ({ j } = await getJson([next], tok));
      }
      return json({ root, items });
    }
    if (op === "peek") {
      if (!okHost(b.url)) return json({ error: "not a OneDrive download link" }, 400);
      const r = await fetch(b.url, { headers: { Range: "bytes=0-65535" } });
      if (!r.ok) return json({ error: "HTTP " + r.status }, 502);
      return json(dicomInfo(new Uint8Array(await r.arrayBuffer())));
    }
    if (op === "copy") {
      if (!okHost(b.url) || !okId(b.s) || !okPath(b.path) || b.path === "files.json") return json({ error: "bad request" }, 400);
      const key = b.s + "/" + b.path;
      const have = await env.BUCKET.head(key);
      if (have && (!b.size || have.size === b.size)) return json({ path: b.path, skipped: true });
      const r = await fetch(b.url);
      if (!r.ok) return json({ error: "download HTTP " + r.status }, 502);
      const data = await r.arrayBuffer();
      if (b.size && data.byteLength !== b.size) return json({ error: "size " + data.byteLength + " != " + b.size }, 502);
      const ext = (b.path.match(/\.[^./]+$/) || [""])[0].toLowerCase();
      await env.BUCKET.put(key, data, { httpMetadata: { contentType: TYPES[ext] || "application/dicom" } });
      return json({ path: b.path, bytes: data.byteLength });
    }
    return json({ error: "unknown op" }, 400);
  } catch (e) { return json({ error: e.message }, 502); }
}
