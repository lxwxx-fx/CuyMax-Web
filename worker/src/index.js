/* CuyMax — Worker de IA (Cloudflare Workers + Groq).
 *
 * Qué hace: recibe el mensaje de un operario y el contexto de su granja, y
 * devuelve UNA acción estructurada en JSON. NO lee ni escribe la base de datos:
 * el panel valida la acción y solo la guarda cuando la persona la confirma.
 *
 * Por eso el Worker sirve igual si los datos están en Firestore (hoy) o en
 * Supabase (mañana): no conoce ninguna de las dos.
 *
 * Rutas:
 *   GET  /            → información del servicio
 *   GET  /salud       → { ok: true }
 *   POST /asistente   → { texto, contexto } → { accion, datos, motivo }
 *
 * Seguridad:
 *   - GROQ_API_KEY vive como secreto del Worker (nunca en el navegador).
 *   - Exige un ID token de Firebase Auth válido (Authorization: Bearer …).
 *   - CORS limitado a los orígenes de ALLOWED_ORIGINS.
 *   - Límite básico de peticiones por usuario.
 */
"use strict";

const URL_GROQ = "https://api.groq.com/openai/v1/chat/completions";
const URL_FIREBASE_LOOKUP = "https://identitytoolkit.googleapis.com/v1/accounts:lookup";
const MAX_TEXTO = 500;
const MAX_POZAS = 60;
const MAX_HEMBRAS = 60;

/* Límite básico por isolate (mejor esfuerzo; Cloudflare puede reciclar el
   isolate en cualquier momento). Para un límite estricto usar KV o Durable
   Objects. */
const LIMITE = { peticiones: 30, ventana_ms: 5 * 60 * 1000 };
const _contador = new Map();

const ACCIONES = new Set([
  "registrar_peso",
  "registrar_muerte",
  "registrar_alimento",
  "registrar_parto",
  "registrar_parto_proximo",
  "consultar_partos",
  "consultar_lote",
  "consultar_lotes",
  "consultar_alertas",
  "consultar_retiro",
  "consultar_vivos",
  "sin_accion"
]);

