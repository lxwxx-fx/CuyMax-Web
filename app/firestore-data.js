/* CuyMax — datos reales en Firestore (pantalla "Monitorear").
   Se usa cuando el panel abre con ?modo=real. Cada cuenta es una granja:
   el campo granja_id de todos los documentos es el uid de Firebase Auth y las
   reglas de Firestore impiden ver o tocar los datos de otra cuenta.
   Colecciones raíz: granjas, lotes, pozas, pesajes, mortalidad, consumo_alimento,
   partos, partos_proximos, destetes, ventas, faenas, retiros, avisos_atendidos. */
"use strict";

var _fsdb = null;
var _fsGranjaCache = null;
var _fsPozasCache = null;

function fsdb() {
  if (_fsdb) { return _fsdb; }
  if (typeof firebase === "undefined" || !firebase.firestore) {
    throw new Error("Firebase no terminó de cargar. Revisa tu conexión e inténtalo de nuevo.");
  }
  if (!firebase.apps || !firebase.apps.length) { firebase.initializeApp(FIREBASE_CONFIG); }
  _fsdb = firebase.firestore();
  return _fsdb;
}

/* Identificador de la granja = uid de la cuenta con sesión iniciada.
   Sin sesión no se lee ni se escribe nada: la app pide volver a entrar. */
function fsGranja() {
  var u = null;
  try {
    if (typeof firebase !== "undefined" && firebase.auth) { u = firebase.auth().currentUser; }
  } catch (e) { u = null; }
  if (!u || !u.uid) {
    throw new Error("Tu sesión no está activa. Vuelve a iniciar sesión.");
  }
  return u.uid;
}

/* Fecha de hoy en la zona horaria de Perú (no en UTC): así un registro hecho
   a las 20:00 sigue siendo del mismo día. */
function fsFechaLocal(d) {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Lima", year: "numeric", month: "2-digit", day: "2-digit"
    }).format(d || new Date());
  } catch (e) {
    return (d || new Date()).toISOString().slice(0, 10);
  }
}

function fsHoy() { return fsFechaLocal(new Date()); }

function fsSumaDias(dias) {
  var d = new Date();
  d.setDate(d.getDate() + dias);
  return fsFechaLocal(d);
}

function fsNum(x) {
  var v = Number(x);
  return isNaN(v) || !isFinite(v) ? 0 : v;
}

function fsUp(x) { return String(x || "").trim().toUpperCase(); }

/* Días que faltan para una fecha (negativo = ya pasó). */
function fsDias(fecha) {
  if (!fecha) { return null; }
  var d = new Date(String(fecha).slice(0, 10) + "T00:00:00");
  if (isNaN(d.getTime())) { return null; }
  var hoy = new Date();
  hoy.setHours(0, 0, 0, 0);
  return Math.round((d - hoy) / 86400000);
}

/* Todos los documentos de una colección que pertenecen a la cuenta activa.
   Si dos pantallas piden la misma colección al mismo tiempo (p. ej. el panel y
   los selects), comparten una sola consulta: se evita duplicar la ida y vuelta. */
var _fsEnCurso = {};

async function fsTodos(nombre) {
  var g = fsGranja();
  var clave = g + "|" + nombre;
  if (_fsEnCurso[clave]) { return _fsEnCurso[clave].then(function (f) { return f.slice(); }); }
  var consulta = (async function () {
    var snap = await fsdb().collection(nombre).where("granja_id", "==", g).get();
    var filas = [];
    snap.forEach(function (d) {
      var x = d.data() || {};
      x.__id = d.id;
      filas.push(x);
    });
    return filas;
  })();
  _fsEnCurso[clave] = consulta;
  try {
    return (await consulta).slice();
  } finally {
    delete _fsEnCurso[clave];
  }
}

function fsLoteDoc(codigo) {
  return fsdb().collection("lotes").doc("g" + fsGranja() + "_" + fsUp(codigo));
}

function fsEsDeGranja(x) {
  if (!x || x.granja_id == null) { return false; }
  return String(x.granja_id) === fsGranja();
}

function fsLoteEsDeGranja(x) { return fsEsDeGranja(x); }

/* Busca un lote por código dentro de la cuenta activa. */
async function fsLoteActual(codigo) {
  var cod = fsUp(codigo);
  if (!cod) { return null; }
  var snap = await fsdb().collection("lotes")
    .where("granja_id", "==", fsGranja())
    .where("codigo", "==", cod)
    .limit(1)
    .get();
  if (snap.empty) { return null; }
  var doc = snap.docs[0];
  return { ref: doc.ref, snap: doc, data: doc.data() || {} };
}

function fsLoteFila(x) {
  var inicial = fsNum(x.cantidad_inicial);
  var muertos = fsNum(x.muertos);
  var edad = x.fecha_inicio ? fsDias(x.fecha_inicio) : null;
  var codigo = x.codigo || String(x.__id || "").replace(/^g[^_]*_/, "");
  return {
    codigo: codigo,
    nombre: x.nombre || "",
    etapa: x.etapa || "engorde",
    estado: x.estado || "abierto",
    cantidad_inicial: inicial,
    vivos: fsNum(x.vivos),
    muertos: muertos,
    vendidos: fsNum(x.vendidos),
    faenados: fsNum(x.faenados),
    alimento_kg: fsNum(x.alimento_kg),
    ultimo_peso_g: x.ultimo_peso_g == null ? null : fsNum(x.ultimo_peso_g),
    mortalidad_pct: inicial > 0 ? Math.round((muertos / inicial) * 1000) / 10 : 0,
    edad_dias: edad == null ? 0 : Math.max(0, -edad),
    fecha_inicio: x.fecha_inicio ? String(x.fecha_inicio).slice(0, 10) : null,
    peso_objetivo_g: x.peso_objetivo_g == null ? null : fsNum(x.peso_objetivo_g),
    poza_codigo: x.poza_codigo || ""
  };
}

/* ---------- granja y precios ---------- */

async function fsGranjaDoc(recargar) {
  var g = fsGranja();
  /* Los precios cambian poco: se guardan 2 minutos para no repetir la consulta
     en cada pantalla (resumen, avisos, panel...). */
  if (!recargar && _fsGranjaCache && _fsGranjaCache.g === g && (Date.now() - _fsGranjaCache.t) < 120000) {
    return _fsGranjaCache.d;
  }
  var snap = await fsdb().collection("granjas").where("granja_id", "==", g).limit(1).get();
  if (!snap.empty) {
    var datos = snap.docs[0].data() || {};
    _fsGranjaCache = { g: g, t: Date.now(), d: datos };
    return datos;
  }
  var nueva = {
    granja_id: g,
    nombre: "Mi granja",
    precios: {},
    creado_en: new Date().toISOString()
  };
  await fsdb().collection("granjas").doc(g).set(nueva);
  _fsGranjaCache = { g: g, t: Date.now(), d: nueva };
  return nueva;
}

function fsPreciosDe(granja) {
  var p = (granja || {}).precios || {};
  var bal = p.balanceado_kg == null ? null : fsNum(p.balanceado_kg);
  var forr = p.forraje_kg == null ? null : fsNum(p.forraje_kg);
  var cuy = p.cuy == null ? null : fsNum(p.cuy);
  if (bal === null && forr === null && cuy === null) { return null; }
  return { balanceado_kg: bal, forraje_kg: forr, cuy: cuy };
}

async function fsGuardarGranja(datos) {
  var g = fsGranja();
  var actual = await fsGranjaDoc();
  var precios = actual.precios || {};
  if (datos && datos.precios) {
    ["balanceado_kg", "forraje_kg", "cuy"].forEach(function (k) {
      if (datos.precios[k] != null && datos.precios[k] !== "") { precios[k] = fsNum(datos.precios[k]); }
    });
  }
  var nuevo = {
    granja_id: g,
    nombre: (datos && datos.nombre ? String(datos.nombre).trim() : actual.nombre) || "Mi granja",
    precios: precios,
    actualizado_en: new Date().toISOString()
  };
  await fsdb().collection("granjas").doc(g).set(nuevo, { merge: true });
  _fsGranjaCache = { g: g, t: Date.now(), d: Object.assign({}, actual, nuevo) };
  return { ok: true, resumen: "Granja actualizada", detalle: nuevo.nombre };
}

