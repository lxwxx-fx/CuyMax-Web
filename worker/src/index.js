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
  "Si es saludo, despedida o agradecimiento, el motivo debe ser una respuesta humana " +
  "y breve acorde (\"¡Hola! ¿En qué te ayudo?\", \"¡De nada! Aquí estoy para lo que necesites.\").\n" +
  "Reglas:\n" +
  "- No inventes datos.\n" +
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
  const cuerpo = {
    model: modelo || env.MODELO_IA || "openai/gpt-oss-120b",
    temperature: 0.1,
    max_tokens: 300,
    messages: [
      { role: "system", content: SISTEMA + bloqueContexto(ctx) },
      { role: "user", content: mensaje }
    ]
  };
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

async function interpretar(mensaje, ctx, env) {
  let contenido;
  try {
    contenido = await llamarGroq(mensaje, ctx, env, true);
  } catch (e) {
    if (e.estado === 400) {
      /* El modelo no consiguió un JSON válido: se reintenta en texto libre y se
         extrae el objeto con extraerJson(). */
      contenido = await llamarGroq(mensaje, ctx, env, false);
    } else if (e.estado === 429 && env.MODELO_IA_RESERVA &&
               env.MODELO_IA_RESERVA !== (env.MODELO_IA || "openai/gpt-oss-120b")) {
      /* Cupo agotado en el modelo principal: los límites de Groq son por modelo,
         así que el de reserva suele tener cupo libre. */
      contenido = await llamarGroq(mensaje, ctx, env, true, env.MODELO_IA_RESERVA);
    } else {
      throw e;
    }
  }
  return normalizar(extraerJson(contenido));
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
        rutas: ["POST /asistente"]
      }, 200, env, origen);
    }

    if (peticion.method === "POST" && url.pathname === "/asistente") {
      return asistente(peticion, env, origen);
    }

    return json({ error: "Ruta no encontrada." }, 404, env, origen);
  }
};