const SISTEMA =
  "Eres el intérprete de mensajes de un sistema de gestión de cuyes (cobayos de crianza). " +
  "Un operario de granja escribe en lenguaje natural, a veces con errores o abreviaturas. " +
  "Convierte el mensaje en UNA acción. Responde SOLO con JSON, sin explicaciones.\n" +
  "Formato: {\"accion\": \"<nombre>\", \"datos\": {…}}\n" +
  "Acciones posibles:\n" +
  "- registrar_peso: datos {\"lote\": \"P-001\", \"peso_g\": 720, \"animales_pesados\": 8}. " +
  "peso_g en gramos (si dice kilos, convierte). animales_pesados solo si lo dice.\n" +
  "- registrar_muerte: datos {\"lote\": \"P-001\", \"cantidad\": 2, \"causa\": \"diarrea\"}. " +
  "causa solo si la menciona.\n" +
  "- registrar_alimento: datos {\"lote\": \"P-001\", \"tipo\": \"forraje|balanceado\", \"kg\": 12.5}.\n" +
  "- registrar_parto: datos {\"hembra\": \"H-003\", \"poza\": \"U-01\", " +
  "\"nacidos_vivos\": 5, \"nacidos_muertos\": 0}. " +
  "Basta con la hembra O la poza: si el mensaje solo nombra la hembra, devuelve " +
  "solo \"hembra\" y NO pidas la poza (el panel resuelve su ubicación). " +
  "Si no dice cuántos nacieron vivos, no inventes la cifra: usa sin_accion con un " +
  "motivo breve que pregunte cuántos nacieron. Si no dice muertos, usa 0.\n" +
  "- registrar_parto_proximo: datos {\"hembra\": \"H-003\", \"poza\": \"U-01\", " +
  "\"fecha_objetivo\": \"2026-11-20\"}. Programar un parto futuro.\n" +
  "- consultar_partos: datos {}. Preguntas sobre partos próximos.\n" +
  "- consultar_lote: datos {\"lote\": \"P-001\"}. Preguntas sobre cómo va UNA poza.\n" +
  "- consultar_lotes: datos {\"lotes\": [\"P-001\", \"P-002\"]}. Varias pozas a la vez, " +
  "o todas las abiertas si preguntan en general (\"todas las pozas\", \"cómo van las pozas\"). " +
  "Si no nombra ninguno, deja la lista vacía.\n" +
  "- consultar_alertas: datos {}. Pide avisos, alertas o pendientes.\n" +
  "- consultar_retiro: datos {}. Pregunta por retiro sanitario o si se puede vender.\n" +
  "- consultar_vivos: datos {\"lote\": \"P-001\"}. Pregunta cuántos cuyes vivos hay.\n" +
  "- sin_accion: datos {\"motivo\": \"frase corta en español\"}. " +
  "Úsala si falta un dato obligatorio, el mensaje es ambiguo o no es de la granja. " +
  "Si es una palabra suelta o no se entiende, el motivo debe sugerir un ejemplo " +
  "concreto de lo que sí puedes hacer (\"No entendí. Prueba con «se murieron 2 cuyes " +
  "en P-001» o «¿cómo va la poza P-001?»\"). " +
  "Si es saludo, despedida o agradecimiento, el motivo debe ser una respuesta humana " +
  "y breve acorde (\"¡Hola! ¿En qué te ayudo?\", \"¡De nada! Aquí estoy para lo que necesites.\").\n" +
  "Reglas:\n" +
  "- No inventes datos.\n" +
  "- Cada mensaje llega SOLO: no recuerdas lo que se habló antes ni lo que respondiste. " +
  "No escribas respuestas que supongan una conversación en curso (nada de \"¿a qué poza " +
  "te refieres?\" si nadie habló antes). Si de verdad falta un dato, pide ese dato " +
  "concreto en UNA frase breve.\n" +
  "- Si el mensaje es una sola palabra o dos sin verbo (\"poza\", \"poza nueva\", \"peso\", " +
  "\"parto\"), no preguntes nada: si menciona crear/agregar/nueva, responde que eso se hace " +
  "en la pestaña Registrar; si no, usa sin_accion con un ejemplo de frase completa que " +
  "corresponda a una acción de la lista (nunca un ejemplo de crear pozas o lotes).\n" +
  "- No puedes crear ni borrar pozas, lotes, usuarios ni animales, ni editar registros. " +
  "Si lo piden, usa sin_accion con una frase breve que diga que eso se hace en la " +
  "pestaña Registrar del panel. No pidas datos para una acción que no puedes hacer.\n" +
  "- Usa los códigos de poza y hembra del contexto aunque el mensaje los nombre " +
  "aproximados ('poza 1' puede ser P-001). Si hay duda, usa sin_accion.\n" +
  "- El contexto es una ayuda, no un requisito: si el mensaje trae un código claro " +
  "que no aparece en el contexto (por ejemplo una hembra que no está gestando), " +
  "úsalo tal cual en vez de pedir más datos.\n" +
  "- Los aretes pueden venir con o sin guion: H003 y H-003 son la misma hembra.";

/* ---------- utilidades HTTP ---------- */

function origenesPermitidos(env) {
  return String(env.ALLOWED_ORIGINS || "")
    .split(",")
    .map(function (s) { return s.trim(); })
    .filter(Boolean);
}

function cabecerasCors(env, origen) {
  const permitidos = origenesPermitidos(env);
  const permitido = origen && permitidos.indexOf(origen) >= 0;
  const h = {
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
  if (permitido) { h["Access-Control-Allow-Origin"] = origen; }
  return h;
}

function json(cuerpo, estado, env, origen) {
  return new Response(JSON.stringify(cuerpo), {
    status: estado || 200,
    headers: Object.assign(
      { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
      cabecerasCors(env, origen)
    )
  });
}

function texto(valor, max) {
  return String(valor == null ? "" : valor).trim().slice(0, max);
}

/* ---------- autenticacion ---------- */

/* Valida el ID token contra Firebase y devuelve el uid. Sin clave de servicio:
   usa la API key publica del proyecto (la misma que ya viaja en el navegador). */
async function uidDeToken(idToken, env) {
  if (!idToken || !env.FIREBASE_API_KEY) { return null; }
  const r = await fetch(URL_FIREBASE_LOOKUP + "?key=" + encodeURIComponent(env.FIREBASE_API_KEY), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idToken: idToken })
  });
  if (!r.ok) { return null; }
  const j = await r.json().catch(function () { return null; });
  const u = j && j.users && j.users[0];
  return u && u.localId ? String(u.localId) : null;
}

