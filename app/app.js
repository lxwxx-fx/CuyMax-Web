/* CuyMax PWA: consume la API central del mismo servidor (mismo origen). */
"use strict";

function cfg() {
  return {
    granja: parseInt(localStorage.getItem("cuymax_granja") || "1", 10),
    clave: localStorage.getItem("cuymax_clave") || ""
  };
}

function headers() {
  var h = { "Content-Type": "application/json" };
  var c = cfg();
  if (c.clave) { h["X-API-Key"] = c.clave; }
  try {
    var t = localStorage.getItem("cuymax_token");
    if (t) { h["Authorization"] = "Bearer " + t; }
  } catch (e) {}
  return h;
}

async function api(metodo, ruta, datos) {
  if (typeof MODO_DEMO !== "undefined" && MODO_DEMO && typeof apiDemo === "function") {
    return apiDemo(metodo, ruta, datos);
  }
  if (typeof MODO_REAL !== "undefined" && MODO_REAL && typeof apiReal === "function") {
    return apiReal(metodo, ruta, datos);
  }
  var r;
  try {
    r = await fetch("/api/" + ruta, {
      method: metodo,
      headers: headers(),
      body: datos ? JSON.stringify(datos) : undefined
    });
  } catch (e) {
    throw new Error("Sin conexión. Revisa tu internet e inténtalo de nuevo.");
  }
  var cuerpo;
  try { cuerpo = await r.json(); } catch (e) { cuerpo = {}; }
  if (!r.ok) { throw new Error((cuerpo && cuerpo.detail) || ("Error " + r.status)); }
  return cuerpo;
}

/* Modo demo: responde con MOCK sin tocar la red. Las escrituras actualizan
   los datos en memoria para que la demo se sienta real. */
function apiDemo(metodo, ruta, datos) {
  var base = ruta.split("?")[0];
  var partes = base.split("/");
  function lote(cod) {
    var l = MOCK.lotes.filter(function (x) { return x.codigo === String(cod).toUpperCase(); })[0];
    if (!l) { throw new Error("No existe la poza " + String(cod).toUpperCase()); }
    return l;
  }
  if (metodo === "GET" && base === "partos-proximos") { return MOCK.partos; }
  if (metodo === "GET" && base === "lotes") { return MOCK.lotes; }
  if (metodo === "GET" && partes[0] === "lotes" && partes[2] === "pesajes") {
    return MOCK.pesos[partes[1].toUpperCase()] || [];
  }
  if (metodo === "GET" && partes[0] === "lotes" && partes.length === 2) { return lote(partes[1]); }
  if (metodo === "GET" && base === "resumen-economico") { return MOCK.economico; }
  if (metodo === "GET" && base === "evolucion") {
    return MOCK.evolucion.semanas.map(function (s, i) {
      return { etiqueta: s, poblacion: MOCK.evolucion.poblacion[i], ingresos: MOCK.evolucion.ingresos[i] };
    });
  }
  if (metodo === "GET" && base === "retiros") { return MOCK.retiros; }
  if (metodo === "GET" && base === "pozas") { return MOCK.pozas; }
  if (metodo === "GET" && base === "alertas") {
    return MOCK.avisos.filter(function (x) { return !x.enviada; });
  }
  if (metodo === "POST" && base === "alertas/generar") {
    return { creadas: 0, total: MOCK.avisos.filter(function (x) { return !x.enviada; }).length };
  }
  if (metodo === "POST" && base === "pesajes") {
    var l = lote(datos.lote);
    var p = { fecha: demoHaceDias(0), peso_promedio_g: datos.peso_g, animales_pesados: datos.animales_pesados || 10 };
    MOCK.pesos[l.codigo] = (MOCK.pesos[l.codigo] || []).concat([p]);
    l.ultimo_peso_g = datos.peso_g;
    return { ok: true, resumen: "peso de la poza " + l.codigo + ": " + datos.peso_g + " g", detalle: "" };
  }
  if (metodo === "POST" && base === "muertes") {
    var m = lote(datos.lote);
    if (datos.cantidad > m.vivos) { throw new Error("La poza " + m.codigo + " solo tiene " + m.vivos + " vivos."); }
    m.vivos -= datos.cantidad;
    m.muertos += datos.cantidad;
    return { ok: true, resumen: datos.cantidad + " muerte(s) en la poza " + m.codigo, detalle: "Quedan " + m.vivos + " vivos." };
  }
  if (metodo === "POST" && base === "alimento") {
    var a = lote(datos.lote);
    a.alimento_kg = Math.round((a.alimento_kg + datos.kg) * 100) / 100;
    return { ok: true, resumen: datos.kg + " kg de " + datos.tipo + " para la poza " + a.codigo, detalle: "" };
  }
  if (metodo === "POST" && base === "partos") {
    var h = (datos.hembra || "").toUpperCase();
    var idx = -1;
    for (var i = 0; i < MOCK.partos.length; i++) {
      if (MOCK.partos[i].hembra === h) { idx = i; break; }
    }
    if (!h || idx < 0) { throw new Error("No encuentro una hembra en gestación con ese dato."); }
    MOCK.partos.splice(idx, 1);
    return { ok: true, resumen: "parto registrado: " + datos.nacidos_vivos + " vivos y " + (datos.nacidos_muertos || 0) + " muertos", detalle: "" };
  }
  if (metodo === "POST" && base === "ingresos") {
    var li = lote(datos.lote);
    li.vivos += datos.cantidad;
    li.cantidad_inicial += datos.cantidad;
    return { ok: true, resumen: datos.cantidad + " cuyes ingresados a la poza " + li.codigo, detalle: "Ahora son " + li.cantidad_inicial + " en total." };
  }
  if (metodo === "POST" && base === "lotes") {
    var cod = String(datos.codigo || "").trim().toUpperCase();
    if (!cod) { throw new Error("Dime el código de la poza nueva."); }
    var ya = MOCK.lotes.some(function (x) { return x.codigo === cod; });
    if (ya) { throw new Error("La poza " + cod + " ya existe en esta granja."); }
    MOCK.lotes.push({ codigo: cod, nombre: "", etapa: datos.etapa, estado: "abierto",
      cantidad_inicial: datos.cantidad_inicial, vivos: datos.cantidad_inicial, muertos: 0,
      vendidos: 0, faenados: 0, alimento_kg: 0, ultimo_peso_g: null, mortalidad_pct: 0.0,
      edad_dias: 0, peso_objetivo_g: null });
    return { ok: true, resumen: "poza " + cod + " creada con " + datos.cantidad_inicial + " cuyes", detalle: "Ya puedes pesarla y registrar su alimento." };
  }
  if (metodo === "GET" && base === "granja") { return { id: 1, nombre: "Mi granja", precios: {} }; }
  if (metodo === "POST" && base === "granja") { return { ok: true, resumen: "Granja actualizada", detalle: "" }; }
  if (metodo === "POST" && base === "partos-proximos") {
    var hp = String(datos.hembra || "").trim().toUpperCase();
    if (!hp) { throw new Error("Dime el arete de la hembra (por ejemplo H003)."); }
    MOCK.partos.push({ hembra: hp, poza: String(datos.poza || "").toUpperCase(), dias_restantes: 14, fecha: datos.fecha_objetivo || demoEnDias(14) });
    return { ok: true, resumen: "parto de " + hp + " programado", detalle: "" };
  }
  if (metodo === "POST" && base === "destetes") {
    var hd = String(datos.hembra || "").trim().toUpperCase();
    var idxD = -1;
    for (var j = 0; j < MOCK.partos.length; j++) { if (MOCK.partos[j].hembra === hd) { idxD = j; break; } }
    if (idxD < 0) { throw new Error("No encuentro crías pendientes de destete para " + hd + "."); }
    var dest = String(datos.poza_destino || "").trim().toUpperCase();
    MOCK.partos.splice(idxD, 1);
    var loteDest = MOCK.lotes.filter(function (x) { return x.codigo === dest; })[0];
    if (loteDest) {
      loteDest.vivos += datos.cantidad;
      loteDest.cantidad_inicial += datos.cantidad;
    } else {
      MOCK.lotes.push({ codigo: dest, nombre: "", etapa: "recria", estado: "abierto",
        cantidad_inicial: datos.cantidad, vivos: datos.cantidad, muertos: 0, vendidos: 0,
        faenados: 0, alimento_kg: 0, ultimo_peso_g: null, mortalidad_pct: 0,
        edad_dias: 0, peso_objetivo_g: null });
    }
    return { ok: true, resumen: datos.cantidad + " crías destetadas a la poza " + dest, detalle: "" };
  }
  if (metodo === "POST" && base === "ventas") {
    var lv = lote(datos.lote);
    if (datos.cantidad > lv.vivos) { throw new Error("La poza " + lv.codigo + " solo tiene " + lv.vivos + " vivos."); }
    lv.vivos -= datos.cantidad;
    lv.vendidos += datos.cantidad;
    return { ok: true, resumen: datos.cantidad + " cuy(es) vendidos de la poza " + lv.codigo, detalle: "Quedan " + lv.vivos + " vivos." };
  }
  if (metodo === "POST" && base === "faenas") {
    var lf = lote(datos.lote);
    if (datos.cantidad > lf.vivos) { throw new Error("La poza " + lf.codigo + " solo tiene " + lf.vivos + " vivos."); }
    lf.vivos -= datos.cantidad;
    lf.faenados += datos.cantidad;
    return { ok: true, resumen: datos.cantidad + " cuy(es) faenados de la poza " + lf.codigo, detalle: "Quedan " + lf.vivos + " vivos." };
  }
  if (metodo === "POST" && base === "retiros") {
    var lr = lote(datos.lote);
    MOCK.retiros.push({ lote: lr.codigo, poza: null, producto: datos.producto,
      tipo: "tratamiento", dias_restantes: datos.dias, fecha_fin_retiro: demoEnDias(datos.dias) });
    return { ok: true, resumen: "retiro sanitario de " + datos.dias + " día(s) para la poza " + lr.codigo, detalle: "" };
  }
  if (metodo === "GET" && base === "alertas/atendidos") { return MOCK.avisosAtendidos || []; }
  if (metodo === "POST" && partes[0] === "alertas" && partes[2] === "atender") {
    var idAt = String(decodeURIComponent(partes[1]));
    MOCK.avisosAtendidos = MOCK.avisosAtendidos || [];
    for (var ia = 0; ia < MOCK.avisos.length; ia++) {
      if (String(MOCK.avisos[ia].id) !== idAt) { continue; }
      var av = MOCK.avisos.splice(ia, 1)[0];
      av.fecha = demoHaceDias(0);
      av.atendido_en = demoHaceDias(0);
      av.tipo = av.tipo || "otra";
      av.mensaje = av.mensaje || "";
      MOCK.avisosAtendidos.unshift(av);
      break;
    }
    return { ok: true };
  }
  if (metodo === "DELETE" && partes[0] === "alertas" && partes[2] === "atendido") {
    var idRest = String(decodeURIComponent(partes[1]));
    MOCK.avisosAtendidos = MOCK.avisosAtendidos || [];
    for (var ir = 0; ir < MOCK.avisosAtendidos.length; ir++) {
      if (String(MOCK.avisosAtendidos[ir].id) !== idRest) { continue; }
      MOCK.avisos.push(MOCK.avisosAtendidos.splice(ir, 1)[0]);
      break;
    }
    return { ok: true, resumen: "aviso devuelto a pendientes", detalle: "" };
  }
  if (metodo === "PUT" && partes[0] === "lotes" && partes.length === 2) {
    var le = lote(partes[1]);
    if (datos.nombre !== undefined) { le.nombre = String(datos.nombre || ""); }
    if (datos.etapa !== undefined) { le.etapa = datos.etapa; }
    if (datos.estado !== undefined) { le.estado = datos.estado; }
    if (datos.poza_id !== undefined) { le.poza_codigo = datos.poza_id || ""; }
    return { ok: true, resumen: "poza " + le.codigo + " actualizada", detalle: "" };
  }
  if (metodo === "DELETE" && partes[0] === "lotes" && partes.length === 2) {
    var lb = lote(partes[1]);
    if (lb.vivos > 0) { throw new Error("La poza " + lb.codigo + " todavía tiene " + lb.vivos + " cuy(es) vivos."); }
    MOCK.lotes.splice(MOCK.lotes.indexOf(lb), 1);
    return { ok: true, resumen: "poza " + lb.codigo + " borrada", detalle: "" };
  }
  if (metodo === "POST" && base === "pozas") {
    var pc = String(datos.codigo || "").trim().toUpperCase();
    if (!pc) { throw new Error("Dime el código de la ubicación (por ejemplo U-01)."); }
    if (MOCK.pozas.some(function (x) { return x.codigo === pc; })) { throw new Error("La ubicación " + pc + " ya existe en esta granja."); }
    MOCK.pozas.push({
      id: pc, codigo: pc, tipo: String(datos.tipo || ""),
      capacidad: datos.capacidad === "" || datos.capacidad == null ? null : Number(datos.capacidad)
    });
    return { ok: true, resumen: "ubicación " + pc + " agregada", detalle: "" };
  }
  if (metodo === "DELETE" && partes[0] === "pozas" && partes[1]) {
    var pid = decodeURIComponent(partes[1]);
    for (var ip = 0; ip < MOCK.pozas.length; ip++) {
      if (String(MOCK.pozas[ip].id) !== pid && MOCK.pozas[ip].codigo !== pid) { continue; }
      var pz = MOCK.pozas.splice(ip, 1)[0];
      MOCK.lotes.forEach(function (x) { if (x.poza_codigo === pz.codigo) { x.poza_codigo = ""; } });
      return { ok: true, resumen: "ubicación " + pz.codigo + " borrada", detalle: "" };
    }
    throw new Error("La ubicación no existe en esta granja.");
  }
  if (metodo === "DELETE" && partes[0] === "partos-proximos" && partes[1]) {
    var idpp = decodeURIComponent(partes[1]);
    for (var ipp = 0; ipp < MOCK.partos.length; ipp++) {
      if (String(MOCK.partos[ipp].id) !== idpp) { continue; }
      MOCK.partos.splice(ipp, 1);
      return { ok: true, resumen: "parto programado eliminado", detalle: "" };
    }
    throw new Error("Ese parto programado no existe.");
  }
  throw new Error("Sin conexión. Revisa tu internet e inténtalo de nuevo.");
}

