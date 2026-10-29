/* CuyMax — Guardia de autenticación (Firebase Auth).
   - Modo monitoreo (?modo=real): exige sesión y espera el token antes de cargar datos.
   - Modo local / demo: no bloquea; solo muestra quién está conectado si hay sesión.
   Además guarda el ID token en localStorage para que app.js lo envíe al backend. */
(function () {
  "use strict";

  function hayConfig() {
    return typeof FIREBASE_CONFIG !== "undefined" && FIREBASE_CONFIG &&
      (FIREBASE_CONFIG.apiKey || "").indexOf("PEGA-AQUI") !== 0;
  }

  var esReal = (typeof MODO_REAL !== "undefined" && MODO_REAL);
  var esDemo = (typeof MODO_DEMO !== "undefined" && MODO_DEMO);
  var sinSesion = esDemo ? "Modo demo · sin sesión" : "Modo local · sin sesión";

  var resolver = null;
  window.cuymaxAuthListo = new Promise(function (res) { resolver = res; });
  function marcarListo() {
    if (resolver) { resolver(); resolver = null; }
  }

  function limpiarSesion() {
    try {
      localStorage.removeItem("cuymax_token");
      localStorage.removeItem("cuymax_user");
    } catch (e) { /* sin almacenamiento */ }
  }

  function pintarUsuario(texto) {
    var el = document.getElementById("auth-user");
    if (el) { el.textContent = texto; }
  }

  function irLogin() {
    if (location.pathname.indexOf("login.html") >= 0) { return; }
    var volver = "";
    try {
      volver = "?next=" + encodeURIComponent(location.pathname + location.search);
    } catch (e) { volver = ""; }
    location.replace("../login.html" + volver);
  }

  var auth = null;
  if (hayConfig() && typeof firebase !== "undefined" && firebase.auth) {
    try {
      if (!firebase.apps || !firebase.apps.length) { firebase.initializeApp(FIREBASE_CONFIG); }
      auth = firebase.auth();
    } catch (e) { auth = null; }
  }

  window.cuymaxSalir = function () {
    if (auth) {
      auth.signOut().then(irLogin, irLogin);
    } else {
      limpiarSesion();
      location.href = "../login.html";
    }
  };

  /* ---------- Modo local / demo: nunca se exige login ---------- */
  if (!esReal) {
    marcarListo();
    if (!auth) {
      limpiarSesion();
      pintarUsuario(sinSesion);
      return;
    }
    auth.onAuthStateChanged(function (user) {
      if (!user) {
        limpiarSesion();
        pintarUsuario(sinSesion);
        return;
      }
      var nombre = user.displayName || user.email || "Sesión activa";
      try { localStorage.setItem("cuymax_user", nombre); } catch (e) { /* sin almacenamiento */ }
      pintarUsuario(nombre);
      user.getIdToken().then(function (t) {
        try { localStorage.setItem("cuymax_token", t); } catch (e) { /* sin almacenamiento */ }
      }).catch(function () { /* el backend local no necesita el token */ });
    });
    return;
  }

  /* ---------- Modo monitoreo: la sesión sí es obligatoria ---------- */
  if (!hayConfig() || !auth) {
    irLogin();
    return;
  }

  auth.onAuthStateChanged(function (user) {
    if (!user) {
      limpiarSesion();
      irLogin();
      return;
    }
    var nombre = user.displayName || user.email || "Sesión activa";
    try { localStorage.setItem("cuymax_user", nombre); } catch (e) { /* sin almacenamiento */ }
    pintarUsuario(nombre);
    user.getIdToken().then(function (t) {
      try { localStorage.setItem("cuymax_token", t); } catch (e) { /* sin almacenamiento */ }
    }).catch(function () {
      /* Si falla el token, Firestore dará el error concreto. */
    }).then(marcarListo);
  });
})();