function tokenDeCabecera(peticion) {
  const h = peticion.headers.get("Authorization") || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : "";
}

/* ---------- limite de peticiones ---------- */

function dentroDelLimite(uid) {
  const ahora = Date.now();
  const estado = _contador.get(uid);
  if (!estado || ahora - estado.inicio > LIMITE.ventana_ms) {
    _contador.set(uid, { inicio: ahora, cuenta: 1 });
    if (_contador.size > 5000) { _contador.clear(); }
    return true;
  }
  estado.cuenta += 1;
  return estado.cuenta <= LIMITE.peticiones;
}

/* ---------- contexto ---------- */

function normalizarContexto(ctx) {
  const c = ctx && typeof ctx === "object" ? ctx : {};
  const pozas = Array.isArray(c.pozas)
    ? c.pozas.map(function (p) { return texto(p, 20).toUpperCase(); }).filter(Boolean).slice(0, MAX_POZAS)
    : [];
  const hembras = Array.isArray(c.hembras)
    ? c.hembras.map(function (h) {
        if (Array.isArray(h)) {
          return [texto(h[0], 20).toUpperCase(), texto(h[1], 20).toUpperCase()];
        }
        return [texto(h && h.arete, 20).toUpperCase(), texto(h && h.poza, 20).toUpperCase()];
      }).filter(function (h) { return !!h[0]; }).slice(0, MAX_HEMBRAS)
    : [];
  return { pozas: pozas, hembras: hembras };
}

function bloqueContexto(ctx) {
  return (
    "\n\nContexto de la granja:\n" +
    "Pozas abiertas: " + (ctx.pozas.join(", ") || "ninguna") + ".\n" +
    "Hembras en gestación: " +
    (ctx.hembras.map(function (h) { return h[0] + (h[1] ? " (ubicación " + h[1] + ")" : ""); }).join(", ") || "ninguna") +
    "."
  );
}

/* ---------- Groq ---------- */

function extraerJson(cadena) {
  let t = String(cadena || "").trim();
  t = t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(t);
  } catch (e) {
    /* sigue abajo */
  }
  const m = t.match(/\{[\s\S]*\}/);
  if (!m) { throw new Error("la IA no devolvió JSON"); }
  return JSON.parse(m[0]);
}

function normalizar(obj) {
  const accion = obj && obj.accion;
  let datos = obj && obj.datos;
  if (!datos || typeof datos !== "object" || Array.isArray(datos)) { datos = {}; }
  if (!ACCIONES.has(accion)) {
    return { accion: "sin_accion", motivo: "No pude interpretar el mensaje." };
  }
  if (accion === "sin_accion") {
    const motivo = texto(datos.motivo, 300);
    return {
      accion: "sin_accion",
      motivo: motivo || "No entendí el mensaje. ¿Puedes decirlo de otra forma?"
    };
  }
  return { accion: accion, datos: datos };
}

/* Una llamada a Groq. `modoJson` pide la salida estructurada (más fiable, pero
   el modelo a veces no logra emitir JSON válido y Groq responde 400). */
async function llamarGroq(mensaje, ctx, env, modoJson, modelo) {
  const usado = modelo || env.MODELO_IA || "openai/gpt-oss-120b";
  const cuerpo = {
    model: usado,
    temperature: 0.1,
    /* 600 y no 300: los modelos gpt-oss gastan tokens "pensando" y con poco
       margen devuelven content vacío (y entonces no hay JSON que leer). */
    max_tokens: 600,
    messages: [
      { role: "system", content: SISTEMA + bloqueContexto(ctx) },
      { role: "user", content: mensaje }
    ]
  };
  /* gpt-oss razona antes de contestar; con "low" piensa menos y contesta igual. */
  if (/^openai\/gpt-oss/.test(usado)) { cuerpo.reasoning_effort = "low"; }
  if (modoJson) { cuerpo.response_format = { type: "json_object" }; }

  const respuesta = await fetch(URL_GROQ, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + env.GROQ_API_KEY
    },
    body: JSON.stringify(cuerpo),
    signal: AbortSignal.timeout(18000)
  });

  if (!respuesta.ok) {
    const detalle = (await respuesta.text()).slice(0, 300);
    const error = new Error("Groq " + respuesta.status + ": " + detalle);
    error.estado = respuesta.status;
    throw error;
  }

  const devuelto = await respuesta.json();
  return (((devuelto.choices || [])[0] || {}).message || {}).content || "";
}