function tarjeta(html) {
  return '<div class="tarjeta">' + html + "</div>";
}

function cuando(d) {
  if (d === 0) { return "hoy"; }
  if (d === 1) { return "en 1 día"; }
  if (d === -1) { return "atrasado 1 día"; }
  return d > 0 ? "en " + d + " días" : "atrasado " + (-d) + " días";
}

function soles(n) {
  return n === null || n === undefined ? "—" : "S/ " + Number(n).toFixed(2);
}

function animarNumero(id, desde, hacia, formato) {
  var el = document.getElementById(id);
  if (!el) { return; }
  desde = Number(desde) || 0; hacia = Number(hacia) || 0;
  function pintar(v) { el.textContent = formato ? formato(v) : Math.round(v); }
  /* Con la pestaña en segundo plano (o si se pide menos movimiento) no se
     anima: se escribe el valor final de una vez. Así los KPI nunca se quedan
     a medias ni en cero. */
  var reducido = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (document.hidden || reducido) { pintar(hacia); return; }
  var pasos = 20, paso = 0, terminado = false, cancelado = false;
  function frame() {
    if (cancelado) { return; }
    paso++;
    var t = Math.min(1, paso / pasos);
    pintar(desde + (hacia - desde) * t);
    if (t < 1) { requestAnimationFrame(frame); }
    else { terminado = true; }
  }
  frame();
  /* Red de seguridad: si el navegador congela la animación, fija el valor final. */
  setTimeout(function () {
    if (!terminado && !cancelado) { cancelado = true; pintar(hacia); }
  }, 600);
}

function md(t) {
  return escHtml(String(t || "")).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/\n/g, "<br>");
}

var ICONO_VACIO = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11h-9l-3 3v-3H4V5zm2 2v7h4v2l2-2h6V7H6z"/></svg>';

function vacio(texto) {
  return '<div class="tarjeta vacio">' + ICONO_VACIO + "<p>" + texto + "</p></div>";
}

function esqueleto(n) {
  var s = "";
  for (var i = 0; i < (n || 3); i++) { s += '<div class="skeleton"></div>'; }
  return s;
}

var calma = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ---------- pestañas y ajustes ---------- */
var TITULOS = { panel: "Panel", lote: "Poza", registrar: "Registrar", avisos: "Avisos", registros: "Últimos registros", asistente: "Asistente" };
function irA(t) {
  document.querySelectorAll(".nav-item").forEach(function (x) {
    x.classList.toggle("active", x.dataset.tab === t);
  });
  ["panel", "lote", "registrar", "avisos", "registros"].forEach(function (k) {
    var el = document.getElementById("tab-" + k);
    if (el) { el.classList.toggle("active", k === t); }
  });
  document.title = "CuyMax · " + (TITULOS[t] || "Panel");
  document.getElementById("crumb-actual").textContent = TITULOS[t] || "Panel";
  if (t === "panel") { cargarPanel(); }
  if (t === "lote") { cargarLotes(); }
  if (t === "registros") { cargarRegistros(); }
  if (t === "avisos") { cargarAvisos(); }
}
document.querySelectorAll(".nav-item").forEach(function (b) {
  b.addEventListener("click", function () {
    var t = b.dataset.tab;
    irA(t);
    // Control btn-nuevo visibility: hide on registrar tab, show on others
    // btn-nuevo was removed from HTML; keeping logic for future use
    if (t === "registrar") {
      // Ensure btn-registrar-mov is the only visible option on registrar tab
    var btnMov = document.getElementById("btn-registrar-mov");
    if (btnMov) btnMov.style.display = "inline-block";
    }
    if (t !== "registrar") {
      var btnMov = document.getElementById("btn-registrar-mov");
      if (btnMov) btnMov.style.display = "none";
    }
    if (t === "registrar") { abrirRegistrar(); }
  });
});
// Set initial display state for btn-registrar-movo based on initially active tab
window.addEventListener("DOMContentLoaded", function () {
  var navActivo = document.querySelector(".nav-item.active");
  if (navActivo) {
    var btnMov = document.getElementById("btn-registrar-mov");
    if (navActivo.dataset.tab === "registrar") {
      if (btnMov) btnMov.style.display = "inline-block";
    } else {
      if (btnMov) btnMov.style.display = "none";
    }
  }
});
document.getElementById("btn-campana").addEventListener("click", function () { irA("avisos"); });
document.getElementById("buscador").addEventListener("keydown", async function (ev) {
  if (ev.key !== "Enter") { return; }
  var q = ev.target.value.trim().toUpperCase();
  if (!q) { return; }
  try {
    await api("GET", "lotes/" + encodeURIComponent(q) + "?granja_id=" + cfg().granja);
    try { localStorage.setItem("cuymax_lote_activo", q); } catch (e) { /* sin almacenamiento */ }
    document.getElementById("sel-lote").value = q;
    irA("lote");
  } catch (e) { showToast("Sin resultados para " + ev.target.value.trim()); }
});

/* La granja guarda su nombre y sus precios en Firestore (modo real) o en la
   base local (modo instalado). En demo se muestran datos de ejemplo. */
async function cargarAjustesGranja() {
  try {
    var gj = await api("GET", "granja");
    var nom = document.getElementById("cfg-nombre");
    if (nom) { nom.value = gj.nombre || ""; }
    var p = gj.precios || {};
    var bal = document.getElementById("cfg-balanceado");
    var forr = document.getElementById("cfg-forraje");
    var cuy = document.getElementById("cfg-cuy");
    if (bal) { bal.value = p.balanceado_kg == null ? "" : p.balanceado_kg; }
    if (forr) { forr.value = p.forraje_kg == null ? "" : p.forraje_kg; }
    if (cuy) { cuy.value = p.cuy == null ? "" : p.cuy; }
    if (gj.nombre) {
      document.getElementById("granja-nombre").textContent = gj.nombre;
      if (!(typeof MODO_REAL !== "undefined" && MODO_REAL)) {
        document.getElementById("cfg-granja").value = cfg().granja;
      }
    }
  } catch (e) { /* sin conexión: se dejan los campos como están */ }
}

document.getElementById("btn-ajustes").addEventListener("click", function () {
  var s = document.getElementById("ajustes");
  s.classList.toggle("oculto");
  if (!(typeof MODO_REAL !== "undefined" && MODO_REAL)) {
    document.getElementById("cfg-granja").value = cfg().granja;
    document.getElementById("cfg-clave").value = cfg().clave;
  }
  cargarAjustesGranja();
});

document.getElementById("btn-cerrar-ajustes").addEventListener("click", function () {
  document.getElementById("ajustes").classList.add("oculto");
});

document.getElementById("cfg-guardar").addEventListener("click", async function () {
  var esReal = (typeof MODO_REAL !== "undefined" && MODO_REAL);
  var antes = cfg().granja;
  if (!esReal) {
    localStorage.setItem("cuymax_granja", document.getElementById("cfg-granja").value || "1");
    document.getElementById("granja-id").textContent = document.getElementById("cfg-granja").value || "1";
  }
  var clave = document.getElementById("cfg-clave").value.trim();
  if (clave) { localStorage.setItem("cuymax_clave", clave); }
  else { localStorage.removeItem("cuymax_clave"); }
  var nombre = document.getElementById("cfg-nombre").value.trim();
  if (nombre) { document.getElementById("granja-nombre").textContent = nombre; }
  try {
    await api("POST", "granja", {
      granja_id: cfg().granja,
      nombre: nombre,
      precios: {
        balanceado_kg: num(document.getElementById("cfg-balanceado").value),
        forraje_kg: num(document.getElementById("cfg-forraje").value),
        cuy: num(document.getElementById("cfg-cuy").value)
      }
    });
    showToast("Ajustes guardados", "ok");
  } catch (e) {
    showToast("No se pudieron guardar los ajustes: " + e.message, "err");
    return;
  }
  document.getElementById("ajustes").classList.add("oculto");
  if (!esReal && antes !== cfg().granja) {
    try { localStorage.removeItem("cuymax_lote_activo"); } catch (e) { /* sin almacenamiento */ }
  }
  await cargarAjustesGranja();
  cargarPanel();
  llenarSelectsLotes();
  generarAutomatico();
});

/* ---------- tema claro / oscuro ---------- */
var ICONO_SOL = '<svg viewBox="0 0 24 24" aria-hidden="true" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
var ICONO_LUNA = '<svg viewBox="0 0 24 24" aria-hidden="true" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';

function aplicarTema(oscuro) {
  if (oscuro) { document.documentElement.setAttribute("data-theme", "dark"); }
  else { document.documentElement.removeAttribute("data-theme"); }
  document.getElementById("btn-tema").innerHTML = oscuro ? ICONO_SOL : ICONO_LUNA;
  document.getElementById("btn-tema").setAttribute("aria-label", oscuro ? "Cambiar a tema claro" : "Cambiar a tema oscuro");
}

/* Modo monitoreo: cada cuenta es una granja propia, así que no hay selector
   de granja ni clave de API local que configurar. */
(function ajustesPorCuenta() {
  var real = (typeof MODO_REAL !== "undefined" && MODO_REAL);
  if (!real) { return; }
  var wrap = document.getElementById("cfg-granja-wrap");
  if (wrap) { wrap.classList.add("oculto"); }
  var meta = document.getElementById("granja-meta");
  if (meta) { meta.classList.add("oculto"); }
  var privada = document.getElementById("granja-privada");
  if (privada) { privada.classList.remove("oculto"); }
  var sub = document.getElementById("ajustes-sub");
  if (sub) { sub.textContent = "Nombre y precios de tu cuenta"; }
})();

(function insigniaDemo() {
  var demo = (typeof MODO_DEMO !== "undefined" && MODO_DEMO);
  var b = document.getElementById("badge-demo");
  if (b) { b.classList.toggle("oculto", !demo); }
  var real = (typeof MODO_REAL !== "undefined" && MODO_REAL);
  var r = document.getElementById("badge-real");
  if (r) { r.classList.toggle("oculto", !real); }
})();

(function temaInicial() {
  var guardado = null;
  try { guardado = localStorage.getItem("cuymax_tema"); } catch (e) { guardado = null; }
  aplicarTema(guardado === "dark");
})();

