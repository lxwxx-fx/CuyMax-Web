/* Service worker: la pantalla funciona sin internet; los datos (/api) siempre van a la red.
   Al publicar cambios se auto-actualiza sin cerrar pestañas (skipWaiting + claim). */
const CACHE = "cuymax-v31";
const SHELL = ["./", "index.html", "cuymax-theme.css", "styles.css", "app.js", "auth-guard.js", "mock-data.js", "firestore-data.js",
  "manifiesto.webmanifest", "logo.png", "icono-192.png", "icono-512.png", "vendor/chart.umd.min.js"];

self.addEventListener("install", function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () {
    return self.skipWaiting();
  }));
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (nombres) {
      return Promise.all(nombres.map(function (n) {
        if (n !== CACHE) { return caches.delete(n); }
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (e) {
  var url = new URL(e.request.url);
  if (url.pathname.indexOf("/api/") >= 0) { return; }  // datos: solo red
  e.respondWith(
    caches.match(e.request).then(function (r) { return r || fetch(e.request); })
  );
});
