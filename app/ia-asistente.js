/* CuyMax — puente con el Worker de IA (Cloudflare + Groq).
 *
 * Un solo lugar para llamar al asistente, sin importar dónde estén los datos:
 *   - Firestore  → firestore-data.js
 *   - Supabase   → supabase-data.js
 *
 * La IA NO escribe nada: devuelve una acción propuesta y el panel la confirma.
 *
 * Configuración: `CUYMAX_IA_URL` en firebase-config.js. Si está vacía, el panel
 * usa su intérprete de reglas y nunca llama a la red.
 */
"use strict";

/* true cuando hay un Worker configurado. */
function iaConfigurada() {
  return typeof CUYMAX_IA_URL === "string" && /^https?:\/\//.test(CUYMAX_IA_URL);
}

function iaUrl() {
  return String(CUYMAX_IA_URL).replace(/\/+$/, "") + "/asistente";
}

/* Envuelve una promesa con tiempo máximo (la IA no debe colgar el chat). */
function iaConTiempo(promesa, ms) {
  return new Promise(function (resolver, rechazar) {
    var t = setTimeout(function () {
      rechazar(new Error("El asistente tardó demasiado en responder."));
    }, ms);
    promesa.then(function (v) { clearTimeout(t); resolver(v); },
                 function (e) { clearTimeout(t); rechazar(e); });
  });
}

/* Interpreta un mensaje.
 *
 * texto       : lo que escribió el operario
 * contexto    : { pozas: ["P-001", ...], hembras: [["H-001", "U-02"], ...] }
 * obtenerToken: función async que devuelve el ID token de la sesión
 *               (Firebase: user.getIdToken(); Supabase: session.access_token)
 *
 * Devuelve { accion, datos, motivo } o lanza un Error legible.
 */
async function iaInterpretar(texto, contexto, obtenerToken) {
  if (!iaConfigurada()) { throw new Error("Asistente IA no configurado."); }
  if (typeof obtenerToken !== "function") { throw new Error("Falta la sesión para usar el asistente."); }

  var token = await obtenerToken();
  if (!token) { throw new Error("Inicia sesión para usar el asistente con IA."); }

  var r = await iaConTiempo(fetch(iaUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
    body: JSON.stringify({ texto: String(texto || ""), contexto: contexto || {} })
  }), 20000);

  var d = null;
  try { d = await r.json(); } catch (e) { d = null; }

  if (!r.ok) {
    throw new Error((d && d.error) || ("El asistente IA respondió " + r.status + "."));
  }
  if (!d || !d.accion) { throw new Error("El asistente no devolvió una acción."); }
  return { accion: d.accion, motivo: d.motivo, datos: d.datos || {} };
}