document.getElementById("btn-tema").addEventListener("click", function () {
  var oscuro = document.documentElement.getAttribute("data-theme") !== "dark";
  try { localStorage.setItem("cuymax_tema", oscuro ? "dark" : "light"); } catch (e) { /* sin almacenamiento */ }
  aplicarTema(oscuro);
  dibujarPanel();
  dibujarNacimientos();
  var nav = document.querySelector(".nav-item.active");
  if (nav && nav.dataset.tab === "lote") { verLote(); }
});/* ---------- exportar reportes (CSV) ---------- */
function csvCampo(v) {
  if (v === null || v === undefined) { return ""; }
  var s = String(v);
  return /[",;\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function csvFilas(filas) {
  return filas.map(function (f) {
    return f.map(csvCampo).join(";");
  }).join("\r\n");
}

function descargarCSV(nombre, bloques) {
  var partes = [];
  bloques.forEach(function (b, i) {
    if (i > 0) { partes.push(""); }
    if (b.titulo) { partes.push(csvCampo(b.titulo)); }
    partes.push(csvFilas([b.columnas].concat(b.filas || [])));
  });
  var contenido = "\ufeff" + partes.join("\r\n") + "\r\n";
  var url = URL.createObjectURL(new Blob([contenido], { type: "text/csv;charset=utf-8;" }));
  var a = document.createElement("a");
  a.href = url;
  a.download = nombre + "_" + hoyISO() + ".csv";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
}

async function exportarPanel() {
  var g = cfg().granja;
  try {
    var lotes = await api("GET", "lotes?granja_id=" + g);
    var eco = await api("GET", "resumen-economico?granja_id=" + g);
    var partos = await api("GET", "partos-proximos?granja_id=" + g);
    descargarCSV("reporte-panel-granja-" + g, [
      {
        titulo: "Pozas",
        columnas: ["Poza", "Etapa", "Estado", "Vivos", "Total", "Muertos", "Vendidos", "Faenados", "Alimento (kg)", "Último peso (g)", "Mortalidad (%)"],
        filas: lotes.map(function (l) {
          return [l.codigo, l.etapa, l.estado, l.vivos, l.cantidad_inicial, l.muertos || 0, l.vendidos || 0, l.faenados || 0, l.alimento_kg || 0, l.ultimo_peso_g, l.mortalidad_pct];
        })
      },
      {
        titulo: "Economía",
        columnas: ["Poza", "Estado", "Ingresos (S/)", "Costo total (S/)", "Margen (S/)"],
        filas: eco.map(function (e) {
          return [e.codigo, e.estado, e.ingresos, e.costo_total, e.margen];
        })
      },
      {
        titulo: "Partos próximos",
        columnas: ["Hembra", "Ubicación", "Plazo", "Fecha"],
        filas: partos.map(function (p) {
          return [p.hembra, p.poza || "", cuando(p.dias_restantes), p.fecha || ""];
        })
      }
    ]);
  } catch (e) { showToast("No se pudo exportar el panel: " + e.message, "err"); }
}

async function exportarLote(cod) {
  var g = cfg().granja;
  try {
    var l = await api("GET", "lotes/" + encodeURIComponent(cod) + "?granja_id=" + g);
    var h = await api("GET", "lotes/" + encodeURIComponent(cod) + "/pesajes?granja_id=" + g);
    var eco = await api("GET", "resumen-economico?granja_id=" + g);
    var e = eco.filter(function (x) { return x.codigo === cod; })[0] || {};
    descargarCSV("poza-" + cod, [
      {
        titulo: "Poza " + cod,
        columnas: ["Código", "Etapa", "Estado", "Cantidad inicial", "Vivos", "Muertos", "Vendidos", "Faenados", "Alimento (kg)", "Último peso (g)", "Mortalidad (%)", "Ingresos (S/)", "Costo total (S/)", "Margen (S/)"],
        filas: [[l.codigo, l.etapa, l.estado, l.cantidad_inicial, l.vivos, l.muertos || 0, l.vendidos || 0, l.faenados || 0, l.alimento_kg || 0, l.ultimo_peso_g, l.mortalidad_pct, e.ingresos, e.costo_total, e.margen]]
      },
      {
        titulo: "Pesajes",
        columnas: ["Fecha", "Peso promedio (g)", "Muestra"],
        filas: h.map(function (p) { return [p.fecha, Number(p.peso_promedio_g), p.animales_pesados || ""]; })
      }
    ]);
  } catch (err) { showToast("No se pudo exportar la poza: " + err.message, "err"); }
}


/* ---------- panel ---------- */
document.getElementById("btn-actualizar").addEventListener("click", async function () {
  var btn = this;
  btn.classList.add("girando");
  btn.disabled = true;
  try { await cargarPanel(); } finally {
    btn.classList.remove("girando");
    btn.disabled = false;
  }
});

/* ---------- KPI recordados entre visitas ----------
   Al abrir el panel se pinta al instante el último valor conocido de la cuenta
   y, en cuanto Firestore responde, se sustituye por el dato real. Así no se ven
   guiones durante los primeros segundos. */
function kpiClaveGuardado() {
  try {
    if (typeof MODO_REAL !== "undefined" && MODO_REAL && typeof fsGranja === "function") {
      return "cuymax_kpi_" + fsGranja();
    }
  } catch (e) { /* la sesión aún no está lista */ }
  return null;
}

function leerKpiGuardados() {
  var k = kpiClaveGuardado();
  if (!k) { return null; }
  try {
    var s = JSON.parse(localStorage.getItem(k) || "null");
    if (!s || !s.v || !s.t) { return null; }
    if (Date.now() - Number(s.t) > 7 * 86400000) { return null; }
    return s.v;
  } catch (e) { return null; }
}

function guardarKpi(valores) {
  var k = kpiClaveGuardado();
  if (!k) { return; }
  try { localStorage.setItem(k, JSON.stringify({ t: Date.now(), v: valores })); } catch (e) { /* sin almacenamiento */ }
}

function pintarKpiGuardados() {
  var v = leerKpiGuardados();
  if (!v) { return; }
  Object.keys(v).forEach(function (id) {
    var el = document.getElementById(id);
    if (el && v[id] !== null && v[id] !== undefined && v[id] !== "") { el.textContent = v[id]; }
  });
}

async function cargarPanel() {
  var g = cfg().granja;
  ["partos", "lotes", "economico", "retiros"].forEach(function (id) {
    document.getElementById(id).innerHTML = esqueleto(2);
  });
  pintarKpiGuardados();
  var kpiNuevos = {};
  /* Se lanzan todas las consultas a la vez: antes iban una detrás de otra y
     los KPI tardaban varios segundos en aparecer. */
  var pPartos = api("GET", "partos-proximos?granja_id=" + g);
  var pLotes = api("GET", "lotes?granja_id=" + g);
  var pEco = api("GET", "resumen-economico?granja_id=" + g);
  var pRet = api("GET", "retiros?granja_id=" + g);
  var pEvo = cargarEvo(5);
  var pNac = dibujarNacimientos();
  try {
    var partos = await pPartos;
    animarNumero("kpi-partos", document.getElementById("kpi-partos").textContent || 0, partos.length);
    kpiNuevos["kpi-partos"] = String(partos.length);
    document.getElementById("partos").innerHTML = partos.length
      ? tabla(["Hembra", "Ubicación", "Plazo", "Fecha", ""], partos.map(function (p) {
          var cls = p.dias_restantes < 0 ? "b-red" : (p.dias_restantes <= 3 ? "b-amber" : "b-green");
          return "<tr><td class=\"cell-strong\">" + p.hembra + "</td><td class=\"muted\">" + p.poza +
            "</td><td><span class=\"badge " + cls + "\">" + cuando(p.dias_restantes) + "</span></td>" +
            "<td class=\"muted\">" + (p.fecha || "") + "</td>" +
            '<td><button type="button" class="btn sm" data-borrar-prox="' + escHtml(p.id) + '">Quitar</button></td></tr>';
        }))
      : vacio("Sin partos próximos en los siguientes 10 días.");
    var lotes = await pLotes;
    var vivos = lotes.reduce(function (s, l) { return s + (l.vivos || 0); }, 0);
    animarNumero("kpi-vivos", document.getElementById("kpi-vivos").textContent || 0, vivos);
    kpiNuevos["kpi-vivos"] = String(vivos);
    document.getElementById("lotes").innerHTML = lotes.length
      ? tabla(["Poza", "Estado", "Vivos", "Ocupación"], lotes.map(function (l) {
          var pct = l.cantidad_inicial ? Math.round(100 * l.vivos / l.cantidad_inicial) : 0;
          var pc = pct < 40 ? "r" : (pct < 70 ? "a" : "");
          return "<tr><td class=\"cell-strong\">" + (l.nombre || l.codigo) + "</td>" +
            "<td><span class=\"badge " + (l.estado === "abierto" ? "b-green" : "b-gray") + "\">" + l.etapa + " · " + l.estado + "</span></td>" +
            "<td class=\"num\">" + l.vivos + " de " + l.cantidad_inicial + "</td>" +
            "<td><div class=\"prog " + pc + "\"><i style=\"width:" + pct + "%\"></i></div></td></tr>";
        }), [2])
      : vacio("Todavía no hay pozas registradas en esta granja.");
    var eco = await pEco;
    var margen = eco.reduce(function (s, e) { return s + (e.margen === null ? 0 : Number(e.margen)); }, 0);
    var hayNulos = eco.some(function (e) { return e.margen === null; });
    var elMargen = document.getElementById("kpi-margen");
    var margenPrevio = Number(String(elMargen.textContent || "").replace(/[^\d.-]/g, "")) || 0;
    if (eco.length) { animarNumero("kpi-margen", margenPrevio, margen, function (v) { return "S/ " + v.toFixed(2) + (hayNulos ? "*" : ""); }); }
    else { elMargen.textContent = "—"; }
    if (eco.length) { kpiNuevos["kpi-margen"] = "S/ " + margen.toFixed(2) + (hayNulos ? "*" : ""); }
    document.getElementById("economico").innerHTML = eco.length
      ? tabla(["Poza", "Estado", "Ingresos", "Costo", "Margen"], eco.map(function (e) {
          if (Number(e.ingresos) === 0 && e.costo_total !== null && Number(e.costo_total) === 0) {
            return "<tr><td class=\"cell-strong\">" + e.codigo + "</td>" +
              "<td><span class=\"badge " + (e.estado === "abierto" ? "b-green" : "b-gray") + "\">" + e.estado + "</span></td>" +
              '<td colspan="3" class="num muted">Sin movimientos</td></tr>';
          }
          var mc = (e.margen === null || e.margen === 0) ? "" : (e.margen < 0 ? "neg" : "pos");
          var mt = (e.margen === 0) ? "cero" : "";
          return "<tr><td class=\"cell-strong\">" + e.codigo + "</td>" +
            "<td><span class=\"badge " + (e.estado === "abierto" ? "b-green" : "b-gray") + "\">" + e.estado + (e.estado === "abierto" ? " · parcial" : "") + "</span></td>" +
            "<td class=\"num\">" + soles(e.ingresos) + "</td>" +
            "<td class=\"num\">" + (e.costo_total === null ? "s/v" : soles(e.costo_total)) + "</td>" +
            "<td class=\"num " + mc + " " + mt + "\">" + soles(e.margen) + "</td></tr>";
        }), [2, 3, 4])
      : vacio("Sin movimientos económicos todavía: registra ventas y costos.");
    var ret = await pRet;
    var enRetiro = {};
    ret.forEach(function (r) { enRetiro[r.lote || r.poza || "?"] = 1; });
    animarNumero("kpi-retiro", document.getElementById("kpi-retiro").textContent || 0, Object.keys(enRetiro).length);
    kpiNuevos["kpi-retiro"] = String(Object.keys(enRetiro).length);
    document.getElementById("retiros").innerHTML = ret.length
      ? tabla(["Poza / Ubicación", "Producto", "Quedan", "Fin"], ret.map(function (r) {
          var d = r.dias_restantes;
          var q = (d < 0)
            ? '<span class="badge b-green">Listo para vender</span>'
            : (d === 0
              ? '<span class="badge b-amber">Termina hoy</span>'
              : '<span class="badge b-amber">' + (d === 1 ? "Queda 1 día" : d + " días") + "</span>");
          return "<tr><td class=\"cell-strong\">" + (r.lote || r.poza || "") + "</td>" +
            "<td class=\"muted\">" + (r.producto || r.tipo) + "</td>" +
            "<td class=\"num\">" + q + "</td>" +
            "<td>" + fechaCortaSinAnio(r.fecha_fin_retiro) + "</td></tr>";
        }), [2])
      : vacio("Nada en retiro sanitario: se puede vender con normalidad.");
    document.getElementById("sub-retiro").textContent =
      ret.length ? "No vender todavía" : "Retiro cumplido · ya se puede vender";
    var evoD = await pEvo;
    var dv = (evoD && evoD.poblacion.length > 1 && evoD.poblacion[0] > 0)
      ? Math.round(100 * (evoD.poblacion[evoD.poblacion.length - 1] - evoD.poblacion[0]) / evoD.poblacion[0])
      : null;
    pintarDeltaValor("delta-vivos", dv, evoD ? "desde el " + evoD.semanas[0] : "");
    pintarDeltaTexto("delta-partos", "Próximos 10 días");
    pintarDeltaTexto("delta-retiro", "Ver en Poza", true);
    pintarDeltaTexto("delta-margen", "Acumulado de las pozas");
    dibujarPanel(evoD);
    await pNac;
    guardarKpi(kpiNuevos);
  } catch (e) { document.getElementById("partos").innerHTML = tarjeta("Error: " + e.message); }
}

function pintarDeltaValor(id, pct, sufijo) {
  var el = document.getElementById(id);
  if (pct === null || pct === undefined || isNaN(pct)) { sinPrevios(id); return; }
  var s = (pct > 0 ? "+" : "") + pct + "% " + (sufijo || "");
  el.className = "delta " + (pct > 0 ? "up" : (pct < 0 ? "down" : "flat"));
  el.textContent = (pct > 0 ? "▲ " : (pct < 0 ? "▼ " : "")) + s;
}

function pintarDeltaTexto(id, texto, clic) {
  var el = document.getElementById(id);
  el.className = "delta flat" + (clic ? " clic" : "");
  el.textContent = texto;
  el.onclick = clic ? function () { irA("lote"); } : null;
}

function sinPrevios(id) {
  var el = document.getElementById(id);
  el.className = "delta flat";
  el.textContent = "Sin datos previos";
}

function tabla(cab, filas, nums) {
  nums = nums || [];
  return '<div class="table-wrap"><table><thead><tr>' +
    cab.map(function (c, i) { return "<th" + (nums.indexOf(i) >= 0 ? ' class="num"' : "") + ">" + c + "</th>"; }).join("") +
    "</tr></thead><tbody>" + filas.join("") + "</tbody></table></div>";
}

/* ---------- gráfica de evolución del panel ---------- */
var graficaPanel = null;
var RANGOS = {
  1: { puntos: 1, texto: "Hoy" },
  30: { puntos: 5, texto: "Últimos 30 días" },
  365: { puntos: 53, texto: "Últimos 12 meses" }
};
var rangoEvo = 5;

async function cargarEvo(semanas) {
  if (typeof MODO_DEMO !== "undefined" && MODO_DEMO && typeof MOCK !== "undefined") {
    return { semanas: MOCK.evolucion.semanas, poblacion: MOCK.evolucion.poblacion, ingresos: MOCK.evolucion.ingresos };
  }
  try {
    var r = await api("GET", "evolucion?granja_id=" + cfg().granja + "&semanas=" + semanas);
    return { semanas: r.map(function (x) { return x.etiqueta; }),
             poblacion: r.map(function (x) { return x.poblacion; }),
             ingresos: r.map(function (x) { return Number(x.ingresos); }) };
  } catch (e) { return null; }
}

document.getElementById("seg-evo").addEventListener("click", function (ev) {
  var b = ev.target.closest ? ev.target.closest("button") : null;
  if (!b || !b.dataset.rango || !RANGOS[b.dataset.rango]) { return; }
  document.querySelectorAll("#seg-evo button").forEach(function (x) { x.classList.remove("on"); });
  b.classList.add("on");
  rangoEvo = RANGOS[b.dataset.rango].puntos;
  document.getElementById("sub-evo").textContent = RANGOS[b.dataset.rango].texto;
  dibujarPanel();
});
document.getElementById("btn-rapido").addEventListener("click", function () { abrirRegistrar(); });
document.getElementById("btn-exportar-panel").addEventListener("click", exportarPanel);
document.getElementById("btn-exportar-lote").addEventListener("click", function () {
  var cod = document.getElementById("sel-lote").value;
  if (cod) { exportarLote(cod); }
});

async function dibujarPanel(datos) {
  var cv = document.getElementById("grafica-panel");
  if (!cv) { return; }
  if (graficaPanel) { graficaPanel.destroy(); graficaPanel = null; }
  var evo = datos || await cargarEvo(rangoEvo);
  var ctx = cv.getContext("2d");
  if (typeof Chart === "undefined" || !evo) {
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.fillStyle = "#5D5347";
    ctx.font = "14px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("Evolución disponible en modo demo.", cv.width / 2, 60);
    return;
  }
  var oscuro = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  var tinta = oscuro ? "#F2EAE0" : "#2B2119";
  var cs = getComputedStyle(document.documentElement);
  var verde = (cs.getPropertyValue("--accent") || "#0E9F6E").trim();
  var ambar = (cs.getPropertyValue("--amber") || "#D98A0B").trim();
  var tinta = (cs.getPropertyValue("--text-2") || "#5A6673").trim();
  var rejilla = (cs.getPropertyValue("--border") || "#E6E9EE").trim();
  var g = ctx.createLinearGradient(0, 0, 0, 240);
  g.addColorStop(0, "rgba(74, 222, 128, .30)");
  g.addColorStop(1, "rgba(74, 222, 128, 0)");
  var n = Math.max(1, Math.min(rangoEvo, evo.semanas.length));
  var lab = evo.semanas.slice(-n), pob = evo.poblacion.slice(-n), ing = evo.ingresos.slice(-n);
  document.getElementById("leyenda-panel").innerHTML =
    '<span class="legend"><span><i style="background:' + verde + '"></i>Población</span>' +
    '<span><i style="background:' + ambar + '"></i>Ingresos</span></span>';
  graficaPanel = new Chart(cv, {
    type: "line",
    data: {
      labels: lab,
      datasets: [
        { label: "Cuyes vivos", data: pob, borderColor: verde,
          backgroundColor: g, fill: true, tension: .2, yAxisID: "y" },
        { label: "Ingresos (S/)", data: ing, borderColor: ambar,
          backgroundColor: "rgba(217, 138, 11, .10)", fill: true, tension: .2, yAxisID: "y1" }
      ]
    },
    options: {
      animation: calma ? false : { duration: 600 },
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: "#2B2119", titleFont: { size: 13 }, bodyFont: { size: 13 }, padding: 10,
          callbacks: {
            title: function () { return ""; },
            label: function (c) {
              var i = c.dataIndex, d = c.chart.data;
              return " " + d.labels[i] + " · " + d.datasets[0].data[i] + " cuyes · S/ " + d.datasets[1].data[i];
            }
          }
        }
      },
      scales: {
        x: { ticks: { color: tinta, font: { size: 12, weight: "500" } }, grid: { color: rejilla } },
        y: { min: 0, title: { display: true, text: "cuyes", color: tinta, font: { size: 12, weight: "500" } }, ticks: { color: tinta, font: { size: 12, weight: "500" } }, grid: { color: rejilla } },
        y1: { position: "right", title: { display: true, text: "S/", color: tinta, font: { size: 12, weight: "500" } }, ticks: { color: tinta, font: { size: 12, weight: "500" } }, grid: { drawOnChartArea: false } }
      }
    }
  });
}