/* Modelo de reserva: se usa si el principal se queda sin cupo. Los límites de
   Groq son por modelo, así que esto da aire en el plan gratis. "ninguno" lo apaga. */
function modeloReserva(env) {
  const r = String(env.MODELO_IA_RESERVA == null ? "openai/gpt-oss-20b" : env.MODELO_IA_RESERVA).trim();
  if (!r || r.toLowerCase() === "ninguno") { return ""; }
  return r;
}

async function interpretar(mensaje, ctx, env) {
  let contenido;
  try {
    contenido = await llamarGroq(mensaje, ctx, env, true);
  } catch (e) {
    const reserva = modeloReserva(env);
    if (e.estado === 400) {
      /* El modelo no consiguió un JSON válido: se reintenta en texto libre y se
         extrae el objeto con extraerJson(). */
      contenido = await llamarGroq(mensaje, ctx, env, false);
    } else if (e.estado === 429 && reserva && reserva !== (env.MODELO_IA || "openai/gpt-oss-120b")) {
      contenido = await llamarGroq(mensaje, ctx, env, true, reserva);
    } else {
      throw e;
    }
  }
  return normalizar(extraerJson(contenido));
}

/* ---------- Web Push: aviso al celular ----------
 *
 * El teléfono se suscribe desde Ajustes; la suscripción se guarda en KV junto
 * con un resumen del trabajo pendiente que el propio panel escribe cada vez que
 * se abre. El cron corre cada hora y solo avisa a quien pidió esa hora y tiene
 * algo pendiente: así no se molesta con avisos vacíos.
 *
 * El envío usa el estándar Web Push: firma VAPID (ES256) y cifrado del payload
 * (RFC 8291, aes128gcm). La clave privada VAPID vive como secreto VAPID_JWK.
 */

const TTL_SEGUNDOS = 12 * 3600;      // 12 h: si no llega, ya no sirve
const SUB_CLAVE_PREFIJO = "sub-";
const MAX_RESUMEN = 160;
const DIFERENCIA_LIMA = 5 * 3600 * 1000;   // UTC-5, sin horario de verano

function b64uAb(s) {
  s = String(s || "").replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) { s += "="; }
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) { out[i] = bin.charCodeAt(i); }
  return out;
}

function abB64u(buf) {
  const b = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < b.length; i++) { s += String.fromCharCode(b[i]); }
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function textoAb(s) {
  return new TextEncoder().encode(s);
}

function unir(...trozos) {
  const total = trozos.reduce((n, t) => n + t.length, 0);
  const out = new Uint8Array(total);
  let i = 0;
  for (const t of trozos) { out.set(t, i); i += t.length; }
  return out;
}

async function hkdf(salto, ikm, info, bytes) {
  const k = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: salto, info: info },
    k, bytes * 8
  );
}

/* Firma VAPID: un JWT ES256 con la clave privada de la pareja VAPID. */
async function vapidJwt(audiencia, env) {
  const jwk = JSON.parse(env.VAPID_JWK || "null");
  if (!jwk || !jwk.d) { throw new Error("Falta el secreto VAPID_JWK en el Worker."); }
  const clave = await crypto.subtle.importKey(
    "jwk", jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false, ["sign"]
  );
  const ahora = Math.floor(Date.now() / 1000);
  const cabecera = abB64u(textoAb(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const cuerpo = abB64u(textoAb(JSON.stringify({
    aud: audiencia,
    exp: ahora + 12 * 3600,
    sub: "mailto:roggergonzales18@gmail.com"
  })));
  const sinFirma = cabecera + "." + cuerpo;
  const firma = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    clave, textoAb(sinFirma)
  );
  return sinFirma + "." + abB64u(firma);
}

/* Cifra el payload con las claves de la suscripción (RFC 8291, aes128gcm). */
async function cifrarPush(carga, sub) {
  const clavePublicaUa = b64uAb(sub.keys && sub.keys.p256dh);
  const secretoAuth = b64uAb(sub.keys && sub.keys.auth);
  if (clavePublicaUa.length !== 65 || secretoAuth.length < 16) {
    throw new Error("Suscripción incompleta.");
  }

  const par = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const clavePublicaAs = new Uint8Array(await crypto.subtle.exportKey("raw", par.publicKey));
  const claveUa = await crypto.subtle.importKey(
    "raw", clavePublicaUa, { name: "ECDH", namedCurve: "P-256" }, false, []
  );
  const compartido = await crypto.subtle.deriveBits(
    { name: "ECDH", public: claveUa }, par.privateKey, 256
  );

  const infoIkm = unir(textoAb("WebPush: info"), new Uint8Array([0]), clavePublicaUa, clavePublicaAs);
  const ikm = await hkdf(secretoAuth, compartido, infoIkm, 32);

  const salto = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salto, ikm, textoAb("Content-Encoding: aes128gcm\u0000"), 16);
  const nonce = await hkdf(salto, ikm, textoAb("Content-Encoding: nonce\u0000"), 12);

  const llano = unir(textoAb(carga), new Uint8Array([2]));   // 0x02: último registro
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const cifrado = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, tagLength: 128 }, aes, llano
  ));

  const cabecera = new Uint8Array(21 + clavePublicaAs.length);
  cabecera.set(salto, 0);
  new DataView(cabecera.buffer).setUint32(16, 4096);          // tamaño de registro
  cabecera[20] = clavePublicaAs.length;                       // idlen
  cabecera.set(clavePublicaAs, 21);                           // clave pública efímera
  return unir(cabecera, cifrado);
}

