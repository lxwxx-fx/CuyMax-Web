/* CuyMax — Asistente IA (Cloud Function).
 *
 * El navegador llama a esta función al enviar un mensaje en el chat. Aquí vive
 * la clave de Groq (Secret Manager: GROQ_API_KEY), nunca en el cliente.
 *
 * La IA NO escribe en la base: solo devuelve UNA acción con sus datos. El panel
 * la valida, se la muestra a la persona y solo la guarda si ella confirma.
 */
"use strict";

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret, defineString } = require("firebase-functions/params");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();

const GROQ_API_KEY = defineSecret("GROQ_API_KEY");
const MODELO_IA = defineString("MODELO_IA", { default: "openai/gpt-oss-120b" });

const URL_GROQ = "https://api.groq.com/openai/v1/chat/completions";
const MAX_TEXTO = 500;

/* Acciones que el panel sabe ejecutar. */
const ACCIONES = new Set([
  "registrar_peso",
  "registrar_muerte",
  "registrar_alimento",
  "registrar_parto",
  "consultar_partos",
  "consultar_lote",
  "consultar_lotes",
  "consultar_alertas",
  "consultar_retiro",
  "sin_accion",
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
  "- registrar_parto: datos {\"hembra\": \"H003\", \"poza\": \"U-01\", " +
  "\"nacidos_vivos\": 5, \"nacidos_muertos\": 0}. " +
  "hembra o ubicación (con una basta); si no dice muertos, usa 0.\n" +
  "- consultar_partos: datos {}. Preguntas sobre partos próximos.\n" +
  "- consultar_lote: datos {\"lote\": \"P-001\"}. Preguntas sobre cómo va UNA poza.\n" +
  "- consultar_lotes: datos {\"lotes\": [\"P-001\", \"P-002\"]}. Varias pozas a la vez, " +
  "o todas las abiertas si preguntan en general (\"todas las pozas\", \"cómo van las pozas\"). " +
  "Si no nombra ninguno, deja la lista vacía.\n" +
  "- consultar_alertas: datos {}. Pide avisos, alertas o pendientes.\n" +
  "- consultar_retiro: datos {}. Pregunta por retiro sanitario o si se puede vender.\n" +
  "- sin_accion: datos {\"motivo\": \"frase corta en español\"}. " +
  "Úsala si falta un dato obligatorio, el mensaje es ambiguo o no es de la granja. " +
  "Si es saludo, despedida o agradecimiento, el motivo debe ser una respuesta humana " +
  "y breve acorde (\"¡Hola! ¿En qué te ayudo?\", \"¡De nada! Aquí estoy para lo que necesites.\").\n" +
  "Reglas:\n" +
  "- No inventes datos.\n" +
  "- Usa los códigos de poza y hembra del contexto aunque el mensaje los nombre " +
  "aproximados ('poza 1' puede ser P-001). Si hay duda, usa sin_accion.";

/* ---------- contexto de la granja ---------- */

async function contextoGranja(granjaId) {
  if (!Number.isInteger(granjaId) || granjaId <= 0) {
    return { lotes: [], hembras: [] };
  }
  const [lotesSnap, proxSnap] = await Promise.all([
    db.collection("lotes").where("granja_id", "==", granjaId).get(),
    db.collection("partos_proximos").where("granja_id", "==", granjaId).get(),
  ]);

  const lotes = lotesSnap.docs
    .map((d) => d.data() || {})
    .filter((x) => x.codigo && String(x.estado || "abierto") === "abierto")
    .map((x) => String(x.codigo).toUpperCase())
    .sort();

  const hembras = proxSnap.docs
    .map((d) => d.data() || {})
    .filter((x) => x.hembra)
    .map((x) => [String(x.hembra).toUpperCase(), String(x.poza || "sin ubicación")])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  return { lotes, hembras };
}

/* ---------- Groq ---------- */

/* Saca el primer objeto JSON del texto (tolera ```json ... ```). */
function extraerJson(texto) {
  let t = String(texto || "").trim();
  t = t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(t);
  } catch (e) {
    /* sigue abajo */
  }
  const m = t.match(/\{[\s\S]*\}/);
  if (!m) {
    throw new Error("la IA no devolvió JSON");
  }
  return JSON.parse(m[0]);
}

function normalizar(obj) {
  const accion = obj && obj.accion;
  let datos = obj && obj.datos;
  if (!datos || typeof datos !== "object" || Array.isArray(datos)) {
    datos = {};
  }
  if (!ACCIONES.has(accion)) {
    return { accion: "sin_accion", motivo: "No pude interpretar el mensaje." };
  }
  if (accion === "sin_accion") {
    const motivo = String(datos.motivo || "").trim();
    return {
      accion: "sin_accion",
      motivo: motivo.slice(0, 300) || "No entendí el mensaje. ¿Puedes decirlo de otra forma?",
    };
  }
  return { accion, datos };
}

async function interpretar(texto, ctx) {
  const contexto =
    "\n\nContexto de la granja:\n" +
    "Pozas abiertas: " + (ctx.lotes.join(", ") || "ninguna") + ".\n" +
    "Hembras en gestación: " +
    (ctx.hembras.map(([a, p]) => `${a} (ubicación ${p})`).join(", ") || "ninguna") +
    ".";

  const respuesta = await fetch(URL_GROQ, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + GROQ_API_KEY.value(),
    },
    body: JSON.stringify({
      model: MODELO_IA.value() || "openai/gpt-oss-120b",
      temperature: 0.1,
      max_tokens: 300,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SISTEMA + contexto },
        { role: "user", content: texto },
      ],
    }),
    signal: AbortSignal.timeout(18000),
  });

  if (!respuesta.ok) {
    const detalle = (await respuesta.text()).slice(0, 300);
    throw new Error("Groq " + respuesta.status + ": " + detalle);
  }

  const json = await respuesta.json();
  const contenido =
    (((json.choices || [])[0] || {}).message || {}).content || "";
  return normalizar(extraerJson(contenido));
}

/* ---------- función ---------- */

exports.asistente = onCall(
  {
    region: "us-central1",
    secrets: [GROQ_API_KEY],
    timeoutSeconds: 30,
    memory: "256MiB",
  },
  async (req) => {
    if (!req.auth) {
      throw new HttpsError("unauthenticated", "Inicia sesión para usar el asistente.");
    }

    const texto = String((req.data && req.data.texto) || "").trim().slice(0, MAX_TEXTO);
    if (!texto) {
      throw new HttpsError("invalid-argument", "Escribe un mensaje para el asistente.");
    }

    /* El uid de la sesión es la granja: nunca se confía en un id del cliente. */
    const granjaId = req.auth.uid;
    let ctx;
    try {
      ctx = await contextoGranja(granjaId);
    } catch (e) {
      console.error("No se pudo leer el contexto de la granja:", e);
      ctx = { lotes: [], hembras: [] };
    }

    try {
      return await interpretar(texto, ctx);
    } catch (e) {
      console.error("Asistente IA:", e && e.message);
      /* El panel tiene un intérprete de reglas: al fallar aquí, lo usa. */
      throw new HttpsError("unavailable", "El asistente IA no está disponible ahora.");
    }
  }
);