/* ---------- gráfica de nacimientos y salidas ---------- */
var graficaNac = null;

async function dibujarNacimientos() {
  var cv = document.getElementById("grafica-nac");
  if (!cv) { return; }
  if (graficaNac) { graficaNac.destroy(); graficaNac = null; }
  var ns = null;
  if (typeof MODO_DEMO !== "undefined" && MODO_DEMO && typeof MOCK !== "undefined") {
    ns = MOCK.nacimientosSalidas;
  } else {
    try {
      var r = await api("GET", "nacimientos-salidas?granja_id=" + cfg().granja + "&meses=8");
      ns = { meses: r.map(function (x) { return etiqMes(x.mes); }),
             nacidas: r.map(function (x) { return x.nacidas; }),
             ventas: r.map(function (x) { return x.ventas; }) };
    } catch (e) { ns = null; }
  }
  var ctx = cv.getContext("2d");
  ctx.clearRect(0, 0, cv.width, cv.height);
  var conDatos = ns && ns.meses.filter(function (_, i) { return ns.nacidas[i] > 0 || ns.ventas[i] > 0; }).length;
  var sinDatos = (typeof Chart === "undefined" || !ns || conDatos < 3);
  cv.classList.toggle("oculto", sinDatos);
  if (cv.parentElement) { cv.parentElement.classList.toggle("oculto", sinDatos); }
  document.getElementById("vacio-nac").classList.toggle("oculto", !sinDatos);
  if (sinDatos) { return; }
  var cs = getComputedStyle(document.documentElement);
  var verde = (cs.getPropertyValue("--accent") || "#0E9F6E").trim();
  var azul = (cs.getPropertyValue("--blue") || "#3B7BF6").trim();
  var tinta = (cs.getPropertyValue("--text-2") || "#5A6673").trim();
  var rejilla = (cs.getPropertyValue("--border") || "#E6E9EE").trim();
  var g = ctx.createLinearGradient(0, 0, 0, 240);
  g.addColorStop(0, "rgba(74, 222, 128, .30)");
  g.addColorStop(1, "rgba(74, 222, 128, 0)");
  function serie(color) {
    var n = ns.meses.length;
    var fondo = [], radio = [];
    for (var i = 0; i < n; i++) {
      var ultimo = (i === n - 1);
      fondo.push(ultimo ? color : "rgba(0,0,0,0)");
      radio.push(ultimo ? 5 : 3.5);
    }
    return { fondo: fondo, radio: radio };
  }
  var estNac = serie(verde), estVen = serie(azul);
  document.getElementById("leyenda-nac").innerHTML =
    '<span class="legend"><span><i style="background:' + verde + '"></i>Crías nacidas</span>' +
    '<span><i style="background:' + azul + '"></i>Ventas</span></span>';
  graficaNac = new Chart(cv, {
    type: "line",
    data: {
      labels: ns.meses,
      datasets: [
        { label: "Crías nacidas", data: ns.nacidas, borderColor: verde,
          backgroundColor: g, fill: true, tension: .2, yAxisID: "y",
          pointBackgroundColor: estNac.fondo, pointBorderColor: verde, pointRadius: estNac.radio, pointBorderWidth: 2 },
        { label: "Ventas", data: ns.ventas, borderColor: azul,
          fill: false, tension: .2, yAxisID: "y",
          pointBackgroundColor: estVen.fondo, pointBorderColor: azul, pointRadius: estVen.radio, pointBorderWidth: 2 }
      ]
    },
    options: {
      animation: calma ? false : { duration: 600 },
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: "#2B2119", titleFont: { size: 13 }, bodyFont: { size: 13 }, padding: 10,
          callbacks: {
            title: function () { return ""; },
            label: function (c) {
              var i = c.dataIndex, d = c.chart.data;
              return " " + d.labels[i] + " · " + d.datasets[0].data[i] + " crías · " + d.datasets[1].data[i] + " ventas";
            }
          }
        }
      },
      scales: {
        x: { ticks: { color: tinta, font: { size: 12, weight: "500" }, maxTicksLimit: 8 }, grid: { color: rejilla, borderDash: [2, 4] } },
        y: { min: 0, ticks: { stepSize: 25, color: tinta, font: { size: 12, weight: "500" } }, grid: { color: rejilla, borderDash: [2, 4] } }
      }
    }
  });
}

/* ---------- ficha de poza ---------- */
async function llenarSelectsLotes() {
  var ids = ["sel-lote", "peso-lote", "muerte-lote", "alim-lote", "ing-lote", "venta-lote", "faena-lote", "retiro-lote"];
  var botones = ["f-peso", "f-muerte", "f-alimento", "f-venta", "f-faena", "f-retiro"].map(function (id) {
    var f = document.getElementById(id);
    return f ? f.querySelector('button[type="submit"]') : null;
  });
  try {
    var lotes = await api("GET", "lotes?granja_id=" + cfg().granja);
    var op = lotes.length
      ? lotes.map(function (l) { return '<option value="' + l.codigo + '">' + l.codigo + ' (' + l.vivos + ' vivos)</option>'; }).join("")
      : '<option value="">Sin pozas disponibles</option>';
    ids.forEach(function (id) {
      var s = document.getElementById(id);
      if (s) { s.innerHTML = op; }
    });
    botones.forEach(function (b) { if (b) { b.disabled = !lotes.length; } });
    cargarPistaPeso();
    return lotes;
  } catch (e) {
    ids.forEach(function (id) {
      var s = document.getElementById(id);
      if (s) { s.innerHTML = '<option value="">Error al cargar pozas</option>'; }
    });
    botones.forEach(function (b) { if (b) { b.disabled = true; } });
    return null;
  }
}

async function cargarLotes() {
  pintarUbicaciones();
  var lotes = await llenarSelectsLotes();
  if (lotes === null) {
    document.getElementById("ficha").textContent = "Error al cargar pozas.";
  }   else if (lotes.length) {
    var guardado = null;
    try { guardado = localStorage.getItem("cuymax_lote_activo"); } catch (e) { guardado = null; }
    if (guardado && lotes.some(function (l) { return l.codigo === guardado; })) {
      document.getElementById("sel-lote").value = guardado;
    } else if (atencionPendiente && atencionPendiente.lote) {
      document.getElementById("sel-lote").value = atencionPendiente.lote;
    }
    await verLote();
  }
  else { document.getElementById("ficha").innerHTML = vacio("No hay pozas en esta granja."); }
}
var grafica = null;
var _curvaSeq = 0;

async function verLote() {
  var cod = document.getElementById("sel-lote").value;
  if (!cod) { ocultarFichaExtra(); return; }
  document.getElementById("ficha").innerHTML = esqueleto(1);
  try {
    try { localStorage.setItem("cuymax_lote_activo", cod); } catch (e) {}
    var l = await api("GET", "lotes/" + encodeURIComponent(cod) + "?granja_id=" + cfg().granja);
    var pct = l.cantidad_inicial ? Math.round(100 * l.vivos / l.cantidad_inicial) : 0;
    var badge = document.getElementById("badge-lote");
    badge.className = "badge " + (l.estado === "abierto" ? "b-green" : "b-gray");
    badge.textContent = l.etapa + " · " + l.estado;
    document.getElementById("ficha").innerHTML =
      '<div class="stat-line"><span>Muertos / vendidos / faenados</span><b>' + (l.muertos !== undefined ? l.muertos : (l.cantidad_inicial - l.vivos - (l.vendidos || 0) - (l.faenados || 0))) + ' / ' + (l.vendidos || 0) + ' / ' + (l.faenados || 0) + '</b></div>' +
      '<div class="stat-line"><span>Alimento total</span><b>' + l.alimento_kg + ' kg</b></div>' +
      '<div class="stat-line"><span>Ubicación</span><b>' + escHtml(l.poza_codigo || "sin ubicación") + '</b></div>';
    await cargarPozas();
    document.getElementById("edit-nombre").value = l.nombre || "";
    document.getElementById("edit-etapa").value = l.etapa || "engorde";
    document.getElementById("edit-estado").value = l.estado || "abierto";
    document.getElementById("edit-poza").value = l.poza_codigo || "";
    document.getElementById("prog-etiqueta").textContent = "Cuyes vivos de la poza · " + l.vivos + " de " + l.cantidad_inicial;
    var barra = document.querySelector("#prog-lote i");
    if (barra) { barra.style.width = pct + "%"; }
    document.getElementById("prog-lote").className = "prog " + (pct < 40 ? "r" : (pct < 70 ? "a" : ""));
    var mort = Number(l.mortalidad_pct);
    document.getElementById("kv-vivos").textContent = l.vivos + "/" + l.cantidad_inicial;
    document.getElementById("delta-vivos-lote").textContent = l.vivos + " por vender";
    document.getElementById("kv-mort").textContent = l.mortalidad_pct + " %";
    var dm = document.getElementById("delta-mort");
    dm.className = "delta " + (mort < 5 ? "up" : (mort <= 15 ? "warn" : "down"));
    dm.textContent = mort < 5 ? "▲ baja" : (mort <= 15 ? "● media" : "▼ alta");
    document.getElementById("kv-peso").textContent = l.ultimo_peso_g === null ? "—" : l.ultimo_peso_g + " g";
    document.getElementById("kv-alim").textContent = l.alimento_kg + " kg";
    document.getElementById("delta-alim").textContent = "total";
    try {
      var eco = await api("GET", "resumen-economico?granja_id=" + cfg().granja);
      var e = eco.filter(function (x) { return x.codigo === cod; })[0];
      var box = document.getElementById("ficha-eco");
      if (e) {
        document.getElementById("ficha-eco-card").classList.remove("oculto");
        box.classList.remove("oculto");
        box.innerHTML =
          '<div class="stat-line"><span>Ingresos</span><b>' + soles(e.ingresos) + '</b></div>' +
          '<div class="stat-line"><span>Costo total</span><b>' + (e.costo_total === null ? 'sin valorizar' : soles(e.costo_total)) + '</b></div>' +
          '<div class="stat-line"><span>Margen' + (e.estado === 'abierto' ? ' parcial' : '') + '</span><b class="' + (e.margen === null ? '' : (e.margen < 0 ? 'neg' : 'pos')) + '">' + soles(e.margen) + '</b></div>' +
          '<div class="stat-line"><span>Costo por cuy logrado</span><b>' + (e.costo_por_cuy_logrado === null ? '—' : soles(e.costo_por_cuy_logrado)) + '</b></div>' +
          '<div class="stat-line"><span>Margen por cuy vivo</span><b>' + margenCuy(e, l) + '</b></div>';
      } else {
        box.classList.add("oculto");
        document.getElementById("ficha-eco-card").classList.add("oculto");
      }
    } catch (e2) { /* la ficha sigue visible sin el bloque económico */ }
    dibujarCurva(cod, l);
    document.getElementById("lote-acciones").classList.remove("oculto");
    pintarNfc(cod);
  } catch (e) {
    document.getElementById("ficha").textContent = "Error: " + e.message;
    ocultarFichaExtra();
  }
}

/* ---------- etiqueta NFC: enlace directo a una poza ----------
   La etiqueta guarda una URL del tipo /app/?poza=P-001. Al pegar el teléfono,
   el sistema abre esa dirección y el panel salta a la ficha de la poza. */
function urlDePoza(cod) {
  var params = new URLSearchParams();
  /* En la web publicada la etiqueta debe abrir datos reales, no la demo. */
  if (/\.(web\.app|firebaseapp\.com)$/i.test(location.hostname)) {
    params.set("modo", "real");
  } else {
    var modo = "";
    try { modo = new URLSearchParams(location.search).get("modo") || ""; } catch (e) { modo = ""; }
    if (modo) { params.set("modo", modo); }
  }
  params.set("poza", cod);
  /* La granja va dentro de la etiqueta: así el panel detecta si alguien
     entra con otra cuenta y evita registrar en la granja equivocada. */
  var g = granjaActualId();
  if (g) { params.set("g", g); }
  return location.origin + location.pathname + "?" + params.toString();
}

/* uid de la granja en la que se está trabajando ("" si no hay sesión). */
function granjaActualId() {
  try {
    if (typeof fsGranja === "function") { return fsGranja(); }
  } catch (e) { /* sin sesión o modo local */ }
  return "";
}