/* Envía un push a una suscripción. Devuelve el estado HTTP del servicio. */
async function enviarPush(sub, carga, env) {
  const aud = new URL(sub.endpoint).origin;
  const jwt = await vapidJwt(aud, env);
  const cabeceras = {
    TTL: String(TTL_SEGUNDOS),
    Urgency: "high",
    Authorization: "vapid t=" + jwt + ", k=" + env.VAPID_PUBLIC
  };
  const init = { method: "POST", headers: cabeceras };
  if (carga) {
    cabeceras["Content-Type"] = "application/octet-stream";
    cabeceras["Content-Encoding"] = "aes128gcm";
    init.body = carga;
  }
  const r = await fetch(sub.endpoint, init);
  return r.status;
}

async function claveSub(endpoint) {
  const h = await crypto.subtle.digest("SHA-256", textoAb(endpoint));
  return SUB_CLAVE_PREFIJO + abB64u(h);
}

async function guardarSub(uid, sub, resumen, hora, env) {
  const clave = await claveSub(sub.endpoint);
  const registro = {
    granja: uid,
    endpoint: sub.endpoint,
    keys: sub.keys,
    resumen: texto(resumen, MAX_RESUMEN),
    hora: Math.min(23, Math.max(0, Number(hora) || 0)),
    actualizado: new Date().toISOString()
  };
  /* Si la suscripción ya existía de otra cuenta, se respeta al dueño original. */
  const previo = await env.AVISOS_KV.get(clave);
  if (previo) {
    try { if (JSON.parse(previo).granja !== uid) { return false; } } catch (e) { /* se sobreescribe */ }
  }
  await env.AVISOS_KV.put(clave, JSON.stringify(registro));
  return true;
}

/* Avisos de una hora dada (hora local de Lima). */
async function enviarProgramados(env) {
  if (!env.VAPID_JWK || !env.VAPID_PUBLIC) { return { enviados: 0, motivo: "faltan claves VAPID" }; }
  const hora = new Date(Date.now() - DIFERENCIA_LIMA).getUTCHours();
  let enviados = 0, borradas = 0, errores = 0;
  let cursor;
  do {
    const pagina = await env.AVISOS_KV.list({ cursor });
    cursor = undefined;
    for (const k of pagina.keys) {
      if (!k.name.startsWith(SUB_CLAVE_PREFIJO)) { continue; }
      const bruto = await env.AVISOS_KV.get(k.name);
      if (!bruto) { continue; }
      let reg;
      try { reg = JSON.parse(bruto); } catch (e) { continue; }
      if (Number(reg.hora) !== hora) { continue; }
      if (!reg.resumen) { continue; }
      try {
        const carga = await cifrarPush(JSON.stringify({ t: reg.resumen }), reg);
        const estado = await enviarPush(reg, carga, env);
        if (estado >= 200 && estado < 300) { enviados += 1; }
        else if (estado === 404 || estado === 410) { await env.AVISOS_KV.delete(k.name); borradas += 1; }
        else { errores += 1; }
      } catch (e) { errores += 1; }
    }
    if (pagina.list_complete === false) { cursor = pagina.cursor; }
  } while (cursor);
  return { enviados: enviados, borradas: borradas, errores: errores, hora: hora };
}

