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

// ---- UDF (ECMA-167 / OSTA UDF 1.0x–2.0x), used by hospital DVDs without an ISO 9660 part ----
const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const u64 = (b, o) => u32(b, o) + u32(b, o + 4) * 4294967296;
function udfName(raw) {
  if (!raw.length) return "";
  let s = "";
  if (raw[0] === 16) for (let i = 1; i + 1 < raw.length; i += 2) s += String.fromCharCode((raw[i] << 8) | raw[i + 1]);
  else for (let i = 1; i < raw.length; i++) s += String.fromCharCode(raw[i]);
  return s;
}
async function udfVolume(src, env) { // -> { parts: [partition start sector by partition ref], root: { lbn, part } }
  const avdp = await readRange(src, 256 * SECTOR, SECTOR, env);
  if (u16(avdp, 0) !== 2) throw new Error("no UDF anchor at sector 256");
  const vdsLen = u32(avdp, 16), vdsLoc = u32(avdp, 20);
  const vds = await readRange(src, vdsLoc * SECTOR, Math.min(vdsLen, 32 * SECTOR), env);
  const pdStart = {}; let lvd = null;
  for (let o = 0; o + SECTOR <= vds.length; o += SECTOR) {
    const tag = u16(vds, o);
    if (tag === 5) pdStart[u16(vds, o + 22)] = u32(vds, o + 188);
    if (tag === 6 && !lvd) lvd = vds.subarray(o, o + SECTOR);
    if (tag === 8) break;
  }
  if (!lvd) throw new Error("UDF: no logical volume descriptor");
  if (u32(lvd, 212) !== SECTOR) throw new Error("UDF: unsupported block size " + u32(lvd, 212));
  const nMaps = u32(lvd, 268), parts = [];
  for (let i = 0, o = 440; i < nMaps && o < lvd.length; i++) {
    const type = lvd[o], len = lvd[o + 1];
    if (type !== 1) throw new Error("UDF: this DVD uses a metadata/virtual partition (UDF 2.5+), not supported yet");
    parts.push(pdStart[u16(lvd, o + 4)]);
    o += len;
  }
  const fsd = await readRange(src, (parts[u16(lvd, 256)] + u32(lvd, 252)) * SECTOR, SECTOR, env);
  if (u16(fsd, 0) !== 256) throw new Error("UDF: file set descriptor not found");
  return { parts, root: { lbn: u32(fsd, 404), part: u16(fsd, 408) } };
}
async function udfRead(src, env, vol, icb) { // read a file/dir via its File Entry -> { data, dir }
  const fe = await readRange(src, (vol.parts[icb.part] + icb.lbn) * SECTOR, SECTOR, env);
  const tag = u16(fe, 0);
  if (tag !== 261 && tag !== 266) throw new Error("UDF: bad file entry (tag " + tag + ")");
  const ext = tag === 266, fileType = fe[27], adType = u16(fe, 34) & 7;
  const size = u64(fe, 56), lEA = u32(fe, ext ? 208 : 168), lAD = u32(fe, ext ? 212 : 172), ad = (ext ? 216 : 176) + lEA;
  if (size > 64 * 1024 * 1024) throw new Error("UDF: file too large (" + size + " bytes)");
  if (adType === 3) return { data: fe.slice(ad, ad + size), dir: fileType === 4 };
  const out = new Uint8Array(size); let pos = 0;
  const step = adType === 0 ? 8 : 16;
  for (let o = ad; o + step <= ad + lAD && pos < size; o += step) {
    const len = u32(fe, o) & 0x3fffffff, kind = u32(fe, o) >>> 30;
    if (!len) break;
    const lbn = u32(fe, o + 4), part = adType === 0 ? icb.part : u16(fe, o + 8);
    const take = Math.min(len, size - pos);
    if (kind === 0) out.set(await readRange(src, (vol.parts[part] + lbn) * SECTOR, take, env), pos); // recorded extent
    pos += take;
  }
  return { data: out, dir: fileType === 4 };
}
function udfDir(data) {
  const out = [];
  for (let o = 0; o + 38 <= data.length;) {
    if (u16(data, o) !== 257) break;
    const chars = data[o + 18], lFI = data[o + 19], lIU = u16(data, o + 36);
    const icb = { lbn: u32(data, o + 24), part: u16(data, o + 28) };
    const name = udfName(data.subarray(o + 38 + lIU, o + 38 + lIU + lFI));
    o += (38 + lIU + lFI + 3) & ~3;
    if (chars & 0x08 || chars & 0x04 || !name) continue; // parent / deleted
    out.push({ name, dir: !!(chars & 0x02), ref: { udf: 1, lbn: icb.lbn, part: icb.part } });
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
      if (b.udf && b.ref) { const r = await udfRead(src, env, b.udf, b.ref); return json({ entries: udfDir(r.data) }); }
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
        if (!root) { // UDF-only DVD
          const vol = await udfVolume(src, env);
          const r = await udfRead(src, env, vol, vol.root);
          return json({ udf: vol, entries: udfDir(r.data) });
        }
        lba = root.lba; size = root.size;
      }
      const entries = parseDir(await readRange(src, lba * SECTOR, size, env), joliet);
      return json({ joliet, entries });
    }
    if (op === "peek") {
      if (b.udf && b.ref) return json(dicomInfo((await udfRead(src, env, b.udf, b.ref)).data.subarray(0, 65536)));
      return json(dicomInfo(await readRange(src, b.lba * SECTOR, Math.min(b.size, 65536), env)));
    }
    if (op === "copy") {
      if (!okPath(b.path) || b.path === "files.json") return json({ error: "bad path" }, 400);
      const key = src.scan + "/" + b.path;
      const have = await env.BUCKET.head(key);
      if (have && (b.udf ? have.size > 0 : have.size === b.size)) return json({ path: b.path, skipped: true });
      const data = b.udf ? (await udfRead(src, env, b.udf, b.ref)).data : await readRange(src, b.lba * SECTOR, b.size, env);
      await env.BUCKET.put(key, data, { httpMetadata: { contentType: /\.(jpe?g)$/i.test(b.path) ? "image/jpeg" : /\.pdf$/i.test(b.path) ? "application/pdf" : "application/dicom" } });
      return json({ path: b.path, bytes: data.length });
    }
    return json({ error: "unknown op" }, 400);
  } catch (e) { return json({ error: e.message }, 502); }
}
