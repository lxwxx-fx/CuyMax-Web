/* Service worker: la app abre sin internet, con las tipografías y el SDK de
   Firebase servidos desde el propio dominio. Los datos van a Firestore, que
   guarda los cambios pendientes en el teléfono hasta que vuelve la señal.
   Al publicar cambios se auto-actualiza sin cerrar pestañas (skipWaiting + claim).
   Los archivos locales llevan ?v= para que al subir una versión el navegador no
   reutilice una copia vieja de la caché HTTP (Firebase sirve los .js con max-age). */
const CACHE = "cuymax-v53";
const SHELL = ["index.html", "cuymax-theme.css?v=53", "styles.css?v=53", "app.js?v=53",
  "auth-guard.js?v=53", "mock-data.js?v=53", "ia-asistente.js?v=53", "firestore-data.js?v=53",
  "manifiesto.webmanifest", "logo.png", "icono-180.png", "icono-192.png", "icono-512.png",
  "icono-192-maskable.png", "icono-512-maskable.png", "vendor/chart.umd.min.js",
  "vendor/firebase/firebase-app-compat.js?v=53",
  "vendor/firebase/firebase-auth-compat.js?v=53",
  "vendor/firebase/firebase-firestore-compat.js?v=53",
  "vendor/fonts/fuentes.css?v=53",
  "vendor/fonts/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa1ZL7.woff2",
  "vendor/fonts/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa25L7SUc.woff2",
  "vendor/fonts/LDIoaomQNQcsA88c7O9yZ4KMCoOg4Ko20yw.woff2",
  "vendor/fonts/LDIoaomQNQcsA88c7O9yZ4KMCoOg4Ko40yyygA.woff2"];

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

  // Imágenes: se guardan la primera vez que se ven. No van en la instalación
  // porque suman casi 1 MB y gastarían datos del teléfono de golpe.
  if (e.request.destination === "image" && url.origin === self.location.origin) {
    e.respondWith(
      caches.match(e.request).then(function (guardada) {
        if (guardada) { return guardada; }
        return fetch(e.request).then(function (resp) {
          if (resp && resp.status === 200) {
            var copia = resp.clone();
            caches.open(CACHE).then(function (c) { c.put(e.request, copia); });
          }
          return resp;
        });
      })
    );
    return;
  }

  e.respondWith(
    caches.match(e.request).then(function (r) { return r || fetch(e.request); })
  );
});

/* ---------- notificaciones (aviso diario al celular) ----------
   El Worker de Cloudflare manda el aviso a la hora que se eligió en Ajustes,
   con un resumen del trabajo pendiente. Al tocar la notificación se abre el
   panel en la sección Avisos. Si el aviso llega sin texto, se muestra uno
   genérico en vez de quedarse callado. */

self.addEventListener("push", function (e) {
  var texto = "Abre CuyMax para revisar los avisos de tu granja";
  var veniaDatos = false;
  try {
    if (e.data) {
      var dato = e.data.json();
      if (dato && dato.t) { texto = String(dato.t); veniaDatos = true; }
    }
  } catch (err) { /* texto plano u otra cosa: queda el genérico */ }

  /* Trazas de diagnóstico: qué llegó y cuándo (se leen desde la página). */
  try {
    caches.open("cuymax-diag").then(function (c) {
      c.put("ultimo-push", new Response(JSON.stringify({
        cuando: new Date().toISOString(), datos: veniaDatos, texto: texto
      })));
    });
  } catch (err2) { /* solo diagnóstico */ }

  var aviso = self.registration.showNotification("CuyMax · Avisos", {
    body: texto,
    icon: "icono-192.png",
    badge: "icono-192-maskable.png",
    tag: "cuymax-avisos",
    renotify: false,
    data: { url: "./?modo=real&tab=avisos" }
  });
  e.waitUntil(aviso.catch(function (err) {
    console.error("No se pudo mostrar la notificación:", err);
  }));
});

self.addEventListener("notificationclick", function (e) {
  e.notification.close();
  var destino = (e.notification.data && e.notification.data.url) || "./?modo=real";
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (lista) {
      for (var i = 0; i < lista.length; i++) {
        var c = lista[i];
        if (c.url.indexOf("/app/") >= 0) { return c.focus(); }
      }
      return self.clients.openWindow(destino);
    })
  );
});
