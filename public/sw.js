// Keeps every study on this device. Runs in the background across page changes: pages send
// { type: "sync", priority: <study id> } when they open (and every 20 s); this worker downloads all
// files in the order MRI → CT → X-ray → Documents, with the study being viewed first. Downloaded
// files are served from the device, so reopening anything is instant.
const CACHE = "scan-files-v1";
const ORDER = { mri: 0, ct: 1, xray: 2, docs: 3 };

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));

let studies = null;          // [{ id, type, urls: [pathname, ...] }] in download order
let priority = null;         // study id to fetch first
let run = null;              // the running download loop
const inflight = new Map();  // pathname -> Promise<Response copy>
let progress = { done: 0, total: 0, finished: false };

const isFile = u => u.pathname.startsWith("/files/") && !u.pathname.endsWith("/files.json");
const fileUrl = (id, p) => "/files/" + [id].concat(String(p).split("/")).map(encodeURIComponent).join("/");

async function fetchAndStore(path) { // resolves once the file is stored (or could not be)
  if (inflight.has(path)) return inflight.get(path);
  const job = (async () => {
    const cache = await caches.open(CACHE);
    if (await cache.match(path)) return;
    const res = await fetch(path, { credentials: "same-origin" });
    if (res.ok && res.status === 200) await cache.put(path, res);
  })();
  inflight.set(path, job);
  try { await job; } finally { inflight.delete(path); }
}

self.addEventListener("fetch", e => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin || !isFile(u)) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    let hit = await cache.match(u.pathname);
    if (hit) return hit;
    try { await fetchAndStore(u.pathname); hit = await cache.match(u.pathname); if (hit) return hit; } catch (err) {}
    return fetch(e.request);
  })());
});

async function loadStudies() {
  const r = await fetch("/api/library", { credentials: "same-origin", cache: "no-store" });
  if (!r.ok) throw new Error("library " + r.status);
  const lib = (await r.json()).filter(e => !e.pending && e.type in ORDER)
    .sort((a, b) => ORDER[a.type] - ORDER[b.type] || String(b.date).localeCompare(String(a.date)));
  const out = [];
  for (const e of lib) {
    try {
      const f = await fetch(fileUrl(e.id, "files.json"), { credentials: "same-origin", cache: "no-store" });
      if (!f.ok) continue;
      const j = await f.json();
      const paths = Array.isArray(j) ? j : (j && j.files) || [];
      out.push({ id: e.id, type: e.type, urls: paths.map(p => fileUrl(e.id, p && p.path || p)) });
    } catch (err) {}
  }
  return out;
}

async function broadcast() {
  const list = await self.clients.matchAll({ type: "window" });
  for (const c of list) c.postMessage({ type: "progress", ...progress });
}

function nextUrl(pending) {
  // the prioritised study first, otherwise MRI → CT → X-ray → Documents
  if (priority) { const i = pending.findIndex(x => x.id === priority); if (i >= 0) return pending.splice(i, 1)[0]; }
  return pending.shift();
}

async function loop() {
  if (!studies) studies = await loadStudies();
  const cache = await caches.open(CACHE);
  const pending = [];
  for (const s of studies) for (const u of s.urls) if (!(await cache.match(u))) pending.push({ id: s.id, url: u });
  const all = studies.reduce((n, s) => n + s.urls.length, 0);
  progress = { done: all - pending.length, total: all, finished: !pending.length };
  broadcast();
  let lastSent = 0;
  const worker = async () => {
    for (let job; (job = nextUrl(pending));) {
      try { await fetchAndStore(job.url); } catch (err) { await new Promise(r => setTimeout(r, 2000)); }
      progress.done++;
      if (Date.now() - lastSent > 500) { lastSent = Date.now(); broadcast(); }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  progress.finished = true;
  broadcast();
}

self.addEventListener("message", e => {
  const d = e.data || {};
  if (d.type !== "sync") return;
  if ("priority" in d) priority = d.priority || null;
  if (d.refresh) studies = null;
  if (!run) run = loop().catch(() => {}).finally(() => { run = null; });
  else broadcast();
  e.waitUntil(run); // keeps the worker alive while pages are open and pinging
});