/* Ruta POST /suscribir — guarda o actualiza la suscripción del teléfono. */
async function suscribir(peticion, env, origen) {
  if (!env.AVISOS_KV) { return json({ error: "El Worker no tiene KV configurado." }, 500, env, origen); }
  const idToken = tokenDeCabecera(peticion);
  const uid = await uidDeToken(idToken, env);
  if (!uid) { return json({ error: "La sesión no es válida. Vuelve a iniciar sesión." }, 401, env, origen); }

  let cuerpo;
  try { cuerpo = await peticion.json(); } catch (e) { return json({ error: "El cuerpo debe ser JSON." }, 400, env, origen); }
  const sub = cuerpo && cuerpo.sub;
  if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
    return json({ error: "Suscripción incompleta." }, 400, env, origen);
  }
  if (String(sub.endpoint).indexOf("https://") !== 0) {
    return json({ error: "La suscripción debe usar HTTPS." }, 400, env, origen);
  }
  const ok = await guardarSub(uid, sub, cuerpo.resumen, cuerpo.hora, env);
  if (!ok) { return json({ error: "Esa suscripción pertenece a otra cuenta." }, 403, env, origen); }
  return json({ ok: true }, 200, env, origen);
}

/* Ruta POST /baja — borra la suscripción del teléfono que pide darse de baja. */
async function baja(peticion, env, origen) {
  if (!env.AVISOS_KV) { return json({ error: "El Worker no tiene KV configurado." }, 500, env, origen); }
  const idToken = tokenDeCabecera(peticion);
  const uid = await uidDeToken(idToken, env);
  if (!uid) { return json({ error: "La sesión no es válida. Vuelve a iniciar sesión." }, 401, env, origen); }

  let cuerpo;
  try { cuerpo = await peticion.json(); } catch (e) { return json({ error: "El cuerpo debe ser JSON." }, 400, env, origen); }
  if (!cuerpo || !cuerpo.endpoint) { return json({ error: "Falta el endpoint." }, 400, env, origen); }

  const clave = await claveSub(cuerpo.endpoint);
  const bruto = await env.AVISOS_KV.get(clave);
  if (!bruto) { return json({ ok: true }, 200, env, origen); }
  try {
    if (JSON.parse(bruto).granja !== uid) {
      return json({ error: "Esa suscripción pertenece a otra cuenta." }, 403, env, origen);
    }
  } catch (e) { /* una entrada rota se borra igual */ }
  await env.AVISOS_KV.delete(clave);
  return json({ ok: true }, 200, env, origen);
}

/* Ruta POST /avisos — envía un push de prueba a quien lo pide (desde Ajustes). */
async function avisoPrueba(peticion, env, origen) {
  if (!env.AVISOS_KV) { return json({ error: "El Worker no tiene KV configurado." }, 500, env, origen); }
  if (!env.VAPID_JWK) { return json({ error: "Falta el secreto VAPID_JWK en el Worker." }, 500, env, origen); }
  const idToken = tokenDeCabecera(peticion);
  const uid = await uidDeToken(idToken, env);
  if (!uid) { return json({ error: "La sesión no es válida. Vuelve a iniciar sesión." }, 401, env, origen); }

  let cuerpo = {};
  try { cuerpo = await peticion.json(); } catch (e) { cuerpo = {}; }

  const textoPrueba = texto(cuerpo.resumen, MAX_RESUMEN) || "Esto es una prueba del aviso. Si lo ves, tu celular ya está conectado.";
  let enviados = 0;
  let cursor;
  do {
    const pagina = await env.AVISOS_KV.list({ cursor });
    cursor = undefined;
    for (const k of pagina.keys) {
      if (!k.name.startsWith(SUB_CLAVE_PREFIJO)) { continue; }
      const bruto = await env.AVISOS_KV.get(k.name);
      if (!bruto) { continue; }
      let reg;
      try { reg = JSON.parse(bruto); } catch (e) { continue; }
      if (reg.granja !== uid) { continue; }
      /* `plano: true` envía sin payload: sirve para distinguir un problema de
         entrega de un problema de cifrado. */
      const carga = cuerpo.plano ? null : await cifrarPush(JSON.stringify({ t: textoPrueba }), reg);
      const estado = await enviarPush(reg, carga, env);
      if (estado === 404 || estado === 410) { await env.AVISOS_KV.delete(k.name); }
      else if (estado >= 200 && estado < 300) { enviados += 1; }
    }
    if (pagina.list_complete === false) { cursor = pagina.cursor; }
  } while (cursor);

  if (!enviados) {
    return json({ error: "No encontré una suscripción activa de tu cuenta. Activa las notificaciones e inténtalo otra vez." }, 404, env, origen);
  }
  return json({ ok: true, enviados: enviados }, 200, env, origen);
}