function granjaDeUrl() {
  try { return (new URLSearchParams(location.search).get("g") || "").trim(); } catch (e) { return ""; }
}

function avisarGranjaAjena() {
  var dlg = document.getElementById("dlg-granja");
  var msg = document.getElementById("dlg-granja-msg");
  var actual = (document.getElementById("granja-nombre") || {}).textContent || "esta granja";
  if (msg) {
    msg.innerHTML = "La etiqueta que acabas de leer pertenece a <b>otra granja</b>, y ahora mismo estás " +
      "dentro de <b>" + escHtml(actual.trim()) + "</b>.<br><br>" +
      "Si registras aquí, el movimiento quedaría en la granja equivocada. Entra con la cuenta de esa " +
      "granja y vuelve a pegar el teléfono: te llevará directo a la poza.";
  }
  if (dlg && dlg.showModal && !dlg.open) { dlg.showModal(); }
}

function pozaDeUrl() {
  var cod = "";
  try {
    cod = new URLSearchParams(location.search).get("poza") || "";
  } catch (e) { cod = ""; }
  if (!cod && location.hash) {
    var m = location.hash.match(/poza=([^&]+)/i);
    if (m) { try { cod = decodeURIComponent(m[1]); } catch (e2) { cod = ""; } }
  }
  return cod.trim().toUpperCase();
}

function ocultarFichaExtra() {
  var a = document.getElementById("lote-acciones");
  var n = document.getElementById("nfc-box");
  if (a) { a.classList.add("oculto"); }
  if (n) { n.classList.add("oculto"); }
}

function pintarNfc(cod) {
  var caja = document.getElementById("nfc-box");
  if (!caja) { return; }
  var url = urlDePoza(cod);
  caja.classList.remove("oculto");
  document.getElementById("nfc-url").textContent = url;
  var estado = document.getElementById("nfc-estado");
  estado.textContent = "";
  estado.className = "nfc-estado";
  var btn = document.getElementById("btn-nfc-grabar");
  if ("NDEFReader" in window) {
    btn.classList.add("primary");
    btn.textContent = "Grabar etiqueta";
  } else {
    btn.classList.remove("primary");
    btn.textContent = "¿Cómo grabar?";
  }
}

async function copiarEnlaceNfc() {
  var texto = document.getElementById("nfc-url").textContent;
  var estado = document.getElementById("nfc-estado");
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(texto);
    } else {
      var ta = document.createElement("textarea");
      ta.value = texto;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    estado.className = "nfc-estado ok";
    estado.textContent = "Enlace copiado. Pégalo en NFC Tools si vas a grabar desde el iPhone.";
  } catch (e) {
    estado.className = "nfc-estado err";
    estado.textContent = "No se pudo copiar. Mantén pulsado el enlace de arriba para copiarlo a mano.";
  }
}

async function grabarEtiquetaNfc() {
  var url = document.getElementById("nfc-url").textContent;
  var estado = document.getElementById("nfc-estado");
  if (!("NDEFReader" in window)) {
    estado.className = "nfc-estado";
    estado.innerHTML = "Para grabar desde aquí hace falta <b>Chrome en un Android</b> con NFC. " +
      "En iPhone o computadora usa la app gratuita <b>NFC Tools</b>: «Escribir» → «URL» y pega el enlace de arriba.";
    return;
  }
  var btn = document.getElementById("btn-nfc-grabar");
  btn.disabled = true;
  estado.className = "nfc-estado";
  estado.textContent = "Acerca la etiqueta a la parte de atrás del teléfono…";
  try {
    var ndef = new NDEFReader();
    await ndef.write({ records: [{ recordType: "url", data: url }] });
    estado.className = "nfc-estado ok";
    estado.textContent = "Etiqueta grabada. Ya puedes pegarla en la poza.";
  } catch (e) {
    estado.className = "nfc-estado err";
    estado.textContent = "No se pudo grabar: " + (e && e.message ? e.message : e) +
      ". Mantén la etiqueta pegada al teléfono hasta que termine.";
  } finally {
    btn.disabled = false;
  }
}

/* Abre el diálogo de registro con la poza ya elegida. */
async function registrarEnPoza(cod, accion) {
  await abrirRegistrar(accion);
  ["peso-lote", "alim-lote", "muerte-lote", "ing-lote", "venta-lote", "faena-lote", "retiro-lote"]
    .forEach(function (id) {
      var s = document.getElementById(id);
      if (s) { s.value = cod; }
    });
}

/* Al arrancar: si la URL trae ?poza=, salta a esa ficha. */
function aplicarPozaDeUrl(lotes) {
  var cod = pozaDeUrl();
  if (!cod) { return; }
  /* Primero la granja: si la etiqueta es de otra cuenta, no se muestra nada. */
  var gEtiqueta = granjaDeUrl();
  var gActual = granjaActualId();
  if (gEtiqueta && gActual && gEtiqueta !== gActual) {
    avisarGranjaAjena();
    return;
  }
  var existe = !!(lotes && lotes.some(function (l) {
    return String(l.codigo).toUpperCase() === cod;
  }));
  if (!existe) {
    showToast("La etiqueta apunta a " + cod + ", que no está en esta granja", "err");
    return;
  }
  try { localStorage.setItem("cuymax_lote_activo", cod); } catch (e) { /* sin almacenamiento */ }
  var sel = document.getElementById("sel-lote");
  if (sel) { sel.value = cod; }
  irA("lote");
  showToast("Etiqueta NFC · " + cod);
}

function margenCuy(e, l) {
  if (e.margen === null || !l || !(l.vivos > 0)) { return "—"; }
  var v = e.margen / l.vivos;
  var txt = "S/ " + Math.abs(v).toFixed(2);
  return '<span class="badge ' + (v < 0 ? 'b-red' : 'b-green') + '">' + txt + '</span>';
}

async function dibujarCurva(cod, lote) {
  /* Si se cambia de poza mientras carga la anterior, solo la última dibuja. */
  var seq = ++_curvaSeq;
  var cv = document.getElementById("grafica-peso");
  if (grafica) { grafica.destroy(); grafica = null; }
  if (typeof Chart === "undefined") { return; }
  var h = [];
  try {
    h = await api("GET", "lotes/" + encodeURIComponent(cod) + "/pesajes?granja_id=" + cfg().granja);
  } catch (e) { h = []; }
  if (seq !== _curvaSeq) { return; }
  var ctx = cv.getContext("2d");
  ctx.clearRect(0, 0, cv.width, cv.height);
  var sinCurva = (typeof Chart === "undefined" || h.length < 2);
  cv.classList.toggle("oculto", sinCurva);
  if (cv.parentElement) { cv.parentElement.classList.toggle("oculto", sinCurva); }
  document.getElementById("vacio-curva").classList.toggle("oculto", !sinCurva);
  document.getElementById("delta-peso").textContent = h.length ? fechaCorta2(h[h.length - 1].fecha) : "—";
  if (sinCurva) { return; }
  var pesos = h.map(function (p) { return Number(p.peso_promedio_g); });
  var cs = getComputedStyle(document.documentElement);
  var verde = (cs.getPropertyValue("--accent") || "#0E9F6E").trim();
  var ambar = (cs.getPropertyValue("--amber") || "#D98A0B").trim();
  var tinta = (cs.getPropertyValue("--text-2") || "#5A6673").trim();
  var rejilla = (cs.getPropertyValue("--border") || "#E6E9EE").trim();
  var fuente = "Inter, system-ui, sans-serif";
  var g = ctx.createLinearGradient(0, 0, 0, 280);
  g.addColorStop(0, "rgba(74, 222, 128, .30)");
  g.addColorStop(1, "rgba(74, 222, 128, 0)");
  document.getElementById("leyenda-lote").innerHTML =
    '<span class="legend"><span><i style="background:' + verde + '"></i>Peso</span>' +
    (lote.peso_objetivo_g ? '<span><i style="background:' + ambar + '"></i>Objetivo</span>' : '') + '</span>';
  var sets = [{
    label: "Peso promedio (g)",
    data: pesos,
    borderColor: verde,
    backgroundColor: g,
    pointBackgroundColor: verde,
    pointRadius: 4,
    fill: true,
    tension: .25
  }];
  if (lote && lote.peso_objetivo_g) {
    sets.push({
      label: "Objetivo (" + lote.peso_objetivo_g + " g)",
      data: h.map(function () { return lote.peso_objetivo_g; }),
      borderColor: ambar,
      borderDash: [7, 5],
      pointRadius: 0,
      fill: false,
      tension: 0
    });
  }
  if (grafica) { grafica.destroy(); grafica = null; }
  grafica = new Chart(cv, {
    type: "line",
    data: { labels: h.map(function (p) { return fechaCorta2(p.fecha); }), datasets: sets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: calma ? false : { duration: 600 },
      font: { family: fuente },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: "#2B2119",
          titleFont: { size: 13, family: fuente },
          bodyFont: { size: 13, family: fuente },
          padding: 10,
          callbacks: {
            title: function () { return ""; },
            label: function (c) {
              var i = c.dataIndex, d = c.chart.data;
              return " " + d.labels[i] + " · " + d.datasets[0].data[i] + " g";
            }
          }
        }
      },
      scales: {
        x: { ticks: { color: tinta, font: { size: 12, weight: "500", family: fuente }, maxRotation: 0, autoSkip: true }, grid: { color: rejilla } },
        y: { min: 0, title: { display: true, text: "gramos", color: tinta, font: { size: 12, weight: "500", family: fuente } }, ticks: { color: tinta, font: { size: 12, weight: "500", family: fuente } }, grid: { color: rejilla } }
      }
    }
  });
}
document.getElementById("sel-lote").addEventListener("change", verLote);

/* Registro rápido desde la ficha: abre el formulario con la poza ya puesta. */
document.getElementById("lote-acciones").addEventListener("click", function (ev) {
  var b = ev.target.closest ? ev.target.closest("[data-poza-accion]") : null;
  if (!b) { return; }
  var cod = document.getElementById("sel-lote").value;
  if (!cod) { return; }
  registrarEnPoza(cod, b.dataset.pozaAccion);
});
document.getElementById("btn-nfc-copiar").addEventListener("click", copiarEnlaceNfc);
document.getElementById("btn-nfc-grabar").addEventListener("click", grabarEtiquetaNfc);

/* Aviso de etiqueta de otra granja: cerrar o cambiar de cuenta. */
(function () {
  var dlg = document.getElementById("dlg-granja");
  if (!dlg) { return; }
  function cerrar() { if (dlg.open) { dlg.close(); } }
  document.getElementById("dlg-granja-x").addEventListener("click", cerrar);
  document.getElementById("btn-granja-ahora").addEventListener("click", cerrar);
  document.getElementById("btn-granja-cambiar").addEventListener("click", function () {
    if (typeof window.cuymaxSalir === "function") { window.cuymaxSalir(); return; }
    location.href = "../login.html?next=" + encodeURIComponent(location.pathname + location.search);
  });
})();

/* ---------- ventana de registro ---------- */
var dlgRegistrar = document.getElementById("dlg-registrar");
var dlgAcciones = document.getElementById("dlg-acciones");
var dlgForm = document.getElementById("dlg-form");
var dlgVolver = document.getElementById("dlg-volver");
var dlgTitulo = document.getElementById("dlg-titulo");
var dlgSub = document.getElementById("dlg-sub");
var ACCIONES_REG = {
  peso: { titulo: "Registrar peso", sub: "Promedio de la poza en gramos" },
  muerte: { titulo: "Registrar muerte", sub: "Bajas de la poza" },
  alimento: { titulo: "Registrar alimento", sub: "Consumo de la poza en kilos" },
  parto: { titulo: "Registrar parto", sub: "Nacimiento registrado" },
  parto_proximo: { titulo: "Programar parto", sub: "Fecha estimada de la hembra" },
  destete: { titulo: "Registrar destete", sub: "Las crías pasan a recría" },
  ingreso: { titulo: "Registrar ingreso", sub: "Cuyes que llegan por compra" },
  venta: { titulo: "Registrar venta", sub: "Cuyes vendidos por unidad" },
  faena: { titulo: "Registrar faena", sub: "Cuyes faenados de la poza" },
  retiro: { titulo: "Registrar retiro sanitario", sub: "Tratamiento y días de espera" }
};

function mostrarAccion(accion) {
  if (!dlgAcciones || !dlgForm) { return; }
  var valida = !!(accion && ACCIONES_REG[accion]);
  dlgAcciones.classList.toggle("oculto", valida);
  dlgForm.classList.toggle("oculto", !valida);
  if (dlgVolver) { dlgVolver.classList.toggle("oculto", !valida); }
  if (dlgTitulo) { dlgTitulo.textContent = valida ? ACCIONES_REG[accion].titulo : "¿Qué quieres registrar?"; }
  if (dlgSub) { dlgSub.textContent = valida ? ACCIONES_REG[accion].sub : "Elige el movimiento y completa solo sus datos"; }
  document.querySelectorAll(".dlg-panel").forEach(function (p) {
    p.classList.toggle("oculto", !valida || p.dataset.accion !== accion);
  });
  if (valida) {
    var panel = document.querySelector('.dlg-panel[data-accion="' + accion + '"]');
    var campo = panel ? panel.querySelector("select, input") : null;
    if (campo) { setTimeout(function () { try { campo.focus({ preventScroll: true }); } catch (e) {} }, 40); }
  }
}

async function abrirRegistrar(accion) {
  if (!dlgRegistrar) { return; }
  mostrarAccion(accion || null);
  if (!dlgRegistrar.open) {
    dlgRegistrar.showModal();
    document.body.classList.add("dlg-abierto");
  }
  if (!accion) {
    var primero = dlgAcciones ? dlgAcciones.querySelector(".dlg-accion") : null;
    if (primero) { try { primero.focus({ preventScroll: true }); } catch (e) {} }
  }
  /* Se espera: quien llame puede querer fijar la poza justo después. */
  await llenarSelectsLotes();
  cargarPozas();
}

function cerrarRegistrar() {
  if (dlgRegistrar && dlgRegistrar.open) { dlgRegistrar.close(); }
}