/* Avisos derivados de los datos reales (no se guardan: se calculan al vuelo). */
function fsAvisosDe(lotes, proximos, ultimosPesajes, partos, retiros, atendidos) {
  var hoy = fsHoy();
  var avisos = [];

  proximos.forEach(function (p) {
    var d = fsDias(p.fecha_objetivo);
    if (d === null || d > 10 || d < -5) { return; }
    var id = "prox_" + (p.hembra || p.__id);
    if (atendidos[id]) { return; }
    var cuando = d < 0 ? "ya debió parir (atrasado " + (-d) + " días)" : (d === 0 ? "pare hoy" : "pare en " + d + " día" + (d === 1 ? "" : "s"));
    avisos.push({
      id: id, tipo: "parto_proximo", hembra: p.hembra || "", poza: p.poza || "",
      fecha_objetivo: String(p.fecha_objetivo || "").slice(0, 10), fecha_aviso: hoy,
      mensaje: "La hembra " + (p.hembra || "(sin arete)") + " (ubicación " + (p.poza || "s/u") + ") " + cuando + ".",
      enviada: false, estado: "pendiente"
    });
  });

  lotes.forEach(function (l) {
    if ((l.estado || "abierto") !== "abierto" || !l.codigo) { return; }
    var ultimo = ultimosPesajes[l.codigo];
    var dias = ultimo ? -fsDias(ultimo) : null;
    if (dias !== null && dias < 7) { return; }
    var id = "pesaje_" + l.codigo;
    if (atendidos[id]) { return; }
    avisos.push({
      id: id, tipo: "pesaje_pendiente", lote: l.codigo, hembra: null, poza: null,
      fecha_aviso: hoy,
      mensaje: dias === null
        ? "La poza " + l.codigo + " todavía no tiene ningún pesaje registrado."
        : "La poza " + l.codigo + " lleva " + dias + " días sin pesaje.",
      enviada: false, estado: "pendiente"
    });
  });

  partos.forEach(function (p) {
    if (p.destetado) { return; }
    var d = fsDias(p.fecha_destete_prevista);
    if (d === null || d > 1) { return; }
    var id = "destete_" + (p.hembra || p.__id);
    if (atendidos[id]) { return; }
    var crias = p.crias_actuales == null ? fsNum(p.nacidos_vivos) : fsNum(p.crias_actuales);
    if (crias <= 0) { return; }
    var texto = d < 0
      ? "Las crías de " + (p.hembra || "la hembra") + " tenían que destetarse hace " + (-d) + " día" + (-d === 1 ? "" : "s") + "."
      : (d === 0 ? "Hoy toca destetar a las crías de " + (p.hembra || "la hembra") + "." : "Mañana toca destetar a las crías de " + (p.hembra || "la hembra") + ".");
    avisos.push({
      id: id, tipo: "destete", hembra: p.hembra || "", poza: p.poza || "",
      fecha_objetivo: String(p.fecha_destete_prevista || "").slice(0, 10), fecha_aviso: hoy,
      mensaje: texto + " Destete recomendado entre 15 y 21 días (" + crias + " crías).",
      enviada: false, estado: "pendiente"
    });
  });

  retiros.forEach(function (r) {
    var d = fsDias(r.fecha_fin_retiro);
    if (d === null || d > 3 || d < -3) { return; }
    var id = "retiro_" + r.__id;
    if (atendidos[id]) { return; }
    avisos.push({
      id: id, tipo: "retiro", lote: r.lote || "", hembra: null, poza: r.poza || null,
      fecha_objetivo: String(r.fecha_fin_retiro || "").slice(0, 10), fecha_aviso: hoy,
      mensaje: d > 0
        ? "La poza " + (r.lote || r.poza) + " sigue en retiro sanitario por " + (r.producto || "tratamiento") + " (" + d + " día" + (d === 1 ? "" : "s") + ")."
        : "La poza " + (r.lote || r.poza) + " ya cumplió el retiro de " + (r.producto || "tratamiento") + ": se puede vender.",
      enviada: false, estado: "pendiente"
    });
  });

  return avisos;
}

/* ---------- escrituras ---------- */

async function fsRegistrarPeso(datos) {
  var cod = fsUp(datos.lote);
  var actual = await fsLoteActual(cod);
  if (!actual) { throw new Error("No existe la poza " + cod + " en la granja."); }
  var peso = fsNum(datos.peso_g);
  var muestra = datos.animales_pesados == null ? 10 : fsNum(datos.animales_pesados);
  if (peso < 20 || peso > 3000) {
    throw new Error("Peso fuera de rango. Debe ir en gramos, por ejemplo 720.");
  }
  if (muestra <= 0 || muestra !== Math.round(muestra)) {
    throw new Error("La muestra debe ser un número entero mayor que cero.");
  }
  var antes = actual.data.ultimo_peso_g;
  await fsdb().collection("pesajes").add({
    granja_id: fsGranja(), lote: cod, fecha: fsHoy(),
    peso_promedio_g: peso, animales_pesados: muestra, creado_en: new Date().toISOString()
  });
  await actual.ref.update({ ultimo_peso_g: peso });
  return {
    ok: true, resumen: "peso de la poza " + cod + ": " + peso + " g",
    detalle: antes == null ? "" : "Antes: " + fsNum(antes) + " g."
  };
}

async function fsRegistrarMuerte(datos) {
  var cod = fsUp(datos.lote);
  var actual = await fsLoteActual(cod);
  if (!actual) { throw new Error("No existe la poza " + cod + " en la granja."); }
  var x = actual.data;
  var vivos = fsNum(x.vivos);
  var cant = fsNum(datos.cantidad);
  if (cant <= 0 || cant !== Math.round(cant)) { throw new Error("La cantidad de muertes debe ser un número entero mayor que cero."); }
  if (cant > vivos) { throw new Error("La poza " + cod + " solo tiene " + vivos + " vivos."); }
  var causa = (datos.causa || "").trim().slice(0, 100) || null;
  await fsdb().collection("mortalidad").add({
    granja_id: fsGranja(), lote: cod, fecha: fsHoy(), cantidad: cant,
    causa: causa, creado_en: new Date().toISOString()
  });
  await actual.ref.update({ vivos: vivos - cant, muertos: fsNum(x.muertos) + cant });
  return { ok: true, resumen: cant + " muerte(s) en la poza " + cod, detalle: "Quedan " + (vivos - cant) + " vivos." };
}

async function fsRegistrarAlimento(datos) {
  var cod = fsUp(datos.lote);
  var actual = await fsLoteActual(cod);
  if (!actual) { throw new Error("No existe la poza " + cod + " en la granja."); }
  var kg = fsNum(datos.kg);
  if (kg <= 0 || kg > 500) { throw new Error("Los kilos de alimento no parecen correctos."); }
  var tipo = (datos.tipo || "").trim().toLowerCase();
  if (tipo !== "forraje" && tipo !== "balanceado") {
    throw new Error("Dime si el alimento fue forraje o balanceado.");
  }
  await fsdb().collection("consumo_alimento").add({
    granja_id: fsGranja(), lote: cod, fecha: fsHoy(), tipo: tipo, kg: kg,
    creado_en: new Date().toISOString()
  });
  await actual.ref.update({ alimento_kg: Math.round((fsNum(actual.data.alimento_kg) + kg) * 100) / 100 });
  return { ok: true, resumen: kg + " kg de " + tipo + " para la poza " + cod, detalle: "" };
}

/* Programar un parto: la hembra entra a partos próximos. */
async function fsProgramarParto(datos) {
  var hembra = fsUp(datos.hembra);
  var poza = fsUp(datos.poza);
  if (!hembra) { throw new Error("Dime el arete de la hembra (por ejemplo H003)."); }
  var fecha = String(datos.fecha_objetivo || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha) || fsDias(fecha) === null) {
    throw new Error("Dime una fecha estimada válida para el parto.");
  }
  var existentes = await fsTodos("partos_proximos");
  var repetida = existentes.filter(function (p) { return fsUp(p.hembra) === hembra; });
  if (repetida.length) { throw new Error("La hembra " + hembra + " ya tiene un parto programado."); }
  await fsdb().collection("partos_proximos").add({
    granja_id: fsGranja(), hembra: hembra, poza: poza || "", fecha_objetivo: fecha,
    creado_en: new Date().toISOString()
  });
  var d = fsDias(fecha);
  var cuando = "";
  if (d === 0) { cuando = "Es hoy."; }
  else if (d < 0) { cuando = "Fecha ya pasada (atrasado " + (-d) + " día" + (-d === 1 ? "" : "s") + ")."; }
  else if (d > 0) { cuando = "Faltan " + d + " día" + (d === 1 ? "" : "s") + "."; }
  return { ok: true, resumen: "parto de " + hembra + " programado", detalle: cuando };
}

async function fsRegistrarParto(datos) {
  var hembra = fsUp(datos.hembra);
  var poza = fsUp(datos.poza);
  if (!hembra && !poza) { throw new Error("¿Qué hembra parió? Dime su arete (por ejemplo H003) o la ubicación."); }
  var proximos = await fsTodos("partos_proximos");
  var encontrados = proximos.filter(function (p) {
    if (hembra) { return fsUp(p.hembra) === hembra; }
    return fsUp(p.poza) === poza;
  });
  if (!encontrados.length) { throw new Error("No encuentro una hembra en gestación con ese dato."); }
  if (encontrados.length > 1) {
    throw new Error("Hay varias hembras en gestación ahí (" + encontrados.map(function (p) { return p.hembra; }).join(", ") + "). ¿Cuál parió?");
  }
  var p = encontrados[0];
  var vivos = fsNum(datos.nacidos_vivos);
  var muertos = fsNum(datos.nacidos_muertos);
  if (vivos !== Math.round(vivos) || muertos !== Math.round(muertos) ||
      vivos < 0 || muertos < 0 || vivos > 15 || muertos > 15 || vivos + muertos <= 0) {
    throw new Error("La cantidad de crías no parece correcta.");
  }
  await fsdb().collection("partos").add({
    granja_id: fsGranja(), hembra: fsUp(p.hembra || hembra), poza: fsUp(p.poza || poza),
    fecha: fsHoy(), nacidos_vivos: vivos, nacidos_muertos: muertos,
    crias_actuales: vivos, destetado: vivos === 0,
    fecha_destete_prevista: fsSumaDias(16),
    creado_en: new Date().toISOString()
  });
  await fsdb().collection("partos_proximos").doc(p.__id).delete();
  return {
    ok: true, resumen: "parto registrado: " + vivos + " vivos y " + muertos + " muertos",
    detalle: "Destete previsto para el " + fsSumaDias(16) + "."
  };
}