/* ---------- rutas ---------- */

async function asistente(peticion, env, origen) {
  if (!env.GROQ_API_KEY) {
    return json({ error: "Falta el secreto GROQ_API_KEY en el Worker." }, 500, env, origen);
  }

  let cuerpo;
  try {
    cuerpo = await peticion.json();
  } catch (e) {
    return json({ error: "El cuerpo debe ser JSON." }, 400, env, origen);
  }

  const mensaje = texto(cuerpo && cuerpo.texto, MAX_TEXTO);
  if (!mensaje) {
    return json({ error: "Escribe un mensaje para el asistente." }, 400, env, origen);
  }

  const exigirAuth = String(env.REQUIRE_AUTH || "true") !== "false";
  let uid = "anonimo";
  if (exigirAuth) {
    const idToken = tokenDeCabecera(peticion);
    if (!idToken) {
      return json({ error: "Falta el token de sesión." }, 401, env, origen);
    }
    uid = await uidDeToken(idToken, env);
    if (!uid) {
      return json({ error: "La sesión no es válida. Vuelve a iniciar sesión." }, 401, env, origen);
    }
  }

  if (!dentroDelLimite(uid)) {
    return json({ error: "Demasiadas consultas seguidas. Espera unos minutos." }, 429, env, origen);
  }

  const ctx = normalizarContexto(cuerpo.contexto);

  try {
    const r = await interpretar(mensaje, ctx, env);
    r.fuente = "ia";
    return json(r, 200, env, origen);
  } catch (e) {
    /* El panel tiene un intérprete de reglas: si esto falla, lo usa. */
    if (e && e.estado === 429) {
      return json(
        { error: "El asistente IA está recibiendo muchas consultas. Intenta en un minuto.", detalle: texto(e.message, 200) },
        429, env, origen
      );
    }
    return json(
      { error: "El asistente IA no está disponible ahora.", detalle: texto(e && e.message, 200) },
      503,
      env, origen
    );
  }
}

export default {
  async fetch(peticion, env) {
    const origen = peticion.headers.get("Origin") || "";
    const url = new URL(peticion.url);
    const permitidos = origenesPermitidos(env);

    /* El navegador manda Origin; si viene de un sitio no permitido, se corta. */
    if (origen && permitidos.length && permitidos.indexOf(origen) < 0) {
      return json({ error: "Origen no permitido." }, 403, env, origen);
    }

    if (peticion.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cabecerasCors(env, origen) });
    }

    if (peticion.method === "GET" && (url.pathname === "/" || url.pathname === "/salud")) {
      return json({
        ok: true,
        servicio: "cuymax-ia",
        modelo: env.MODELO_IA || "openai/gpt-oss-120b",
        rutas: ["POST /asistente", "POST /suscribir", "POST /baja", "POST /avisos"]
      }, 200, env, origen);
    }

    if (peticion.method === "POST" && url.pathname === "/asistente") {
      return asistente(peticion, env, origen);
    }

    if (peticion.method === "POST" && url.pathname === "/suscribir") {
      return suscribir(peticion, env, origen);
    }

    if (peticion.method === "POST" && url.pathname === "/baja") {
      return baja(peticion, env, origen);
    }

    if (peticion.method === "POST" && url.pathname === "/avisos") {
      return avisoPrueba(peticion, env, origen);
    }

    return json({ error: "Ruta no encontrada." }, 404, env, origen);
  },

  /* Cron cada hora: avisa a los teléfonos cuya hora local es la elegida y que
     tienen trabajo pendiente. */
  async scheduled(evento, env, ctx) {
    ctx.waitUntil(enviarProgramados(env).then(function (r) {
      console.log("avisos programados:", JSON.stringify(r));
    }));
  }
};
