/* Service worker: la pantalla funciona sin internet; los datos (/api) siempre van a la red.
   Al publicar cambios se auto-actualiza sin cerrar pestañas (skipWaiting + claim).
   Los archivos locales llevan ?v= para que al subir una versión el navegador no
   reutilice una copia vieja de la caché HTTP (Firebase sirve los .js con max-age). */
const CACHE = "cuymax-v45";
const SHELL = ["index.html", "cuymax-theme.css?v=45", "styles.css?v=45", "app.js?v=45",
  "auth-guard.js?v=45", "mock-data.js?v=45", "ia-asistente.js?v=45", "firestore-data.js?v=45",
  "manifiesto.webmanifest", "logo.png", "icono-192.png", "icono-512.png", "vendor/chart.umd.min.js"];

self.addEventListener("install", function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) {
    return Promise.all(SHELL.map(function (u) {
      // cache: "reload" obliga a bajar la versión nueva aunque haya una copia HTTP.
      return c.add(new Request(u, { cache: "reload" }));
    }));
  }).then(function () {
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

  // El HTML siempre se intenta traer de la red para que las versiones nuevas lleguen.
  if (e.request.mode === "navigate") {
    e.respondWith(
      fetch(e.request).then(function (r) {
        var copia = r.clone();
        caches.open(CACHE).then(function (c) { c.put("index.html", copia); });
        return r;
      }).catch(function () { return caches.match("index.html"); })
    );
    return;
  }

  e.respondWith(
    caches.match(e.request).then(function (r) { return r || fetch(e.request); })
  );
});