/* Destete: las crías pasan a una poza en etapa recría. */
async function fsRegistrarDestete(datos) {
  var hembra = fsUp(datos.hembra);
  if (!hembra) { throw new Error("Dime el arete de la hembra cuyas crías se destetan."); }
  var cant = fsNum(datos.cantidad);
  if (cant <= 0 || cant !== Math.round(cant)) { throw new Error("La cantidad de crías debe ser un número entero mayor que cero."); }
  var destino = fsUp(datos.poza_destino);
  if (!destino) { throw new Error("Dime a qué poza pasan las crías."); }
  var partos = await fsTodos("partos");
  var pendientes = partos.filter(function (p) { return fsUp(p.hembra) === hembra && !p.destetado; });
  pendientes.sort(function (a, b) { return String(a.fecha || "") < String(b.fecha || "") ? 1 : -1; });
  if (!pendientes.length) { throw new Error("No encuentro crías pendientes de destete para " + hembra + "."); }
  var p = pendientes[0];
  var crias = p.crias_actuales == null ? fsNum(p.nacidos_vivos) : fsNum(p.crias_actuales);
  if (cant > crias) { throw new Error("Esa hembra solo tiene " + crias + " cría(s) por destetar."); }
  var quedan = crias - cant;
  await fsdb().collection("partos").doc(p.__id).update({
    crias_actuales: quedan, destetado: quedan === 0, fecha_destete: fsHoy()
  });
  await fsdb().collection("destetes").add({
    granja_id: fsGranja(), hembra: hembra, cantidad: cant, poza_destino: destino,
    fecha: fsHoy(), parto_id: p.__id, creado_en: new Date().toISOString()
  });
  var loteActual = await fsLoteActual(destino);
  if (loteActual) {
    var l = loteActual.data || {};
    await loteActual.ref.update({
      vivos: fsNum(l.vivos) + cant,
      cantidad_inicial: fsNum(l.cantidad_inicial) + cant
    });
  } else {
    await fsLoteDoc(destino).set({
      granja_id: fsGranja(), codigo: destino, nombre: "", etapa: "recria", estado: "abierto",
      cantidad_inicial: cant, vivos: cant, muertos: 0, vendidos: 0, faenados: 0,
      alimento_kg: 0, ultimo_peso_g: null, peso_objetivo_g: null, poza_codigo: destino,
      fecha_inicio: fsHoy(), creado_en: new Date().toISOString()
    });
  }
  return {
    ok: true, resumen: cant + " cría(s) destetadas a la poza " + destino,
    detalle: quedan > 0 ? "Quedan " + quedan + " con la madre." : "Ya no quedan crías con esa hembra."
  };
}

async function fsRegistrarIngreso(datos) {
  var cod = fsUp(datos.lote);
  var actual = await fsLoteActual(cod);
  if (!actual) { throw new Error("No existe la poza " + cod + " en la granja."); }
  var x = actual.data;
  var cant = fsNum(datos.cantidad);
  if (cant <= 0 || cant !== Math.round(cant)) { throw new Error("La cantidad de cuyes debe ser un número entero mayor que cero."); }
  var inicial = fsNum(x.cantidad_inicial) + cant;
  await actual.ref.update({ vivos: fsNum(x.vivos) + cant, cantidad_inicial: inicial });
  return { ok: true, resumen: cant + " cuyes ingresados a la poza " + cod, detalle: "Ahora son " + inicial + " en total." };
}

/* Acepta el código o el id de una ubicación y devuelve su código.
   Vacío = sin ubicación. Si no existe, falla en vez de ignorarla. */
async function fsResolverPoza(pozaId) {
  if (pozaId == null || pozaId === "") { return ""; }
  var pid = String(pozaId);
  if (!pid || pid === "NaN" || pid === "undefined") { return ""; }
  var pozas = await fsTodos("pozas");
  for (var i = 0; i < pozas.length; i++) {
    if (pozas[i].__id === pid || fsUp(pozas[i].codigo) === fsUp(pid)) {
      return pozas[i].codigo || pid;
    }
  }
  throw new Error("No existe la ubicación " + pid + " en la granja.");
}

async function fsCrearLote(datos) {
  var cod = fsUp(datos.codigo);
  if (!cod) { throw new Error("Dime el código de la poza nueva."); }
  var ya = await fsLoteActual(cod);
  if (ya) { throw new Error("La poza " + cod + " ya existe en esta granja."); }
  var inicial = fsNum(datos.cantidad_inicial);
  if (inicial <= 0 || inicial !== Math.round(inicial)) {
    throw new Error("La cantidad inicial debe ser un número entero mayor que cero.");
  }
  var etapa = (datos.etapa || "engorde").toLowerCase();
  if (etapa !== "recria" && etapa !== "engorde") {
    throw new Error("La etapa debe ser recría o engorde.");
  }
  var pozaCodigo = await fsResolverPoza(datos.poza_id);
  await fsLoteDoc(cod).set({
    granja_id: fsGranja(), codigo: cod, nombre: "", etapa: etapa,
    estado: "abierto", cantidad_inicial: inicial, vivos: inicial, muertos: 0,
    vendidos: 0, faenados: 0, alimento_kg: 0, ultimo_peso_g: null,
    peso_objetivo_g: null, poza_codigo: pozaCodigo, fecha_inicio: fsHoy(),
    creado_en: new Date().toISOString()
  });
  return {
    ok: true, resumen: "poza " + cod + " creada con " + inicial + " cuyes",
    detalle: "Ya puedes pesarla y registrar su alimento."
  };
}

async function fsRegistrarVenta(datos) {
  var cod = fsUp(datos.lote);
  var actual = await fsLoteActual(cod);
  if (!actual) { throw new Error("No existe la poza " + cod + " en la granja."); }
  var x = actual.data;
  var vivos = fsNum(x.vivos);
  var cant = fsNum(datos.cantidad);
  if (cant <= 0 || cant !== Math.round(cant)) { throw new Error("La cantidad vendida debe ser un número entero mayor que cero."); }
  if (cant > vivos) { throw new Error("La poza " + cod + " solo tiene " + vivos + " vivos."); }
  var precio = datos.precio_unitario == null || datos.precio_unitario === "" ? null : fsNum(datos.precio_unitario);
  if (precio === null) {
    var pr = fsPreciosDe(await fsGranjaDoc());
    precio = pr && pr.cuy != null ? pr.cuy : 0;
  }
  if (precio < 0) { throw new Error("El precio por cuy no puede ser negativo."); }
  await fsdb().collection("ventas").add({
    granja_id: fsGranja(), lote: cod, fecha: fsHoy(), cantidad: cant,
    precio_unitario: precio, creado_en: new Date().toISOString()
  });
  await actual.ref.update({ vivos: vivos - cant, vendidos: fsNum(x.vendidos) + cant });
  return {
    ok: true, resumen: cant + " cuy(es) vendidos de la poza " + cod,
    detalle: "Ingreso: S/ " + (Math.round(cant * precio * 100) / 100).toFixed(2) + ". Quedan " + (vivos - cant) + " vivos."
  };
}

async function fsRegistrarFaena(datos) {
  var cod = fsUp(datos.lote);
  var actual = await fsLoteActual(cod);
  if (!actual) { throw new Error("No existe la poza " + cod + " en la granja."); }
  var x = actual.data;
  var vivos = fsNum(x.vivos);
  var cant = fsNum(datos.cantidad);
  if (cant <= 0 || cant !== Math.round(cant)) { throw new Error("La cantidad faenada debe ser un número entero mayor que cero."); }
  if (cant > vivos) { throw new Error("La poza " + cod + " solo tiene " + vivos + " vivos."); }
  await fsdb().collection("faenas").add({
    granja_id: fsGranja(), lote: cod, fecha: fsHoy(), cantidad: cant,
    creado_en: new Date().toISOString()
  });
  await actual.ref.update({ vivos: vivos - cant, faenados: fsNum(x.faenados) + cant });
  return { ok: true, resumen: cant + " cuy(es) faenados de la poza " + cod, detalle: "Quedan " + (vivos - cant) + " vivos." };
}

async function fsRegistrarRetiro(datos) {
  var cod = fsUp(datos.lote);
  var actual = await fsLoteActual(cod);
  if (!actual) { throw new Error("No existe la poza " + cod + " en la granja."); }
  var producto = (datos.producto || "").trim();
  if (!producto) { throw new Error("Dime qué producto se aplicó."); }
  var dias = fsNum(datos.dias);
  if (dias <= 0 || dias > 90 || dias !== Math.round(dias)) { throw new Error("Los días de retiro no parecen correctos."); }
  var fin = fsSumaDias(dias);
  await fsdb().collection("retiros").add({
    granja_id: fsGranja(), lote: cod, poza: null, producto: producto,
    tipo: "tratamiento", fecha_inicio: fsHoy(), fecha_fin_retiro: fin,
    dias: dias, creado_en: new Date().toISOString()
  });
  return {
    ok: true, resumen: "retiro sanitario de " + dias + " día(s) para la poza " + cod,
    detalle: "No vender hasta el " + fin + "."
  };
}