if (dlgRegistrar) {
  dlgRegistrar.addEventListener("close", function () {
    document.body.classList.remove("dlg-abierto");
    mostrarAccion(null);
  });
  dlgRegistrar.addEventListener("click", function (ev) {
    if (ev.target !== dlgRegistrar) { return; }
    var r = dlgRegistrar.getBoundingClientRect();
    if (ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom) {
      cerrarRegistrar();
    }
  });
  document.getElementById("dlg-cerrar").addEventListener("click", cerrarRegistrar);
  if (dlgVolver) { dlgVolver.addEventListener("click", function () { mostrarAccion(null); }); }
  dlgAcciones.addEventListener("click", function (ev) {
    var b = ev.target.closest ? ev.target.closest("[data-accion]") : null;
    if (b && ACCIONES_REG[b.dataset.accion]) { mostrarAccion(b.dataset.accion); }
  });
}
document.getElementById("btn-registrar-mov").addEventListener("click", function () { abrirRegistrar(); });

/* ---------- formularios ---------- */
function num(v) { return v === "" || v === null ? null : parseFloat(String(v).replace(",", ".")); }
function ent(v) { return v === "" || v === null ? null : parseInt(v, 10); }

function conectar(id, ruta, armar, exito) {
  document.getElementById(id).addEventListener("submit", async function (ev) {
    ev.preventDefault();
    var f = ev.target, r = f.querySelector(".r");
    var btn = f.querySelector('button[type="submit"]');
    f.querySelectorAll(".invalido").forEach(function (x) { x.classList.remove("invalido"); });
    var mal = f.querySelector("input:invalid, select:invalid");
    if (mal) {
      mal.classList.add("invalido");
      mal.focus();
      r.className = "r err";
      r.textContent = mal.getAttribute("data-msg") || "Revisa el campo marcado.";
      return;
    }
    var datos = armar(f);
    r.className = "r"; r.textContent = "Guardando…";
    btn.disabled = true;
    try {
      var resp = await api("POST", typeof ruta === "function" ? ruta(datos) : ruta, datos);
      var guardados = [];
      f.querySelectorAll("select").forEach(function (s) { guardados.push(s.value); });
      f.reset();
      f.querySelectorAll("select").forEach(function (s, i) { s.value = guardados[i]; });
      r.classList.add("ok"); r.textContent = "Listo: " + resp.resumen + (resp.detalle ? " " + resp.detalle : "");
      showToast((typeof exito === "function") ? exito(datos, resp) : (exito || ("Guardado: " + resp.resumen)), "ok");
      atenderSiCorresponde(id, datos);
      cargarRegistros();
      cargarPanel();
      llenarSelectsLotes();
      setTimeout(function () { btn.disabled = false; }, 600);
    } catch (e) {
      r.classList.add("err"); r.textContent = e.message;
      showToast("No se pudo guardar. Intenta de nuevo", "err");
      btn.disabled = false;
    }
  });
}

function showToast(texto, tipo) {
  var box = document.getElementById("toasts");
  if (!box || !document.createElement) { return; }
  var t = document.createElement("div");
  t.className = "toast" + (tipo === "err" ? " err" : "");
  t.setAttribute("role", "status");
  var punto = document.createElement("span");
  punto.className = "ok";
  punto.textContent = tipo === "err" ? "!" : "✓";
  t.appendChild(punto);
  t.appendChild(document.createTextNode(texto));
  box.appendChild(t);
  setTimeout(function () { t.remove(); }, 3000);
}

var pistaPeso = document.getElementById("peso-hint");

async function cargarPistaPeso() {
  if (!pistaPeso) { return; }
  var sel = document.getElementById("peso-lote");
  var cod = sel ? sel.value : "";
  if (!cod) { pistaPeso.classList.add("oculto"); pistaPeso.textContent = ""; return; }
  try {
    var h = await api("GET", "lotes/" + encodeURIComponent(cod) + "/pesajes?granja_id=" + cfg().granja);
    if (h.length) {
      var u = h[h.length - 1];
      pistaPeso.textContent = "Último pesaje de " + cod + ": " + Number(u.peso_promedio_g) + " g · " + fechaCorta2(u.fecha);
    } else {
      pistaPeso.textContent = "La poza " + cod + " aún no tiene pesajes registrados.";
    }
    pistaPeso.classList.remove("oculto");
  } catch (e) { pistaPeso.classList.add("oculto"); pistaPeso.textContent = ""; }
}

document.getElementById("peso-lote").addEventListener("change", cargarPistaPeso);

conectar("f-peso", "pesajes", function (f) {
  return { granja_id: cfg().granja, lote: f.lote.value, peso_g: num(f.peso_g.value), animales_pesados: ent(f.animales_pesados.value) };
}, function (d) { cargarPistaPeso(); return "Peso guardado · " + d.lote + " · " + d.peso_g + " g"; });
conectar("f-muerte", "muertes", function (f) {
  return { granja_id: cfg().granja, lote: f.lote.value, cantidad: ent(f.cantidad.value), causa: f.causa.value || null };
});
conectar("f-alimento", "alimento", function (f) {
  return { granja_id: cfg().granja, lote: f.lote.value, tipo: f.tipo.value, kg: num(f.kg.value) };
});
conectar("f-parto", "partos", function (f) {
  return { granja_id: cfg().granja, hembra: f.hembra.value || null, poza: f.poza.value || null, nacidos_vivos: ent(f.nacidos_vivos.value), nacidos_muertos: ent(f.nacidos_muertos.value || "0") };
});
conectar("f-parto-prox", "partos-proximos", function (f) {
  return { granja_id: cfg().granja, hembra: f.hembra.value, poza: f.poza.value || null, fecha_objetivo: f.fecha_objetivo.value };
}, function (d) { return "Parto programado: " + d.hembra; });
conectar("f-destete", "destetes", function (f) {
  return { granja_id: cfg().granja, hembra: f.hembra.value, cantidad: ent(f.cantidad.value), poza_destino: f.poza_destino.value };
}, function () { llenarSelectsLotes(); return "Destete guardado"; });
conectar("f-venta", "ventas", function (f) {
  return { granja_id: cfg().granja, lote: f.lote.value, cantidad: ent(f.cantidad.value), precio_unitario: num(f.precio_unitario.value) };
}, function () { llenarSelectsLotes(); return "Venta guardada"; });
conectar("f-faena", "faenas", function (f) {
  return { granja_id: cfg().granja, lote: f.lote.value, cantidad: ent(f.cantidad.value) };
}, function () { llenarSelectsLotes(); return "Faena guardada"; });
conectar("f-retiro", "retiros", function (f) {
  return { granja_id: cfg().granja, lote: f.lote.value, producto: f.producto.value, dias: ent(f.dias.value), tipo: "tratamiento" };
});

/* ---------- editar / borrar poza y ubicaciones ---------- */
function refrescarLotes() {
  llenarSelectsLotes();
  cargarPozas();
  pintarUbicaciones();
  cargarPanel();
}

document.getElementById("f-editar-lote").addEventListener("submit", async function (ev) {
  ev.preventDefault();
  var f = ev.target, r = f.querySelector(".r");
  var cod = document.getElementById("sel-lote").value;
  if (!cod) { r.className = "r err"; r.textContent = "Elige una poza primero."; return; }
  var btn = f.querySelector('button[type="submit"]');
  r.className = "r"; r.textContent = "Guardando…";
  btn.disabled = true;
  try {
    var resp = await api("PUT", "lotes/" + encodeURIComponent(cod) + "?granja_id=" + cfg().granja, {
      nombre: f.nombre.value,
      etapa: f.etapa.value,
      estado: f.estado.value,
      poza_id: f.poza_id.value
    });
    r.className = "r ok"; r.textContent = "Guardado · " + resp.resumen;
    showToast("Poza actualizada", "ok");
    /* Mantener seleccionada la poza editada: si no, cargarLotes puede volver
       a la última guardada y la ficha mostraría otra poza. */
    try { localStorage.setItem("cuymax_lote_activo", cod); } catch (e2) { /* sin almacenamiento */ }
    await cargarLotes();
    document.getElementById("sel-lote").value = cod;
    await verLote();
    await cargarPozas();
    pintarUbicaciones();
    cargarPanel();
  } catch (e) {
    r.className = "r err"; r.textContent = e.message;
  }
  btn.disabled = false;
});

document.getElementById("btn-borrar-lote").addEventListener("click", async function () {
  var cod = document.getElementById("sel-lote").value;
  if (!cod) { showToast("Elige una poza primero", "err"); return; }
  if (!confirm("¿Borrar la poza " + cod + "? Se eliminarán también sus movimientos. No se puede deshacer.")) { return; }
  this.disabled = true;
  try {
    var r = await api("DELETE", "lotes/" + encodeURIComponent(cod) + "?granja_id=" + cfg().granja);
    showToast(r.resumen + (r.detalle ? " · " + r.detalle : ""), "ok");
    try { localStorage.removeItem("cuymax_lote_activo"); } catch (e) { /* sin almacenamiento */ }
    await cargarLotes();
    refrescarLotes();
  } catch (e) {
    showToast("No se pudo borrar: " + e.message, "err");
  }
  this.disabled = false;
});

document.getElementById("f-poza").addEventListener("submit", async function (ev) {
  ev.preventDefault();
  var f = ev.target, r = f.querySelector(".r");
  var btn = f.querySelector('button[type="submit"]');
  f.querySelectorAll(".invalido").forEach(function (x) { x.classList.remove("invalido"); });
  var mal = f.querySelector("input:invalid");
  if (mal) {
    mal.classList.add("invalido");
    mal.focus();
    r.className = "r err";
    r.textContent = mal.getAttribute("data-msg") || "Revisa el campo marcado.";
    return;
  }
  r.className = "r"; r.textContent = "Guardando…";
  btn.disabled = true;
  try {
    var resp = await api("POST", "pozas?granja_id=" + cfg().granja, {
      codigo: f.codigo.value, tipo: f.tipo.value, capacidad: f.capacidad.value
    });
    f.reset();
    r.className = "r ok"; r.textContent = "Guardado · " + resp.resumen;
    showToast("Ubicación agregada", "ok");
    await cargarPozas();
    await pintarUbicaciones();
  } catch (e) {
    r.className = "r err"; r.textContent = e.message;
  }
  btn.disabled = false;
});

document.getElementById("lista-pozas").addEventListener("click", async function (ev) {
  var b = ev.target.closest ? ev.target.closest("[data-borrar-poza]") : null;
  if (!b) { return; }
  var id = b.dataset.borrarPoza;
  if (!confirm("¿Borrar la ubicación " + id + "? Las pozas que la usen quedarán sin ubicación.")) { return; }
  b.disabled = true;
  try {
    var r = await api("DELETE", "pozas/" + encodeURIComponent(id) + "?granja_id=" + cfg().granja);
    showToast(r.resumen + (r.detalle ? " · " + r.detalle : ""), "ok");
    await cargarPozas();
    await pintarUbicaciones();
    if (document.getElementById("sel-lote").value) { verLote(); }
  } catch (e) {
    showToast("No se pudo borrar: " + e.message, "err");
    b.disabled = false;
  }
});

/* Quitar un parto programado desde el panel. */
document.getElementById("partos").addEventListener("click", async function (ev) {
  var b = ev.target.closest ? ev.target.closest("[data-borrar-prox]") : null;
  if (!b) { return; }
  if (!confirm("¿Quitar este parto programado?")) { return; }
  b.disabled = true;
  try {
    var r = await api("DELETE", "partos-proximos/" + encodeURIComponent(b.dataset.borrarProx) + "?granja_id=" + cfg().granja);
    showToast(r.resumen, "ok");
    await cargarPanel();
  } catch (e) {
    showToast("No se pudo quitar: " + e.message, "err");
    b.disabled = false;
  }
});

/* ---------- ingreso de cuyes (compras) ---------- */
var modoIngreso = "sumar";

async function cargarPozas() {
  try {
    var pozas = await api("GET", "pozas?granja_id=" + cfg().granja);
    var opIng = pozas.length
      ? pozas.map(function (p) {
          return '<option value="' + escHtml(p.id) + '">' + escHtml(p.codigo) + (p.tipo ? " · " + escHtml(p.tipo) : "") + "</option>";
        }).join("")
      : '<option value="">Sin ubicación (se usará el código)</option>';
    var opEdit = '<option value="">Sin ubicación</option>' + pozas.map(function (p) {
      return '<option value="' + escHtml(p.codigo) + '">' + escHtml(p.codigo) + (p.tipo ? " · " + escHtml(p.tipo) : "") + "</option>";
    }).join("");
    var sIng = document.getElementById("ing-poza");
    if (sIng) { sIng.innerHTML = opIng; }
    var sEdit = document.getElementById("edit-poza");
    if (sEdit) {
      var elegido = sEdit.value;
      sEdit.innerHTML = opEdit;
      if (elegido) { sEdit.value = elegido; }
    }
    return pozas;
  } catch (e) {
    var sIng2 = document.getElementById("ing-poza");
    if (sIng2) { sIng2.innerHTML = '<option value="">Error al cargar ubicaciones</option>'; }
    return null;
  }
}

/* Lista de ubicaciones con su botón para borrar. */
async function pintarUbicaciones() {
  var caja = document.getElementById("lista-pozas");
  if (!caja) { return; }
  try {
    var pozas = await api("GET", "pozas?granja_id=" + cfg().granja);
    caja.innerHTML = pozas.length
      ? pozas.map(function (p) {
          var detalle = (p.tipo ? escHtml(p.tipo) : "sin tipo") +
            (p.capacidad == null ? "" : " · " + p.capacidad + " cuyes");
          return '<div class="registro"><div class="reg-info"><b>' + escHtml(p.codigo) + "</b><span>" + detalle + "</span></div>" +
            '<button type="button" class="btn sm danger" data-borrar-poza="' + escHtml(p.id) + '">Borrar</button></div>';
        }).join("")
      : '<div class="empty"><b>Sin ubicaciones</b><p>Agrega galpones, jaulas o corrales para organizar tus pozas.</p></div>';
  } catch (e) {
    caja.innerHTML = tarjeta("Error: " + e.message);
  }
}

