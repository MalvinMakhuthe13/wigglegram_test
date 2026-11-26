// Offline shell: clubs and venues often have no signal.
const CACHE = "wigglegram-v3";
const SHELL = ["./", "index.html", "styles.css", "core.js", "app.js", "manifest.webmanifest", "icon.svg"];
const CDN = ["https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js", "https://cdn.jsdelivr.net/npm/gif.js@0.2.0/dist/gif.js", "https://cdn.jsdelivr.net/npm/gif.js@0.2.0/dist/gif.worker.js"];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then(async (c) => {
      await c.addAll(SHELL);
      await Promise.all(CDN.map((u) => c.add(u).catch(() => undefined)));
    }),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const cacheable = url.origin === location.origin || url.hostname === "cdn.jsdelivr.net";
  if (!cacheable) return;
  // Network first for the app files so updates land; cache when offline.
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match("index.html"))),
  );
});