/* ---------- gestión de pozas y ubicaciones ---------- */

async function fsActualizarLote(codigo, datos) {
  var cod = fsUp(codigo);
  var actual = await fsLoteActual(cod);
  if (!actual) { throw new Error("No existe la poza " + cod + " en la granja."); }
  var upd = {};
  if (datos.nombre !== undefined && datos.nombre !== null) {
    upd.nombre = String(datos.nombre).trim().slice(0, 60);
  }
  if (datos.etapa !== undefined) {
    var etapa = String(datos.etapa || "").toLowerCase();
    if (etapa !== "recria" && etapa !== "engorde") { throw new Error("La etapa debe ser recría o engorde."); }
    upd.etapa = etapa;
  }
  if (datos.estado !== undefined) {
    var estado = String(datos.estado || "").toLowerCase();
    if (estado !== "abierto" && estado !== "cerrado") { throw new Error("El estado debe ser abierto o cerrado."); }
    upd.estado = estado;
  }
  if (datos.poza_id !== undefined) { upd.poza_codigo = await fsResolverPoza(datos.poza_id); }
  if (datos.peso_objetivo_g !== undefined) {
    if (datos.peso_objetivo_g === null || datos.peso_objetivo_g === "") { upd.peso_objetivo_g = null; }
    else {
      var p = fsNum(datos.peso_objetivo_g);
      if (p < 20 || p > 3000) { throw new Error("El peso objetivo debe estar entre 20 y 3000 g."); }
      upd.peso_objetivo_g = Math.round(p);
    }
  }
  if (!Object.keys(upd).length) { throw new Error("No hay cambios para guardar."); }
  upd.actualizado_en = new Date().toISOString();
  await actual.ref.update(upd);
  return { ok: true, resumen: "poza " + cod + " actualizada", detalle: "" };
}

/* Borra una poza vacía junto con sus movimientos. No se permite si tiene
   cuyes vivos: primero hay que venderlos, faenarlos o registrarlos como muerte. */
async function fsBorrarLote(codigo) {
  var cod = fsUp(codigo);
  var actual = await fsLoteActual(cod);
  if (!actual) { throw new Error("No existe la poza " + cod + " en la granja."); }
  var vivos = fsNum(actual.data.vivos);
  if (vivos > 0) {
    throw new Error("La poza " + cod + " todavía tiene " + vivos + " cuy(es) vivos. Véndelos, faénalos o regístralos como muerte antes de borrarla.");
  }
  var borrados = 0;
  var avisosBorrar = ["pesaje_" + cod];
  var cols = ["pesajes", "mortalidad", "consumo_alimento", "ventas", "faenas", "retiros"];
  for (var c = 0; c < cols.length; c++) {
    var filas = await fsTodos(cols[c]);
    for (var i = 0; i < filas.length; i++) {
      if (fsUp(filas[i].lote) !== cod) { continue; }
      if (cols[c] === "retiros") { avisosBorrar.push("retiro_" + filas[i].__id); }
      await fsdb().collection(cols[c]).doc(filas[i].__id).delete();
      borrados++;
    }
  }
  /* Los avisos ya atendidos de esta poza tampoco deben quedar colgando. */
  var marcasAviso = await fsTodos("avisos_atendidos");
  for (var m = 0; m < marcasAviso.length; m++) {
    if (avisosBorrar.indexOf(String(marcasAviso[m].aviso_id || "")) < 0) { continue; }
    await fsdb().collection("avisos_atendidos").doc(marcasAviso[m].__id).delete();
  }
  /* Si había crías destetadas a esta poza, se devuelven a su parto. */
  var destetes = await fsTodos("destetes");
  for (var j = 0; j < destetes.length; j++) {
    if (fsUp(destetes[j].poza_destino) !== cod) { continue; }
    var partos = await fsTodos("partos");
    for (var k = 0; k < partos.length; k++) {
      if (partos[k].__id !== String(destetes[j].parto_id || "")) { continue; }
      var crias = partos[k].crias_actuales == null ? fsNum(partos[k].nacidos_vivos) : fsNum(partos[k].crias_actuales);
      await fsdb().collection("partos").doc(partos[k].__id).update({
        crias_actuales: crias + fsNum(destetes[j].cantidad), destetado: false
      });
      break;
    }
    await fsdb().collection("destetes").doc(destetes[j].__id).delete();
    borrados++;
  }
  await actual.ref.delete();
  return {
    ok: true, resumen: "poza " + cod + " borrada",
    detalle: borrados ? borrados + " movimiento(s) eliminados con ella." : ""
  };
}

async function fsCrearPoza(datos) {
  var cod = fsUp(datos.codigo);
  if (!cod) { throw new Error("Dime el código de la ubicación (por ejemplo U-01)."); }
  if (!/^[A-Z0-9_-]{1,20}$/.test(cod)) {
    throw new Error("El código solo admite letras, números, guion y guion bajo (máximo 20).");
  }
  var existentes = await fsTodos("pozas");
  for (var i = 0; i < existentes.length; i++) {
    if (fsUp(existentes[i].codigo) === cod) { throw new Error("La ubicación " + cod + " ya existe en esta granja."); }
  }
  var tipo = String(datos.tipo || "").trim().slice(0, 30);
  var cap = null;
  if (datos.capacidad != null && datos.capacidad !== "") {
    cap = fsNum(datos.capacidad);
    if (cap < 0 || cap !== Math.round(cap)) { throw new Error("La capacidad debe ser un número entero."); }
  }
  await fsdb().collection("pozas").doc("g" + fsGranja() + "_" + cod).set({
    granja_id: fsGranja(), codigo: cod, tipo: tipo, capacidad: cap,
    creado_en: new Date().toISOString()
  });
  _fsPozasCache = null;
  return { ok: true, resumen: "ubicación " + cod + " agregada", detalle: "" };
}

async function fsBorrarPoza(id) {
  if (!id) { throw new Error("Ubicación no válida."); }
  var filas = await fsTodos("pozas");
  var doc = null;
  for (var i = 0; i < filas.length; i++) {
    if (filas[i].__id === id || fsUp(filas[i].codigo) === fsUp(id)) { doc = filas[i]; break; }
  }
  if (!doc) { throw new Error("La ubicación no existe en esta granja."); }
  var enUso = 0;
  var lotes = await fsTodos("lotes");
  for (var j = 0; j < lotes.length; j++) {
    if (fsUp(lotes[j].poza_codigo) !== fsUp(doc.codigo)) { continue; }
    await fsdb().collection("lotes").doc(lotes[j].__id).update({ poza_codigo: "" });
    enUso++;
  }
  await fsdb().collection("pozas").doc(doc.__id).delete();
  _fsPozasCache = null;
  return {
    ok: true, resumen: "ubicación " + (doc.codigo || id) + " borrada",
    detalle: enUso ? enUso + " poza(s) quedaron sin ubicación." : ""
  };
}

async function fsBorrarPartoProximo(id) {
  if (!id) { throw new Error("Parto programado no válido."); }
  var filas = await fsTodos("partos_proximos");
  for (var i = 0; i < filas.length; i++) {
    if (filas[i].__id !== id) { continue; }
    await fsdb().collection("partos_proximos").doc(id).delete();
    return { ok: true, resumen: "parto programado de " + (filas[i].hembra || "la hembra") + " eliminado", detalle: "" };
  }
  throw new Error("Ese parto programado no existe o ya fue eliminado.");
}

/* ---------- avisos: marcadores de atendido ---------- */

async function fsAvisosActuales() {
  /* Seis consultas en paralelo (antes ~3.4 s; ahora ~0.6 s). */
  var cols = await Promise.all([
    fsTodos("avisos_atendidos"), fsTodos("lotes"), fsTodos("partos_proximos"),
    fsTodos("pesajes"), fsTodos("partos"), fsTodos("retiros")
  ]);
  var atendidos = {};
  cols[0].forEach(function (x) { atendidos[String(x.aviso_id || "")] = true; });
  var lotesA = cols[1].map(fsLoteFila);
  var proxA = cols[2];
  var pesA = cols[3];
  var partosA = cols[4];
  var retirosA = cols[5];
  var ultimos = {};
  pesA.forEach(function (x) {
    var cod = fsUp(x.lote);
    var f = String(x.fecha || "").slice(0, 10);
    if (!ultimos[cod] || f > ultimos[cod]) { ultimos[cod] = f; }
  });
  return fsAvisosDe(lotesA, proxA, ultimos, partosA, retirosA, atendidos);
}

async function fsBorrarAvisoAtendido(id) {
  if (!id) { throw new Error("Aviso no válido."); }
  var filas = await fsTodos("avisos_atendidos");
  for (var i = 0; i < filas.length; i++) {
    if (String(filas[i].aviso_id || "") !== id) { continue; }
    await fsdb().collection("avisos_atendidos").doc(filas[i].__id).delete();
    return { ok: true, resumen: "aviso devuelto a pendientes", detalle: "" };
  }
  throw new Error("Ese aviso no estaba marcado como atendido.");
}

/* ---------- API real ---------- */