document.getElementById("seg-ingreso").addEventListener("click", function (ev) {
  var b = ev.target.closest ? ev.target.closest("button") : null;
  if (!b || !b.dataset.modo) { return; }
  document.querySelectorAll("#seg-ingreso button").forEach(function (x) { x.classList.remove("on"); });
  b.classList.add("on");
  modoIngreso = b.dataset.modo;
  var sumar = modoIngreso === "sumar";
  document.getElementById("ing-grupo-sumar").classList.toggle("oculto", !sumar);
  document.getElementById("ing-grupo-crear").classList.toggle("oculto", sumar);
  document.getElementById("ing-lote").required = sumar;
  document.getElementById("ing-cant").required = sumar;
  document.getElementById("ing-codigo").required = !sumar;
  document.getElementById("ing-cant-ini").required = !sumar;
  document.getElementById("ing-poza").required = !sumar && !(typeof MODO_REAL !== "undefined" && MODO_REAL);
  document.getElementById("ing-btn").textContent = sumar ? "Guardar ingreso" : "Crear poza";
});

conectar("f-ingreso", function () { return modoIngreso === "crear" ? "lotes" : "ingresos"; }, function (f) {
  if (modoIngreso === "crear") {
    return { granja_id: cfg().granja, codigo: f.codigo.value.trim(), cantidad_inicial: ent(f.cantidad_inicial.value),
             etapa: f.etapa.value, poza_id: ent(f.poza_id.value) };
  }
  return { granja_id: cfg().granja, lote: f.lote.value, cantidad: ent(f.cantidad.value) };
}, function (datos, resp) {
  llenarSelectsLotes();
  return "Guardado · " + resp.resumen;
});

/* ---------- avisos ---------- */
document.getElementById("btn-generar").addEventListener("click", async function () {
  var btn = this;
  btn.disabled = true;
  btn.classList.add("girando");
  try {
    var r = await api("POST", "alertas/generar");
    var n = Number(r.total != null ? r.total : r.creadas) || 0;
    showToast(n === 0 ? "No hay avisos pendientes hoy" : (n === 1 ? "1 aviso pendiente hoy" : n + " avisos pendientes hoy"), n > 0 ? "ok" : undefined);
    await cargarAvisos();
  } catch (e) {
    document.getElementById("avisos").innerHTML = tarjeta("Error: " + e.message);
    showToast("No se pudo generar. Intenta de nuevo", "err");
  }
  btn.classList.remove("girando");
  btn.disabled = false;
});

var ICONOS_AVISO = {
  parto_proximo: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>',
  destete: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l9 5-9 5-9-5 9-5zM3 13l9 5 9-5"/></svg>',
  pesaje_pendiente: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>',
  retiro: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z"/></svg>',
  otra: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a6 6 0 0 0-6 6v4l-2 3h16l-2-3V9a6 6 0 0 0-6-6zm0 19a2.5 2.5 0 0 0 2.45-2H9.55A2.5 2.5 0 0 0 12 22z"/></svg>'
};

var NOMBRES_AVISO = {
  parto_proximo: "Parto próximo",
  destete: "Destete",
  pesaje_pendiente: "Pesaje pendiente",
  retiro: "Fin de retiro",
  otra: "Otro"
};

var formatoFecha = new Intl.DateTimeFormat("es-PE", { day: "numeric", month: "short", year: "numeric" });

var formatoMes = new Intl.DateTimeFormat("es-PE", { month: "short", year: "2-digit" });

