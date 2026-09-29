// Starts / keeps alive the background downloader in sw.js and tells it which study is on screen.
(function () {
  if (!("serviceWorker" in navigator)) return;
  const q = new URLSearchParams(location.search);
  const onHome = !q.get("s");
  const priority = q.get("s") || null;
  try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (e) {}
  navigator.serviceWorker.register("sw.js").catch(() => {});
  let first = true;
  const ping = () => navigator.serviceWorker.ready.then(reg => {
    const w = reg.active; if (!w) return;
    w.postMessage({ type: "sync", priority, refresh: first && onHome }); first = false;
  }).catch(() => {});
  ping(); setInterval(ping, 20000);
  navigator.serviceWorker.addEventListener("message", e => {
    const d = e.data || {}; if (d.type !== "progress") return;
    const box = document.getElementById("saveInfo"); if (!box) return;
    const left = d.total - d.done;
    box.classList.toggle("hidden", d.finished && !box.dataset.shown);
    if (!d.finished) box.dataset.shown = "1";
    box.querySelector("b").textContent = d.finished ? "All scans saved on this device – they open instantly" : "Saving scans to this device: " + d.done + " / " + d.total;
    box.querySelector("i").style.width = (d.total ? d.done / d.total * 100 : 100) + "%";
    box.querySelector("small").textContent = d.finished ? "" : left + " files left – carries on while you look at the scans";
    if (d.finished && box.dataset.shown) setTimeout(() => box.classList.add("hidden"), 5000);
  });
})();