/* ---------- Asistente: intérprete de reglas (sin IA) ----------
   Funciona sin servidor y sin clave. La IA (Cloud Function `asistente`) añade
   lenguaje libre; cuando no está disponible, esto cubre los casos frecuentes. */

/* Códigos de poza escritos en el mensaje: P-001, P001, U-01, u1... */
function fsCodigosEn(texto) {
  var cods = [];
  var re = /\b([pu])\s*-?\s*(\d{1,4})\b/gi;
  var m;
  while ((m = re.exec(String(texto || ""))) !== null) {
    var cod = m[1].toUpperCase() + "-" + m[2];
    if (cods.indexOf(cod) < 0) { cods.push(cod); }
  }
  return cods;
}

function interpretarAsistente(texto) {
  var t = String(texto || "").trim();
  var low = t.toLowerCase();

  // Muertes: "se murieron 2 cuyes en P-001 por diarrea"
  var mMuerte = low.match(/se\s+murieron\s+(\d+)\s+cuyes?\s+en\s+([A-Za-z0-9-]+)(?:\s+por\s+(.+))?$/) ||
                low.match(/murieron\s+(\d+)\s+cuyes?\s+en\s+([A-Za-z0-9-]+)(?:\s+por\s+(.+))?$/) ||
                low.match(/\b(\d+)\s+muer(?:en|ieron)\s+en\s+([A-Za-z0-9-]+)(?:\s+por\s+(.+))?$/);
  if (mMuerte) {
    return {
      accion: "registrar_muerte",
      datos: {
        lote: mMuerte[2],
        cantidad: parseInt(mMuerte[1], 10),
        causa: (mMuerte[3] || "").trim() || null
      }
    };
  }

  // Alimento: "10 kg de balanceado para P-001"
  var mAlim = low.match(/(\d+(?:\.\d+)?)\s*kg\s+de\s+(forraje|balanceado)\s+(?:para\s+)?([A-Za-z0-9-]+)$/) ||
              low.match(/alimento\s+(\d+(?:\.\d+)?)\s*kg\s+(forraje|balanceado)\s+([A-Za-z0-9-]+)$/);
  if (mAlim) {
    return {
      accion: "registrar_alimento",
      datos: {
        lote: mAlim[3],
        kg: parseFloat(mAlim[1]),
        tipo: mAlim[2]
      }
    };
  }

  // Peso: "peso de P-001 es 720 g"
  var mPeso = low.match(/peso\s+(?:de\s+)?([A-Za-z0-9-]+)\s+(?:es\s+)?(\d+(?:\.\d+)?)\s*g?$/) ||
              low.match(/pesaje\s+([A-Za-z0-9-]+)\s+(\d+(?:\.\d+)?)$/);
  if (mPeso) {
    return {
      accion: "registrar_peso",
      datos: {
        lote: mPeso[1],
        peso_g: parseFloat(mPeso[2]),
        animales_pesados: 10
      }
    };
  }

  // Programar parto: "programar parto de H003 en P-001 para 2026-11-20"
  var mPartoProg = low.match(/programar\s+parto\s+de\s+([A-Za-z0-9-]+)(?:\s+en\s+([A-Za-z0-9-]+))?(?:\s+para\s+(\d{4}-\d{2}-\d{2}))?$/);
  if (mPartoProg) {
    return {
      accion: "registrar_parto_proximo",
      datos: {
        hembra: mPartoProg[1],
        poza: mPartoProg[2] || "",
        fecha_objetivo: mPartoProg[3] || ""
      }
    };
  }

  // Consultas generales (antes que las de poza: "¿cómo van las pozas?")
  if (/\bavisos?\b|\balertas?\b|\bpendientes?\b/.test(low)) {
    return { accion: "consultar_alertas", datos: {} };
  }
  if (/retiros?|sanitari|puedo vender|se puede vender|vender ya/.test(low)) {
    return { accion: "consultar_retiro", datos: {} };
  }
  if (/partos?/.test(low) &&
      /pr[oó]xim|vienen|cerca|gestaci|programad|cu[aá]ndo|fecha/.test(low)) {
    return { accion: "consultar_partos", datos: {} };
  }

  var cods = fsCodigosEn(low);

  // "¿cuántos vivos tiene P-001?" → respuesta corta
  if (/cu[aá]ntos\s+vivos|vivos\s+tiene|cu[aá]ntos\s+(?:cuyes|animales)\s+(?:tiene|hay)/.test(low)) {
    if (cods.length) { return { accion: "consultar_vivos", datos: { lote: cods[0] } }; }
  }

  // "¿cómo va la poza P-001?", "estado de P-002", "¿cómo están las pozas?"
  if (/c[oó]mo\s+(?:va|van|est[aá]n?)|estado\s+de|resumen\s+de/.test(low)) {
    if (cods.length > 1) { return { accion: "consultar_lotes", datos: { lotes: cods } }; }
    if (cods.length === 1) { return { accion: "consultar_lote", datos: { lote: cods[0] } }; }
    return { accion: "consultar_lotes", datos: { lotes: [] } };
  }

  return { accion: "sin_accion", motivo: "No entendí el mensaje. Intenta escribir algo como: «se murieron 2 cuyes en P-001 por diarrea», «10 kg de balanceado para P-001» o «¿cómo va la poza P-001?»." };
}

/* ---------- Asistente IA (Cloud Function con Groq) ----------
   La clave de Groq vive en el servidor (Secret Manager). Aquí solo se llama a
   la función `asistente`; si no responde, se usa el intérprete de reglas.

   OJO: la función necesita el plan Blaze de Firebase (Secret Manager). Mientras
   FS_IA_ACTIVA sea false, el chat usa solo las reglas: sin latencia y sin costo.
   Cuando la función esté desplegada, ponlo en true y vuelve a publicar. */
var FS_IA_ACTIVA = false;

var _fsfn = null;

function fsfn() {
  if (_fsfn) { return _fsfn; }
  if (typeof firebase === "undefined" || !firebase.functions) {
    throw new Error("Firebase Functions no terminó de cargar.");
  }
  if (!firebase.apps || !firebase.apps.length) { firebase.initializeApp(FIREBASE_CONFIG); }
  _fsfn = firebase.app().functions("us-central1");
  return _fsfn;
}

function fsConTiempo(promesa, ms) {
  return new Promise(function (resolver, rechazar) {
    var t = setTimeout(function () {
      rechazar(new Error("El asistente tardó demasiado en responder."));
    }, ms);
    promesa.then(function (v) { clearTimeout(t); resolver(v); },
                 function (e) { clearTimeout(t); rechazar(e); });
  });
}

async function fsInterpretarIA(texto) {
  if (!FS_IA_ACTIVA) { throw new Error("Asistente IA en la nube desactivado."); }
  var llamada = fsfn().httpsCallable("asistente");
  var r = await fsConTiempo(llamada({ texto: texto, granja_id: fsGranja() }), 25000);
  var d = r && r.data;
  if (!d || !d.accion) { throw new Error("El asistente no devolvió una acción."); }
  return { accion: d.accion, motivo: d.motivo, datos: d.datos || {} };
}

/* ---------- textos de las consultas del asistente ---------- */

function fsFraseDias(d, fecha) {
  if (d === null || d === undefined) { return fecha || ""; }
  var cola = fecha ? " (" + fecha + ")" : "";
  if (d === 0) { return "hoy" + cola; }
  if (d > 0) { return "en " + d + " día" + (d === 1 ? "" : "s") + cola; }
  return "atrasado " + (-d) + " día" + (-d === 1 ? "" : "s") + cola;
}

async function fsTextoConsultaLote(codigo) {
  var cod = fsUp(codigo);
  if (!cod) { return "Dime el código de la poza (por ejemplo P-001)."; }
  var actual = await fsLoteActual(cod);
  if (!actual) { return "No encuentro la poza **" + cod + "** en esta granja."; }
  var l = fsLoteFila(actual.data);
  var peso = l.ultimo_peso_g == null ? "sin pesajes" : l.ultimo_peso_g + " g";
  return "**Poza " + l.codigo + "** · " + l.etapa + " · " + l.estado + "\n" +
    "- Vivos: " + l.vivos + " de " + l.cantidad_inicial + "\n" +
    "- Muertos: " + l.muertos + " (" + l.mortalidad_pct + " %)\n" +
    "- Vendidos: " + l.vendidos + " · Faenados: " + l.faenados + "\n" +
    "- Alimento: " + l.alimento_kg + " kg\n" +
    "- Último peso: " + peso + "\n" +
    "- Edad: " + l.edad_dias + " días";
}

