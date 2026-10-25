/* Neon Riff service worker: precache the app shell (cache-first), never touch cross-origin (YouTube) requests. */
const VERSION = "v2";
const CACHE = "neon-riff-" + VERSION;
const ASSETS = [
  "./", "./index.html", "./manifest.webmanifest", "./css/style.css",
  "./js/analyzer.js", "./js/chart.js", "./js/youtube.js", "./js/game.js", "./js/app.js",
  "./icons/icon-192.png", "./icons/icon-512.png", "./icons/icon-maskable-512.png", "./icons/apple-touch-icon.png", "./icons/favicon-32.png",
];
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS.map((u) => new Request(u, { cache: "reload" })))).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith("neon-riff-") && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // YouTube etc. go straight to the network
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req).then((res) => {
      if (res && res.ok && res.type === "basic") { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => (req.mode === "navigate" ? caches.match("./index.html") : Response.error())))
  );
});
