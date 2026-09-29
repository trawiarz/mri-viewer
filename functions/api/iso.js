// Read a hospital CD image (.iso, ISO 9660) straight from Google Drive with byte-range requests
// and copy the files inside it into R2. The CD is registered in the D1 table `sources`.
// POST /api/iso?op=dir  { s, lba?, size?, joliet? } -> { joliet, entries: [{ name, dir, lba, size }] }
// POST /api/iso?op=peek { s, lba, size }            -> DICOM header info of one file (modality, date, ...)
// POST /api/iso?op=copy { s, path, lba, size }      -> copies one file into R2 at <s>/<path>
import { dicomInfo } from "./remote.js";

const SECTOR = 2048;
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
const okPath = p => p && p.length < 400 && !p.startsWith("/") && !p.split("/").some(x => !x || x === "." || x === "..");

async function readRange(src, start, length, env) {
  if (start < 0 || length <= 0 || start + length > src.size) throw new Error("range outside the CD image");
  const url = env && env.DRIVE_URL ? env.DRIVE_URL.replace("{id}", src.drive_id) // local testing only
    : "https://drive.usercontent.google.com/download?id=" + encodeURIComponent(src.drive_id) + "&export=download&confirm=t";
  for (let a = 0; ; a++) {
    const r = await fetch(url, { headers: { Range: "bytes=" + start + "-" + (start + length - 1) } });
    if (r.status === 206) {
      const buf = new Uint8Array(await r.arrayBuffer());
      if (buf.length !== length) throw new Error("got " + buf.length + " bytes, expected " + length);
      return buf;
    }
    const type = r.headers.get("content-type") || "";
    try { r.body && r.body.cancel(); } catch {}
    if (a < 2 && (r.status === 429 || r.status >= 500)) { await new Promise(res => setTimeout(res, 1000 * (a + 1))); continue; }
    if (/text\/html/i.test(type) || r.status === 403 || r.status === 404)
      throw new Error("Google Drive refused the download (HTTP " + r.status + "). Is the folder shared as 'Anyone with the link'?");
    throw new Error("Google Drive did not return a byte range (HTTP " + r.status + ", " + type + ")");
  }
}

function parseDir(u8, joliet) {
  const out = [];
  for (let p = 0; p < u8.length;) {
    const len = u8[p];
    if (!len) { p = (Math.floor(p / SECTOR) + 1) * SECTOR; continue; } // records don't cross sector ends
    const dv = new DataView(u8.buffer, u8.byteOffset + p, len);
    const lba = dv.getUint32(2, true), size = dv.getUint32(10, true), flags = u8[p + 25], nlen = u8[p + 32];
    const raw = u8.subarray(p + 33, p + 33 + nlen);
    p += len;
    if (nlen === 1 && (raw[0] === 0 || raw[0] === 1)) continue; // "." and ".."
    let name = "";
    if (joliet) for (let i = 0; i + 1 < raw.length; i += 2) name += String.fromCharCode((raw[i] << 8) | raw[i + 1]);
    else name = new TextDecoder("latin1").decode(raw);
    name = name.replace(/;\d+$/, "").replace(/\.$/, "");
    if (!name || flags & 1) continue; // hidden/associated files
    out.push({ name, dir: !!(flags & 2), lba, size });
  }
  return out;
}

export async function onRequestPost({ request, env }) {
  const op = new URL(request.url).searchParams.get("op");
  let b; try { b = await request.json(); } catch { return json({ error: "bad json" }, 400); }
  const src = await env.DB.prepare("SELECT * FROM sources WHERE scan = ?").bind(b.s || "").first();
  if (!src) return json({ error: "unknown CD" }, 404);
  try {
    if (op === "dir") {
      let joliet = !!b.joliet, lba = b.lba, size = b.size;
      if (lba == null) { // volume descriptors start at sector 16; prefer Joliet (long names) when present
        const vd = await readRange(src, 16 * SECTOR, 8 * SECTOR, env);
        let root = null;
        for (let i = 0; i < 8; i++) {
          const d = vd.subarray(i * SECTOR, (i + 1) * SECTOR);
          if (String.fromCharCode(...d.subarray(1, 6)) !== "CD001") continue;
          const rootRec = new DataView(d.buffer, d.byteOffset + 156, 34);
          const r = { lba: rootRec.getUint32(2, true), size: rootRec.getUint32(10, true) };
          if (d[0] === 1 && !root) root = r;
          if (d[0] === 2 && d[88] === 0x25 && d[89] === 0x2f && [0x40, 0x43, 0x45].includes(d[90])) { root = r; joliet = true; }
          if (d[0] === 255) break;
        }
        if (!root) throw new Error("this file is not a CD image (no ISO 9660 volume found)");
        lba = root.lba; size = root.size;
      }
      const entries = parseDir(await readRange(src, lba * SECTOR, size, env), joliet);
      return json({ joliet, entries });
    }
    if (op === "peek") return json(dicomInfo(await readRange(src, b.lba * SECTOR, Math.min(b.size, 65536), env)));
    if (op === "copy") {
      if (!okPath(b.path) || b.path === "files.json") return json({ error: "bad path" }, 400);
      const key = src.scan + "/" + b.path;
      const have = await env.BUCKET.head(key);
      if (have && have.size === b.size) return json({ path: b.path, skipped: true });
      const data = await readRange(src, b.lba * SECTOR, b.size, env);
      await env.BUCKET.put(key, data, { httpMetadata: { contentType: /\.(jpe?g)$/i.test(b.path) ? "image/jpeg" : /\.pdf$/i.test(b.path) ? "application/pdf" : "application/dicom" } });
      return json({ path: b.path, bytes: data.length });
    }
    return json({ error: "unknown op" }, 400);
  } catch (e) { return json({ error: e.message }, 502); }
}