async function fsTextoConsultaLotes(codigos) {
  var pedidos = (codigos || []).map(fsUp).filter(function (c) { return !!c; });
  var filas = (await fsTodos("lotes")).map(fsLoteFila);
  var lineas = [];
  if (pedidos.length) {
    for (var i = 0; i < pedidos.length; i++) {
      var l = null;
      for (var j = 0; j < filas.length; j++) {
        if (filas[j].codigo === pedidos[i]) { l = filas[j]; break; }
      }
      lineas.push(l
        ? "- **" + l.codigo + "** · " + l.vivos + " vivos · " +
          (l.ultimo_peso_g == null ? "sin pesajes" : l.ultimo_peso_g + " g") +
          " · " + l.edad_dias + " días · " + l.estado
        : "- **" + pedidos[i] + "** · no existe en esta granja");
    }
    return "**Pozas consultadas**\n" + lineas.join("\n");
  }
  var abiertas = filas.filter(function (l) { return l.estado === "abierto"; });
  if (!abiertas.length) { return "No hay pozas abiertas en esta granja."; }
  abiertas.forEach(function (l) {
    lineas.push("- **" + l.codigo + "** · " + l.vivos + " de " + l.cantidad_inicial +
      " vivos · " + (l.ultimo_peso_g == null ? "sin pesajes" : l.ultimo_peso_g + " g") +
      " · " + l.edad_dias + " días · " + l.etapa);
  });
  return "**Pozas abiertas (" + abiertas.length + ")**\n" + lineas.join("\n");
}

async function fsTextoPartosProximos() {
  var lista = await apiReal("GET", "partos-proximos", null);
  if (!lista.length) { return "No hay partos previstos en los próximos 10 días."; }
  return "**Partos próximos**\n" + lista.map(function (p) {
    return "- **" + (p.hembra || "sin arete") + "** · ubicación " + (p.poza || "s/u") +
      " · " + fsFraseDias(p.dias_restantes, p.fecha);
  }).join("\n");
}

async function fsTextoAlertas() {
  var lista = await apiReal("GET", "alertas", null);
  if (!lista.length) { return "No tienes avisos pendientes."; }
  return "**Avisos pendientes (" + lista.length + ")**\n" + lista.map(function (a) {
    return "- " + a.mensaje;
  }).join("\n");
}

async function fsTextoRetiros() {
  var lista = await apiReal("GET", "retiros", null);
  var hoy = lista.filter(function (r) {
    return r.dias_restantes !== null && r.dias_restantes >= 0;
  });
  if (!hoy.length) { return "Nada en retiro sanitario: se puede vender con normalidad."; }
  return "**En retiro sanitario (no vender todavía)**\n" + hoy.map(function (r) {
    var que = r.lote || r.poza || "la granja";
    var queda = r.dias_restantes === 1 ? "queda 1 día" : "quedan " + r.dias_restantes + " días";
    return "- **" + que + "** · " + (r.producto || r.tipo) + " · " + queda +
      " (hasta el " + r.fecha_fin_retiro + ")";
  }).join("\n");
}

/* ---------- responder según la acción ---------- */

var FS_ACCIONES_REGISTRO = {
  registrar_peso: true,
  registrar_muerte: true,
  registrar_alimento: true,
  registrar_parto: true,
  registrar_parto_proximo: true
};

function fsResumenRegistro(accion, d) {
  if (accion === "registrar_peso") {
    return "peso de la poza " + fsUp(d.lote) + ": " + fsNum(d.peso_g) + " g";
  }
  if (accion === "registrar_muerte") {
    var t = fsNum(d.cantidad) + " muerte(s) en la poza " + fsUp(d.lote);
    if (d.causa) { t += " (causa: " + String(d.causa).slice(0, 100) + ")"; }
    return t;
  }
  if (accion === "registrar_alimento") {
    return fsNum(d.kg) + " kg de " + String(d.tipo || "").toLowerCase() + " para la poza " + fsUp(d.lote);
  }
  if (accion === "registrar_parto") {
    var quien = fsUp(d.hembra) || ("la poza " + fsUp(d.poza));
    return "parto de " + quien + ": " + fsNum(d.nacidos_vivos) + " vivos y " +
      fsNum(d.nacidos_muertos) + " muertos";
  }
  if (accion === "registrar_parto_proximo") {
    return "programar el parto de " + fsUp(d.hembra) +
      (d.fecha_objetivo ? " para el " + d.fecha_objetivo : "");
  }
  return "registro pendiente";
}

async function fsResponderAsistente(interp) {
  var accion = interp.accion;
  var d = interp.datos || {};

  if (accion === "sin_accion") {
    return { tipo: "respuesta", texto: interp.motivo || d.motivo || "No entendí el mensaje." };
  }

  if (accion === "consultar_vivos") {
    var cod = fsUp(d.lote);
    var act = cod ? await fsLoteActual(cod) : null;
    if (!act) { return { tipo: "respuesta", texto: "No encuentro la poza **" + (cod || "") + "** en esta granja." }; }
    var fila = fsLoteFila(act.data);
    return {
      tipo: "respuesta",
      texto: "La poza **" + fila.codigo + "** tiene **" + fila.vivos + " vivos** de " +
        fila.cantidad_inicial + " iniciales."
    };
  }

  if (accion === "consultar_lote") {
    return { tipo: "respuesta", texto: await fsTextoConsultaLote(d.lote) };
  }
  if (accion === "consultar_lotes") {
    return { tipo: "respuesta", texto: await fsTextoConsultaLotes(d.lotes) };
  }
  if (accion === "consultar_partos") {
    return { tipo: "respuesta", texto: await fsTextoPartosProximos() };
  }
  if (accion === "consultar_alertas") {
    return { tipo: "respuesta", texto: await fsTextoAlertas() };
  }
  if (accion === "consultar_retiro") {
    return { tipo: "respuesta", texto: await fsTextoRetiros() };
  }

  if (FS_ACCIONES_REGISTRO[accion]) {
    return {
      tipo: "propuesta",
      accion: accion,
      resumen: fsResumenRegistro(accion, d),
      datos: d
    };
  }

  return { tipo: "respuesta", texto: "Eso todavía no lo sé hacer." };
}