function etiqMes(iso) {
  var s = formatoMes.format(new Date(iso + "T00:00:00")).replace(/\./g, "");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

var MESES_CORTO = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

function fechaCorta2(iso) {
  var d = new Date(iso + "T00:00:00");
  if (isNaN(d)) { return iso; }
  return ("0" + d.getDate()).slice(-2) + " " + MESES_CORTO[d.getMonth()];
}

function fechaCorta(iso) {
  var d = new Date(iso + "T00:00:00");
  return isNaN(d) ? iso : formatoFecha.format(d).replace(/\./g, "");
}

function fechaCortaSinAnio(iso) {
  if (!iso) { return ""; }
  var d = new Date(iso + "T00:00:00");
  if (isNaN(d)) { return iso; }
  return ("0" + d.getDate()).slice(-2) + " " + MESES_CORTO[d.getMonth()];
}

function fechaISO(d) {
  return typeof fsFechaLocal === "function" ? fsFechaLocal(d || new Date()) : (d || new Date()).toISOString().slice(0, 10);
}

function hoyISO() { return fechaISO(new Date()); }

function difDias(objetivo) {
  if (!objetivo) { return null; }
  var ms = new Date(objetivo + "T00:00:00") - new Date(hoyISO() + "T00:00:00");
  return Math.round(ms / 86400000);
}

function textoAviso(x) {
  if (x.tipo === "parto_proximo") {
    var quien = (x.hembra || "La hembra") + (x.poza ? " (ubicación " + x.poza + ")" : "");
    var d = difDias(x.fecha_objetivo);
    if (d === null) { return quien + ": revisa el parto."; }
    if (d === 0) { return quien + " pare hoy."; }
    if (d === 1) { return quien + " pare mañana."; }
    if (d > 1) { return quien + " pare en " + d + " días."; }
    return quien + " debía parir el " + fechaCortaSinAnio(x.fecha_objetivo) + " · registra el parto.";
  }
  if (x.tipo === "destete") {
    if (x.fecha_nac) {
      var edad = Math.round((new Date(hoyISO() + "T00:00:00") - new Date(x.fecha_nac + "T00:00:00")) / 86400000);
      var cria = x.hembra_parto ? "Las crías de " + x.hembra_parto : "Las crías";
      return cria + " cumplen " + edad + (edad === 1 ? " día" : " días") + ": toca destetar (ventana de 15 a 21 días).";
    }
    return x.mensaje;
  }
  if (x.tipo === "pesaje_pendiente") {
    if (x.lote && x.dias_sin_pesaje !== null && x.dias_sin_pesaje !== undefined) {
      return "La poza " + x.lote + " lleva " + x.dias_sin_pesaje + (x.dias_sin_pesaje === 1 ? " día" : " días") + " sin pesaje.";
    }
    return x.mensaje;
  }
  if (x.tipo === "retiro") {
    var que = x.lote || x.poza ? "El retiro sanitario de " + (x.lote || x.poza) : "El retiro sanitario";
    var r = difDias(x.fecha_objetivo);
    if (r === null) { return que + ": revisa antes de vender."; }
    if (r === 0) { return que + " termina hoy."; }
    if (r === 1) { return que + " termina mañana."; }
    if (r > 1) { return que + " termina en " + r + " días."; }
    return que + " terminó el " + fechaCortaSinAnio(x.fecha_objetivo) + " · revisa la poza.";
  }
  return x.mensaje;
}

function esVencido(x) {
  if ((x.estado || "pendiente") !== "pendiente") { return false; }
  var d = difDias(x.fecha_objetivo);
  return d !== null && d < -3;
}

async function generarAutomatico() {
  var hoy = hoyISO();
  var ultimo = null;
  try { ultimo = localStorage.getItem("cuymax_avisos_fecha"); } catch (e) { ultimo = null; }
  if (ultimo === hoy) { await cargarAvisos(); return; }
  try {
    await api("POST", "alertas/generar");
    try { localStorage.setItem("cuymax_avisos_fecha", hoy); } catch (e) { /* sin almacenamiento */ }
  } catch (e) { /* silencioso: reintenta mañana o con el botón */ }
  await cargarAvisos();
}

var filtroAvisos = "todos";
var cacheAvisos = [];
var atencionPendiente = null;

function tituloAviso(x) {
  if (x.tipo === "parto_proximo") {
    var d = difDias(x.fecha_objetivo);
    if (d !== null && d < 0) { return "Parto atrasado"; }
    if (d === 0) { return "Parto hoy"; }
    return "Parto próximo";
  }
  return NOMBRES_AVISO[x.tipo] || x.tipo;
}

function textoAtendido(x) {
  var f = fechaCortaSinAnio(x.fecha_aviso) || x.fecha_aviso || "";
  if (x.tipo === "parto_proximo" && x.hembra) {
    return "Parto de " + x.hembra + " atendido el " + f + ".";
  }
  return tituloAviso(x) + " atendido el " + f + ".";
}

function resaltarParto() {
  var f = document.getElementById("f-parto");
  var card = (f && f.closest) ? f.closest(".card") : null;
  if (card) {
    card.classList.add("resaltada");
    try { card.scrollIntoView({ block: "center" }); } catch (e) { /* sin scroll */ }
  }
}

function atenderDesdeBandeja(id) {
  var x = null;
  for (var i = 0; i < cacheAvisos.length; i++) {
    if (String(cacheAvisos[i].id) === String(id)) { x = cacheAvisos[i]; }
  }
  if (!x) { return; }
  if (x.tipo === "parto_proximo") {
    var fh = document.getElementById("parto-hembra"), fp = document.getElementById("parto-poza");
    if (fh && x.hembra) { fh.value = x.hembra; }
    if (fp && x.poza) { fp.value = x.poza; }
    atencionPendiente = { id: x.id, tipo: "parto",
      hembra: (x.hembra || "").toUpperCase(), poza: (x.poza || "").toUpperCase() };
    abrirRegistrar("parto");
    resaltarParto();
    return;
  }
  if (x.tipo === "retiro" && x.lote) {
    atencionPendiente = { id: x.id, tipo: "retiro", lote: String(x.lote).toUpperCase() };
    irA("lote");
    return;
  }
  api("POST", "alertas/" + x.id + "/atender?granja_id=" + cfg().granja,
    { tipo: x.tipo, mensaje: textoAviso(x) }).then(function () {
    showToast("Aviso atendido", "ok");
    return cargarAvisos();
  }, function () { showToast("No se pudo marcar. Intenta de nuevo", "err"); });
}

async function atenderSiCorresponde(idForm, datos) {
  if (!atencionPendiente) { return; }
  var ap = atencionPendiente, ok = false;
  if (ap.tipo === "parto" && idForm === "f-parto") {
    var h = String(datos.hembra || "").toUpperCase();
    var p = String(datos.poza || "").toUpperCase();
    ok = (!ap.hembra || !h || h === ap.hembra) && (!ap.poza || !p || p === ap.poza);
  } else if (ap.tipo === "retiro" && datos.lote) {
    ok = String(datos.lote).toUpperCase() === String(ap.lote).toUpperCase();
  }
  if (!ok) { return; }
  atencionPendiente = null;
  var f = document.getElementById("f-parto");
  var card = (f && f.closest) ? f.closest(".card") : null;
  if (card) { card.classList.remove("resaltada"); }
  var aviso = null;
  for (var i = 0; i < cacheAvisos.length; i++) {
    if (String(cacheAvisos[i].id) === String(ap.id)) { aviso = cacheAvisos[i]; break; }
  }
  try {
    await api("POST", "alertas/" + ap.id + "/atender?granja_id=" + cfg().granja,
      aviso ? { tipo: aviso.tipo, mensaje: textoAviso(aviso) } : null);
    showToast("Aviso atendido", "ok");
  } catch (e) { showToast("Se guardó, pero no se pudo marcar el aviso", "err"); }
}

document.getElementById("seg-avisos").addEventListener("click", function (ev) {
  var b = ev.target.closest ? ev.target.closest("button") : null;
  if (!b || !b.dataset.f) { return; }
  document.querySelectorAll("#seg-avisos button").forEach(function (x) { x.classList.remove("on"); });
  b.classList.add("on");
  filtroAvisos = b.dataset.f;
  pintarAvisos();
});

document.getElementById("avisos").addEventListener("click", function (ev) {
  var b = ev.target.closest ? ev.target.closest("[data-atender]") : null;
  if (b) { atenderDesdeBandeja(b.dataset.atender); return; }
  var v = ev.target.closest ? ev.target.closest("[data-vertodos]") : null;
  if (v) {
    filtroAvisos = "todos";
    document.querySelectorAll("#seg-avisos button").forEach(function (x) {
      x.classList.toggle("on", x.dataset.f === "todos");
    });
    pintarAvisos();
  }
});

function esPendiente(x) { return !x.enviada && (x.estado || "pendiente") === "pendiente"; }

function badgeEstado(x) {
  if (x.estado === "atendido") { return '<span class="badge b-gray">Atendido</span>'; }
  if (esVencido(x)) { return '<span class="badge b-red">Vencido</span>'; }
  if (x.enviada || x.estado === "enviado") { return '<span class="badge b-blue">Enviado</span>'; }
  return '<span class="badge b-amber">Pendiente</span>';
}

var ORDEN_AVISO = { parto_proximo: 0, destete: 1, pesaje_pendiente: 2, retiro: 3, otra: 4 };

function pintarAvisos() {
  var corte = new Date();
  corte.setDate(corte.getDate() - 7);
  var corteISO = fechaISO(corte);
  var lista = cacheAvisos.filter(function (x) { return (x.fecha_aviso || "") >= corteISO; });
  lista.sort(function (a, b) {
    var pa = esPendiente(a) ? 0 : 1, pb = esPendiente(b) ? 0 : 1;
    if (pa !== pb) { return pa - pb; }
    var va = esVencido(a) ? 0 : 1, vb = esVencido(b) ? 0 : 1;
    if (va !== vb) { return va - vb; }
    if (a.fecha_aviso !== b.fecha_aviso) { return a.fecha_aviso < b.fecha_aviso ? 1 : -1; }
    return (ORDEN_AVISO[a.tipo] === undefined ? 9 : ORDEN_AVISO[a.tipo]) -
           (ORDEN_AVISO[b.tipo] === undefined ? 9 : ORDEN_AVISO[b.tipo]);
  });
  var pend = lista.filter(esPendiente);
  var tail = document.getElementById("tail-avisos");
  var ping = document.getElementById("ping-avisos");
  if (tail) { tail.textContent = pend.length; tail.classList.toggle("oculto", pend.length === 0); }
  if (ping) { ping.classList.toggle("oculto", pend.length === 0); }
  var ver = filtroAvisos === "pendientes" ? pend : lista;
  var html;
  if (ver.length) {
    html = ver.map(function (x) {
      var atendido = (x.estado === "atendido");
      var btn = atendido
        ? ""
        : ' <button type="button" class="btn sm" data-atender="' + x.id + '">Atender</button>';
      var texto = atendido ? textoAtendido(x) : textoAviso(x);
      return '<div class="alert' + (atendido ? ' atendida' : '') + '"><span class="alert-ico ' + x.tipo + '">' +
        (ICONOS_AVISO[x.tipo] || ICONOS_AVISO.otra) + '</span>' +
        '<div><b>' + tituloAviso(x) + ' ' + badgeEstado(x) + '</b><p>' + texto + '</p>' + btn + '</div>' +
        '<span class="when">' + fechaCorta(x.fecha_aviso) + '</span></div>';
    }).join("");
  } else if (lista.length) {
    html = '<div class="empty"><span class="ico"><svg viewBox="0 0 24 24" aria-hidden="true" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3a6 6 0 0 0-6 6v4l-2 3h16l-2-3V9a6 6 0 0 0-6-6zm0 19a2.5 2.5 0 0 0 2.45-2H9.55A2.5 2.5 0 0 0 12 22z"/></svg></span><b>Todo al día</b><p>No hay pendientes en este filtro.</p><p><button type="button" class="btn sm" data-vertodos="1">Ver todos los avisos</button></p></div>';
  } else {
    html = '<div class="empty"><span class="ico"><svg viewBox="0 0 24 24" aria-hidden="true" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3a6 6 0 0 0-6 6v4l-2 3h16l-2-3V9a6 6 0 0 0-6-6zm0 19a2.5 2.5 0 0 0 2.45-2H9.55A2.5 2.5 0 0 0 12 22z"/></svg></span><b>Sin avisos pendientes</b><p>Genera los de hoy o vuelve cuando registres partos, destetes o pesajes.</p></div>';
  }
  document.getElementById("avisos").innerHTML = html;
}

function tituloAvisoPorId(x) {
  if (x.tipo && NOMBRES_AVISO[x.tipo]) { return NOMBRES_AVISO[x.tipo]; }
  var id = String(x.id || "");
  if (id.indexOf("pesaje_") === 0) { return "Pesaje pendiente"; }
  if (id.indexOf("prox_") === 0) { return "Parto próximo"; }
  if (id.indexOf("destete_") === 0) { return "Destete"; }
  if (id.indexOf("retiro_") === 0) { return "Fin de retiro"; }
  return "Aviso";
}

function pintarAtendidos(lista) {
  var caja = document.getElementById("avisos-atendidos");
  if (!caja) { return; }
  if (!lista.length) {
    caja.innerHTML = '<p class="muted">Todavía no has atendido ningún aviso.</p>';
    return;
  }
  caja.innerHTML = lista.map(function (x) {
    return '<div class="registro"><div class="reg-info"><b>' + escHtml(tituloAvisoPorId(x)) + "</b><span>" +
      escHtml(x.mensaje || "Aviso atendido") + " · " + fechaCortaSinAnio(x.fecha) + "</span></div>" +
      '<button type="button" class="btn sm" data-restaurar="' + escHtml(x.id) + '">Restaurar</button></div>';
  }).join("");
}

document.getElementById("avisos-atendidos").addEventListener("click", async function (ev) {
  var b = ev.target.closest ? ev.target.closest("[data-restaurar]") : null;
  if (!b) { return; }
  b.disabled = true;
  try {
    var r = await api("DELETE", "alertas/" + encodeURIComponent(b.dataset.restaurar) + "/atendido?granja_id=" + cfg().granja);
    showToast(r.resumen || "Aviso restaurado", "ok");
    await cargarAvisos();
  } catch (e) {
    showToast("No se pudo restaurar: " + e.message, "err");
    b.disabled = false;
  }
});

async function cargarAvisos() {
  document.getElementById("avisos").innerHTML = esqueleto(3);
  try {
    cacheAvisos = await api("GET", "alertas?granja_id=" + cfg().granja + "&pendientes=false");
    pintarAvisos();
  } catch (e) { document.getElementById("avisos").innerHTML = tarjeta("Error: " + e.message); }
  try {
    var atendidos = await api("GET", "alertas/atendidos?granja_id=" + cfg().granja);
    pintarAtendidos(atendidos || []);
  } catch (e2) {
    var caja = document.getElementById("avisos-atendidos");
    if (caja) { caja.innerHTML = '<p class="muted">No se pudieron cargar los avisos atendidos.</p>'; }
  }
}

/* ---------- asistente (chat) ---------- */
var chatListo = false;

function escHtml(t) {
  return String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function burbujaAsistente(html, clase) {
  var caja = document.getElementById("chat-msgs");
  var b = document.createElement("div");
  b.className = "chat-msg " + (clase || "a");
  b.innerHTML = html;
  caja.appendChild(b);
  caja.scrollTop = caja.scrollHeight;
  return b;
}

function cargarAsistente() {
  if (chatListo) { return; }
  chatListo = true;
  if (typeof MODO_DEMO !== "undefined" && MODO_DEMO) {
    document.getElementById("f-chat").classList.add("oculto");
    burbujaAsistente("¡Hola! Soy el asistente de CuyMax. En esta versión publicada (demo) estoy desactivado, porque necesito el servidor de la granja para consultar y registrar datos.");
    burbujaAsistente("En la versión instalada me puedes escribir cosas como:<br><br>• «se murieron 2 cuyes en P-001 por diarrea»<br>• «¿cómo va la poza P-002?»<br>• «¿qué avisos tengo pendientes?»");
    return;
  }
  burbujaAsistente("¡Hola! Soy el asistente de CuyMax. Cuéntame lo que pasó en la granja (por ejemplo: «se murieron 2 cuyes en P-001 por diarrea») o pregúntame cómo va una poza o qué avisos hay pendientes.");
  renderizarChipsAsistente();
}

/* ---------- ventana flotante del asistente ---------- */
var iaPanel = document.getElementById("ia-panel");
var iaFab = document.getElementById("ia-fab");
var iaUltimoFoco = null;

function asistenteAbierto() {
  return !!iaPanel && !iaPanel.hidden;
}

function abrirAsistente() {
  if (!iaPanel) { return; }
  iaUltimoFoco = document.activeElement;
  iaPanel.hidden = false;
  if (iaFab) {
    iaFab.classList.add("oculto");
    iaFab.setAttribute("aria-expanded", "true");
  }
  cargarAsistente();
  var caja = document.getElementById("chat-msgs");
  if (caja) { caja.scrollTop = caja.scrollHeight; }
  var inp = document.getElementById("chat-texto");
  var form = document.getElementById("f-chat");
  if (inp && form && !form.classList.contains("oculto")) {
    setTimeout(function () { inp.focus(); }, 60);
  }
}

function cerrarAsistente(devolverFoco) {
  if (!iaPanel || iaPanel.hidden) { return; }
  iaPanel.hidden = true;
  if (iaFab) {
    iaFab.classList.remove("oculto");
    iaFab.setAttribute("aria-expanded", "false");
    if (devolverFoco !== false) { iaFab.focus(); }
  }
}

if (iaFab) {
  iaFab.addEventListener("click", function () {
    if (asistenteAbierto()) { cerrarAsistente(); } else { abrirAsistente(); }
  });
}
var iaCerrar = document.getElementById("ia-cerrar");
if (iaCerrar) { iaCerrar.addEventListener("click", function () { cerrarAsistente(); }); }

document.addEventListener("keydown", function (ev) {
  if (ev.key === "Escape" && asistenteAbierto()) { cerrarAsistente(); }
});

/* Atajo: Ctrl/⌘ + K abre el asistente desde cualquier pestaña. */
document.addEventListener("keydown", function (ev) {
  if ((ev.ctrlKey || ev.metaKey) && String(ev.key).toLowerCase() === "k") {
    ev.preventDefault();
    if (asistenteAbierto()) { cerrarAsistente(); } else { abrirAsistente(); }
  }
});

function renderizarChipsAsistente() {
  var caja = document.getElementById("chat-chips");
  if (!caja) { return; }
  var sugerencias = ["¿Cuántos vivos tiene P-001?", "¿Cómo va la poza P-002?", "¿Qué avisos tengo pendientes?", "Se murieron 2 cuyes en P-001 por diarrea"];
  caja.innerHTML = sugerencias.map(function (s) {
    return '<button type="button" class="chip btn sm" data-chip="' + escHtml(s) + '">' + escHtml(s) + "</button>";
  }).join("");
  caja.querySelectorAll("[data-chip]").forEach(function (b) {
    b.addEventListener("click", function () {
      var inp = document.getElementById("chat-texto");
      inp.value = b.dataset.chip;
      inp.focus();
    });
  });
}

function pintarPropuestaChat(r) {
  var caja = document.getElementById("chat-msgs");
  var m = document.createElement("div");
  m.className = "chat-msg a propuesta";
  var p = document.createElement("p");
  p.textContent = "Entendí: " + r.resumen + ". ¿Lo guardo?";
  m.appendChild(p);
  var acc = document.createElement("div");
  acc.className = "chat-acciones";
  var bOk = document.createElement("button");
  bOk.type = "button"; bOk.className = "btn primary sm"; bOk.textContent = "Confirmar";
  var bNo = document.createElement("button");
  bNo.type = "button"; bNo.className = "btn sm"; bNo.textContent = "Cancelar";
  acc.appendChild(bOk);
  acc.appendChild(bNo);
  m.appendChild(acc);
  caja.appendChild(m);
  caja.scrollTop = caja.scrollHeight;
  bNo.addEventListener("click", function () {
    acc.remove();
    burbujaAsistente("Cancelado, no guardé nada.");
  });
  bOk.addEventListener("click", async function () {
    acc.remove();
    p.textContent = "Guardando…";
    try {
      var res = await api("POST", "asistente/confirmar", { granja_id: cfg().granja, accion: r.accion, datos: r.datos });
      p.textContent = res.texto || "Listo.";
      showToast("Guardado desde el asistente", "ok");
      llenarSelectsLotes();
      cargarRegistros();
      cargarPanel();
    } catch (e) {
      p.textContent = "No se pudo guardar: " + e.message;
    }
  });
}

document.getElementById("f-chat").addEventListener("submit", async function (ev) {
  ev.preventDefault();
  var inp = document.getElementById("chat-texto");
  var btn = document.getElementById("chat-enviar");
  var texto = (inp.value || "").trim();
  if (!texto) { return; }
  burbujaAsistente(escHtml(texto), "u");
  inp.value = "";
  var chips = document.getElementById("chat-chips");
  if (chips) { chips.classList.add("oculto"); }
  btn.disabled = true;
  var pensando = burbujaAsistente("Pensando…", "a pensando");
  try {
    var r = await api("POST", "asistente", { granja_id: cfg().granja, texto: texto });
    pensando.remove();
    if (r.tipo === "propuesta") { pintarPropuestaChat(r); }
    else { burbujaAsistente(md(r.texto || "No entendí el mensaje.")); }
  } catch (e) {
    pensando.remove();
    burbujaAsistente(escHtml("No pude responder: " + e.message), "a err");
  }
  btn.disabled = false;
  inp.focus();
});

/* ---------- últimos registros y borrado ---------- */
var NOMBRE_REGISTRO = {
  peso: "Peso", muerte: "Muerte", alimento: "Alimento", parto: "Parto",
  destete: "Destete", venta: "Venta", faena: "Faena", retiro: "Retiro"
};

async function cargarRegistros() {
  var caja = document.getElementById("registros");
  if (!caja) { return; }
  if (typeof MODO_DEMO !== "undefined" && MODO_DEMO) {
    caja.innerHTML = vacio("El historial con borrado está disponible en la versión instalada.");
    return;
  }
  caja.innerHTML = esqueleto(2);
  try {
    var lista = await api("GET", "registros?granja_id=" + cfg().granja + "&limite=15");
    if (!lista.length) {
      caja.innerHTML = vacio("Todavía no hay movimientos registrados.");
      return;
    }
    caja.innerHTML = lista.map(function (r) {
      var quien = r.lote ? r.lote : (r.hembra || "");
      return '<div class="registro">' +
        '<span class="reg-tipo t-' + r.tipo + '">' + (NOMBRE_REGISTRO[r.tipo] || r.tipo) + "</span>" +
        '<div class="reg-info"><b>' + escHtml(quien) + "</b><span>" + escHtml(r.detalle) + " · " + fechaCortaSinAnio(r.fecha) + "</span></div>" +
        '<button type="button" class="btn sm" data-borrar="' + r.tipo + ":" + r.id + '">Borrar</button>' +
        "</div>";
    }).join("");
  } catch (e) {
    caja.innerHTML = tarjeta("Error: " + e.message);
  }
}

document.getElementById("registros").addEventListener("click", async function (ev) {
  var b = ev.target.closest ? ev.target.closest("[data-borrar]") : null;
  if (!b) { return; }
  var partes = b.dataset.borrar.split(":");
  if (!confirm("¿Borrar este registro? No se puede deshacer.")) { return; }
  b.disabled = true;
  try {
    await api("DELETE", "registros/" + encodeURIComponent(partes[0]) + "/" + encodeURIComponent(partes[1]) + "?granja_id=" + cfg().granja);
    showToast("Registro borrado", "ok");
    await cargarRegistros();
    llenarSelectsLotes();
    cargarPanel();
  } catch (e) {
    showToast("No se pudo borrar: " + e.message, "err");
    b.disabled = false;
  }
});

/* Arranque: en modo monitoreo espera a que Firebase restaure la sesión y el
   token antes de pedir datos; en local/demo arranca de inmediato. */
(async function iniciarPanel() {
  if (window.cuymaxAuthListo) {
    try { await window.cuymaxAuthListo; } catch (e) { /* sigue con lo que haya */ }
  }
  /* Todo lo independiente arranca a la vez: así los KPI no esperan a los ajustes. */
  var pAjustes = cargarAjustesGranja();
  var pPanel = cargarPanel();
  var pSelects = llenarSelectsLotes();
  var pPozas = cargarPozas();
  pintarUbicaciones();
  await Promise.all([pAjustes, pPanel, pSelects, pPozas]);
  generarAutomatico();
  /* Si se llegó pegando una etiqueta NFC, abre la ficha de esa poza. */
  aplicarPozaDeUrl(await pSelects);
})();
