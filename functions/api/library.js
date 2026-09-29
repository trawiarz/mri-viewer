// The list of studies shown on the home page, stored in R2 as index.json.
// GET /api/library -> [{ id, type: "mri"|"ct"|"xray"|"docs", title, date, count }]
export const DEFAULT = [{ id: "scan1", type: "mri", title: "MRI head (brain)", date: "2026-09-25", count: 249 }];

export async function readLibrary(bucket) {
  const obj = await bucket.get("index.json");
  if (!obj) return DEFAULT.slice();
  try { const j = await obj.json(); return Array.isArray(j) ? j : DEFAULT.slice(); } catch { return DEFAULT.slice(); }
}

export async function onRequestGet({ env }) {
  const lib = await readLibrary(env.BUCKET);
  try { // CDs registered for import but not copied yet
    const { results } = await env.DB.prepare("SELECT scan, type, title, date FROM sources").all();
    for (const r of results) if (!lib.some(e => e.id === r.scan)) lib.push({ id: r.scan, type: r.type, title: r.title, date: r.date || "", count: 0, pending: true });
  } catch {}
  return new Response(JSON.stringify(lib), {
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