async function apiReal(metodo, ruta, datos) {
  var base = String(ruta || "").split("?")[0];
  var partes = base.split("/");

  /* granja y precios */
  if (metodo === "GET" && base === "granja") {
    var gj = await fsGranjaDoc();
    return { id: fsGranja(), nombre: gj.nombre || "Mi granja", precios: fsPreciosDe(gj) || {} };
  }
  if (metodo === "POST" && base === "granja") { return fsGuardarGranja(datos || {}); }

  if (metodo === "GET" && base === "partos-proximos") {
    var prox = await fsTodos("partos_proximos");
    return prox.map(function (p) {
      return {
        id: p.__id, hembra: p.hembra || "", poza: p.poza || "",
        dias_restantes: fsDias(p.fecha_objetivo),
        fecha: String(p.fecha_objetivo || "").slice(0, 10)
      };
    }).filter(function (p) {
      return p.dias_restantes === null ? false : (p.dias_restantes <= 10 && p.dias_restantes >= -5);
    }).sort(function (a, b) { return a.dias_restantes - b.dias_restantes; });
  }

  if (metodo === "GET" && base === "lotes") {
    var filas = await fsTodos("lotes");
    return filas.map(fsLoteFila).sort(function (a, b) { return a.codigo < b.codigo ? -1 : 1; });
  }

  if (metodo === "GET" && partes[0] === "lotes" && partes[2] === "pesajes") {
    var codP = fsUp(partes[1]);
    var pes = await fsTodos("pesajes");
    return pes.filter(function (x) { return fsUp(x.lote) === codP; })
      .map(function (x) {
        return { id: x.__id, fecha: String(x.fecha || "").slice(0, 10), peso_promedio_g: fsNum(x.peso_promedio_g), animales_pesados: fsNum(x.animales_pesados) };
      })
      .sort(function (a, b) { return a.fecha < b.fecha ? -1 : 1; });
  }

  if (metodo === "GET" && partes[0] === "lotes" && partes.length === 2) {
    var codU = fsUp(partes[1]);
    var actualLote = await fsLoteActual(codU);
    if (!actualLote) { throw new Error("No existe la poza " + codU + " en la granja."); }
    var d1 = actualLote.data;
    d1.codigo = d1.codigo || codU;
    return fsLoteFila(d1);
  }

  if (metodo === "PUT" && partes[0] === "lotes" && partes.length === 2) {
    return fsActualizarLote(decodeURIComponent(partes[1]), datos || {});
  }

  if (metodo === "DELETE" && partes[0] === "lotes" && partes.length === 2) {
    return fsBorrarLote(decodeURIComponent(partes[1]));
  }

  if (metodo === "GET" && base === "pozas") {
    if (_fsPozasCache && (Date.now() - _fsPozasCache.t) < 60000) { return _fsPozasCache.d; }
    var pz = await fsTodos("pozas");
    var listaPozas = pz.map(function (p) {
      return { id: p.codigo || p.__id, codigo: p.codigo || p.__id, tipo: p.tipo || "", capacidad: p.capacidad == null ? null : fsNum(p.capacidad) };
    }).sort(function (a, b) { return a.codigo < b.codigo ? -1 : 1; });
    _fsPozasCache = { t: Date.now(), d: listaPozas };
    return listaPozas;
  }

  if (metodo === "POST" && base === "pozas") { return fsCrearPoza(datos || {}); }

  if (metodo === "DELETE" && partes[0] === "pozas" && partes[1]) {
    return fsBorrarPoza(decodeURIComponent(partes[1]));
  }

  if (metodo === "GET" && base === "retiros") {
    var ret = await fsTodos("retiros");
    return ret.map(function (r) {
      return {
        lote: r.lote || null, poza: r.poza || null, producto: r.producto || "",
        tipo: r.tipo || "tratamiento", dias_restantes: fsDias(r.fecha_fin_retiro),
        fecha_fin_retiro: String(r.fecha_fin_retiro || "").slice(0, 10)
      };
    }).sort(function (a, b) { return (a.fecha_fin_retiro || "") < (b.fecha_fin_retiro || "") ? -1 : 1; });
  }

  if (metodo === "GET" && base === "resumen-economico") {
    var pr = fsPreciosDe(await fsGranjaDoc());
    if (!pr) { return []; }
    /* Las tres consultas van en paralelo: antes se sumaban ~3 idas y vueltas. */
    var tres = await Promise.all([fsTodos("lotes"), fsTodos("consumo_alimento"), fsTodos("ventas")]);
    var lotesEco = tres[0].map(fsLoteFila);
    var consumos = tres[1];
    var ventas = tres[2];
    return lotesEco.map(function (l) {
      var kgBal = 0, kgForr = 0, kgSin = 0;
      consumos.forEach(function (c) {
        if (fsUp(c.lote) !== l.codigo) { return; }
        var kg = fsNum(c.kg);
        if (String(c.tipo || "").toLowerCase() === "balanceado" && pr.balanceado_kg != null) { kgBal += kg; }
        else if (String(c.tipo || "").toLowerCase() === "forraje" && pr.forraje_kg != null) { kgForr += kg; }
        else { kgSin += kg; }
      });
      var costo = Math.round((kgBal * (pr.balanceado_kg || 0) + kgForr * (pr.forraje_kg || 0)) * 100) / 100;
      var ingresos = 0;
      var cantidadVendida = 0;
      ventas.forEach(function (v) {
        if (fsUp(v.lote) !== l.codigo) { return; }
        ingresos += fsNum(v.cantidad) * fsNum(v.precio_unitario);
        cantidadVendida += fsNum(v.cantidad);
      });
      ingresos = Math.round(ingresos * 100) / 100;
      var logrados = l.vendidos + l.faenados;
      return {
        codigo: l.codigo, estado: l.estado, cantidad_vendida: cantidadVendida,
        ingresos: ingresos, costo_alimento: costo, kg_sin_precio: Math.round(kgSin * 100) / 100,
        otros_gastos: 0, costo_total: costo,
        costo_por_cuy_logrado: logrados > 0 ? Math.round((costo / logrados) * 100) / 100 : null,
        margen: Math.round((ingresos - costo) * 100) / 100
      };
    });
  }

  if (metodo === "GET" && base === "evolucion") {
    var semanas = 5;
    var m = String(ruta || "").match(/semanas=(\d+)/);
    if (m) { semanas = Math.max(1, Math.min(parseInt(m[1], 10) || 5, 26)); }
    var cuatro = await Promise.all([fsTodos("lotes"), fsTodos("mortalidad"), fsTodos("ventas"), fsTodos("faenas")]);
    var lotesE = cuatro[0].map(fsLoteFila);
    var morts = cuatro[1];
    var ventasE = cuatro[2];
    var faenasE = cuatro[3];
    var salida = [];
    for (var i = semanas - 1; i >= 0; i--) {
      var corte = new Date();
      corte.setDate(corte.getDate() - i * 7);
      var corteISO = fsFechaLocal(corte);
      var inicioSemana = new Date(corte);
      inicioSemana.setDate(inicioSemana.getDate() - 7);
      var inicioISO = fsFechaLocal(inicioSemana);
      var poblacion = 0;
      lotesE.forEach(function (l) {
        if (l.fecha_inicio && l.fecha_inicio > corteISO) { return; }
        function bajasDe(filas) {
          return filas.filter(function (x) {
            return fsUp(x.lote) === l.codigo &&
              String(x.fecha || "").slice(0, 10) <= corteISO;
          }).reduce(function (s, x) { return s + fsNum(x.cantidad); }, 0);
        }
        var bajas = bajasDe(morts) + bajasDe(ventasE) + bajasDe(faenasE);
        poblacion += Math.max(0, l.cantidad_inicial - bajas);
      });
      var ingresos = ventasE.filter(function (x) {
        var f = String(x.fecha || "").slice(0, 10);
        return f > inicioISO && f <= corteISO;
      }).reduce(function (s, x) { return s + fsNum(x.cantidad) * fsNum(x.precio_unitario); }, 0);
      var dia = ("0" + corte.getDate()).slice(-2);
      var mes = ("0" + (corte.getMonth() + 1)).slice(-2);
      salida.push({
        etiqueta: dia + "/" + mes,
        poblacion: poblacion,
        ingresos: Math.round(ingresos * 100) / 100
      });
    }
    return salida;
  }

  if (metodo === "GET" && base === "nacimientos-salidas") {
    var dos = await Promise.all([fsTodos("partos"), fsTodos("ventas")]);
    var nac = dos[0];
    var ventasMes = dos[1];
    var meses = [];
    var ahora = new Date();
    for (var k = 7; k >= 0; k--) {
      var f = new Date(ahora.getFullYear(), ahora.getMonth() - k, 1);
      meses.push({ clave: f.toISOString().slice(0, 7), mes: f.toISOString().slice(0, 7) + "-01", nacidas: 0, ventas: 0 });
    }
    nac.forEach(function (x) {
      var clave = String(x.fecha || "").slice(0, 7);
      meses.forEach(function (mm) { if (mm.clave === clave) { mm.nacidas += fsNum(x.nacidos_vivos); } });
    });
    ventasMes.forEach(function (x) {
      var clave = String(x.fecha || "").slice(0, 7);
      meses.forEach(function (mm) { if (mm.clave === clave) { mm.ventas += fsNum(x.cantidad); } });
    });
    return meses.map(function (mm) { return { mes: mm.mes, nacidas: mm.nacidas, ventas: mm.ventas }; });
  }

  if (metodo === "GET" && base === "registros") {
    var limite = 15;
    var lm = String(ruta || "").match(/limite=(\d+)/);
    if (lm) { limite = Math.max(1, Math.min(parseInt(lm[1], 10) || 15, 100)); }
    var todo = [];
    /* Ocho colecciones en paralelo: antes eran ~8 idas y vueltas seguidas. */
    var cols = await Promise.all([
      fsTodos("pesajes"), fsTodos("mortalidad"), fsTodos("consumo_alimento"), fsTodos("partos"),
      fsTodos("destetes"), fsTodos("ventas"), fsTodos("faenas"), fsTodos("retiros")
    ]);
    cols[0].forEach(function (x) {
      todo.push({ tipo: "peso", id: x.__id, fecha: String(x.fecha || "").slice(0, 10), lote: x.lote || "", hembra: null,
        detalle: "Peso " + fsNum(x.peso_promedio_g) + " g (muestra " + fsNum(x.animales_pesados) + ")" });
    });
    cols[1].forEach(function (x) {
      todo.push({ tipo: "muerte", id: x.__id, fecha: String(x.fecha || "").slice(0, 10), lote: x.lote || "", hembra: null,
        detalle: fsNum(x.cantidad) + " muerte(s)" + (x.causa ? " · " + x.causa : "") });
    });
    cols[2].forEach(function (x) {
      todo.push({ tipo: "alimento", id: x.__id, fecha: String(x.fecha || "").slice(0, 10), lote: x.lote || "", hembra: null,
        detalle: fsNum(x.kg) + " kg de " + (x.tipo || "") });
    });
    cols[3].forEach(function (x) {
      todo.push({ tipo: "parto", id: x.__id, fecha: String(x.fecha || "").slice(0, 10), lote: null, hembra: x.hembra || "",
        detalle: fsNum(x.nacidos_vivos) + " vivos, " + fsNum(x.nacidos_muertos) + " muertos" });
    });
    cols[4].forEach(function (x) {
      todo.push({ tipo: "destete", id: x.__id, fecha: String(x.fecha || "").slice(0, 10), lote: x.poza_destino || null, hembra: x.hembra || "",
        detalle: fsNum(x.cantidad) + " crías destetadas a " + (x.poza_destino || "") });
    });
    cols[5].forEach(function (x) {
      var total = fsNum(x.cantidad) * fsNum(x.precio_unitario);
      todo.push({ tipo: "venta", id: x.__id, fecha: String(x.fecha || "").slice(0, 10), lote: x.lote || "", hembra: null,
        detalle: fsNum(x.cantidad) + " vendidos · S/ " + total.toFixed(2) });
    });
    cols[6].forEach(function (x) {
      todo.push({ tipo: "faena", id: x.__id, fecha: String(x.fecha || "").slice(0, 10), lote: x.lote || "", hembra: null,
        detalle: fsNum(x.cantidad) + " faenados" });
    });
    cols[7].forEach(function (x) {
      todo.push({ tipo: "retiro", id: x.__id, fecha: String(x.fecha_inicio || "").slice(0, 10), lote: x.lote || "", hembra: null,
        detalle: (x.producto || "") + " · " + fsNum(x.dias) + " días de retiro" });
    });
    todo.sort(function (a, b) {
      if (a.fecha === b.fecha) { return 0; }
      return a.fecha < b.fecha ? 1 : -1;
    });
    return todo.slice(0, limite);
  }

  if (metodo === "GET" && base === "alertas") {
    return fsAvisosActuales();
  }

  if (metodo === "GET" && base === "alertas/atendidos") {
    var atendidosLista = await fsTodos("avisos_atendidos");
    return atendidosLista.map(function (x) {
      var idAv = String(x.aviso_id || "");
      return {
        id: idAv, tipo: x.tipo || "", mensaje: x.mensaje || "",
        fecha: String(x.atendido_en || "").slice(0, 10), atendido_en: x.atendido_en || ""
      };
    }).filter(function (x) { return !!x.id; })
      .sort(function (a, b) { return a.atendido_en < b.atendido_en ? 1 : -1; });
  }

  /* ---------- escrituras ---------- */

  if (metodo === "POST" && base === "alertas/generar") {
    var avisosGen = await fsAvisosActuales();
    return { creadas: 0, total: avisosGen.length };
  }

  if (metodo === "POST" && partes[0] === "alertas" && partes[2] === "atender") {
    var idAviso = decodeURIComponent(partes[1] || "");
    if (!idAviso) { throw new Error("Aviso no válido."); }
    var marca = {
      granja_id: fsGranja(), aviso_id: idAviso, atendido_en: new Date().toISOString()
    };
    if (datos && datos.tipo) { marca.tipo = String(datos.tipo); }
    if (datos && datos.mensaje) { marca.mensaje = String(datos.mensaje).slice(0, 300); }
    await fsdb().collection("avisos_atendidos").doc("g" + fsGranja() + "_" + idAviso).set(marca);
    return { ok: true };
  }

  if (metodo === "DELETE" && partes[0] === "alertas" && partes[2] === "atendido") {
    return fsBorrarAvisoAtendido(decodeURIComponent(partes[1] || ""));
  }

  if (metodo === "POST" && base === "pesajes") { return fsRegistrarPeso(datos || {}); }
  if (metodo === "POST" && base === "muertes") { return fsRegistrarMuerte(datos || {}); }
  if (metodo === "POST" && base === "alimento") { return fsRegistrarAlimento(datos || {}); }
  if (metodo === "POST" && base === "partos-proximos") { return fsProgramarParto(datos || {}); }
  if (metodo === "DELETE" && partes[0] === "partos-proximos" && partes[1]) {
    return fsBorrarPartoProximo(decodeURIComponent(partes[1]));
  }
  if (metodo === "POST" && base === "partos") { return fsRegistrarParto(datos || {}); }
  if (metodo === "POST" && base === "destetes") { return fsRegistrarDestete(datos || {}); }
  if (metodo === "POST" && base === "ingresos") { return fsRegistrarIngreso(datos || {}); }
  if (metodo === "POST" && base === "lotes") { return fsCrearLote(datos || {}); }
  if (metodo === "POST" && base === "ventas") { return fsRegistrarVenta(datos || {}); }
  if (metodo === "POST" && base === "faenas") { return fsRegistrarFaena(datos || {}); }
  if (metodo === "POST" && base === "retiros") { return fsRegistrarRetiro(datos || {}); }

  if (metodo === "DELETE" && partes[0] === "registros") {
    var mapa = {
      peso: "pesajes", muerte: "mortalidad", alimento: "consumo_alimento", parto: "partos",
      destete: "destetes", venta: "ventas", faena: "faenas", retiro: "retiros"
    };
    var tipoReg = partes[1];
    var col = mapa[tipoReg];
    if (!col) { throw new Error("Tipo de registro no válido."); }
    var idReg = decodeURIComponent(partes[2] || "");
    if (!idReg) { throw new Error("Registro no válido."); }
    var dreg = null;
    var filasCol = await fsTodos(col);
    for (var i = 0; i < filasCol.length; i++) {
      if (filasCol[i].__id === idReg) { dreg = filasCol[i]; break; }
    }
    if (!dreg) {
      throw new Error("El registro no existe o no es de esta granja.");
    }
    var ref = fsdb().collection(col).doc(idReg);

    if (tipoReg === "parto") {
      var hayDestete = (await fsTodos("destetes")).some(function (d) {
        return String(d.parto_id || "") === idReg;
      });
      if (hayDestete) {
        throw new Error("Ese parto ya tiene un destete registrado. Borra primero el destete.");
      }
    }

    /* Al borrar una venta, faena o muerte se devuelven/ajustan los animales. */
    if (tipoReg === "venta" || tipoReg === "faena" || tipoReg === "muerte") {
      var actualLote = await fsLoteActual(dreg.lote);
      if (actualLote) {
        var lx = actualLote.data;
        var cant = fsNum(dreg.cantidad);
        var upd = {};
        if (tipoReg === "muerte") {
          upd = {
            vivos: fsNum(lx.vivos) + cant,
            muertos: Math.max(0, fsNum(lx.muertos) - cant)
          };
        } else {
          upd.vivos = fsNum(lx.vivos) + cant;
          if (tipoReg === "venta") { upd.vendidos = Math.max(0, fsNum(lx.vendidos) - cant); }
          else { upd.faenados = Math.max(0, fsNum(lx.faenados) - cant); }
        }
        await actualLote.ref.update(upd);
      }
    }

    if (tipoReg === "alimento") {
      var loteAlim = await fsLoteActual(dreg.lote);
      if (loteAlim) {
        await loteAlim.ref.update({
          alimento_kg: Math.max(0, Math.round((fsNum(loteAlim.data.alimento_kg) - fsNum(dreg.kg)) * 100) / 100)
        });
      }
    }

    if (tipoReg === "destete") {
      var partoRef = fsdb().collection("partos").doc(String(dreg.parto_id || ""));
      var pdata = null;
      var partosCol = await fsTodos("partos");
      for (var k = 0; k < partosCol.length; k++) {
        if (partosCol[k].__id === String(dreg.parto_id || "")) { pdata = partosCol[k]; break; }
      }
      if (pdata) {
        var cantDest = fsNum(dreg.cantidad);
        var crias = pdata.crias_actuales == null ? fsNum(pdata.nacidos_vivos) : fsNum(pdata.crias_actuales);
        await partoRef.update({
          crias_actuales: crias + cantDest,
          destetado: false
        });
      }
      var loteDestino = await fsLoteActual(dreg.poza_destino);
      if (loteDestino) {
        var cantD = fsNum(dreg.cantidad);
        await loteDestino.ref.update({
          vivos: Math.max(0, fsNum(loteDestino.data.vivos) - cantD),
          cantidad_inicial: Math.max(0, fsNum(loteDestino.data.cantidad_inicial) - cantD)
        });
      }
    }

    /* El último peso se recalcula con los pesajes que quedan. */
    if (tipoReg === "peso") {
      var restantes = (await fsTodos("pesajes")).filter(function (x) {
        return fsUp(x.lote) === fsUp(dreg.lote) && x.__id !== idReg;
      });
      restantes.sort(function (a, b) {
        var fa = String(a.fecha || ""), fb = String(b.fecha || "");
        return fa < fb ? -1 : (fa > fb ? 1 : 0);
      });
      var lotePeso = await fsLoteActual(dreg.lote);
      if (lotePeso) {
        await lotePeso.ref.update({
          ultimo_peso_g: restantes.length ? fsNum(restantes[restantes.length - 1].peso_promedio_g) : null
        });
      }
    }

    await ref.delete();
    return { ok: true };
  }

  /* ---------- Asistente (chat) ---------- */
  if (metodo === "POST" && base === "asistente") {
    var texto = String(datos && datos.texto || "");
    var interp = null;
    try {
      interp = await fsInterpretarIA(texto);
    } catch (e) {
      /* Sin función desplegada, sin sesión o sin cupo en Groq: reglas locales. */
      if (FS_IA_ACTIVA && typeof console !== "undefined" && console.warn) {
        console.warn("Asistente IA no disponible, uso el intérprete de reglas:", e && e.message);
      }
    }
    if (!interp) { interp = interpretarAsistente(texto); }
    return fsResponderAsistente(interp);
  }

  if (metodo === "POST" && partes[0] === "asistente" && partes[1] === "confirmar") {
    var accion = datos && datos.accion;
    var regDatos = datos && datos.datos || {};
    if (!accion) { throw new Error("Acción no válida."); }
    try {
      if (accion === "registrar_muerte") {
        var r = await fsRegistrarMuerte(regDatos);
        return { ok: true, texto: "Listo: " + r.resumen + (r.detalle ? ". " + r.detalle : "") };
      }
      if (accion === "registrar_alimento") {
        var r = await fsRegistrarAlimento(regDatos);
        return { ok: true, texto: "Listo: " + r.resumen + (r.detalle ? ". " + r.detalle : "") };
      }
      if (accion === "registrar_peso") {
        var r = await fsRegistrarPeso(regDatos);
        return { ok: true, texto: "Listo: " + r.resumen + (r.detalle ? ". " + r.detalle : "") };
      }
      if (accion === "registrar_parto_proximo") {
        var rp = await fsProgramarParto(regDatos);
        return { ok: true, texto: "Listo: " + rp.resumen + (rp.detalle ? ". " + rp.detalle : "") };
      }
      if (accion === "registrar_parto") {
        var rn = await fsRegistrarParto(regDatos);
        return { ok: true, texto: "Listo: " + rn.resumen + (rn.detalle ? ". " + rn.detalle : "") };
      }
      throw new Error("Acción no reconocida: " + accion);
    } catch (e) {
      throw e;
    }
  }

  throw new Error("Esa acción todavía no está disponible en el modo monitoreo.");
}
