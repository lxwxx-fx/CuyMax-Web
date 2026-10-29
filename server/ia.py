"""Interpreta mensajes escritos con libertad usando Groq (rápido y capa gratuita).
La IA NO toca la base de datos: solo propone UNA acción estructurada en JSON.
Después el código la valida (acciones.py) y la persona la confirma con un botón."""
import json
import os
import re

import httpx

ACCIONES_VALIDAS = {
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
}

SISTEMA = (
    "Eres el intérprete de mensajes de un sistema de gestión de cuyes (cobayos de crianza). "
    "Un operario de granja escribe en lenguaje natural, a veces con errores o abreviaturas. "
    "Convierte el mensaje en UNA acción. Responde SOLO con JSON, sin explicaciones.\n"
    "Formato: {\"accion\": \"<nombre>\", \"datos\": {…}}\n"
    "Acciones posibles:\n"
    "- registrar_peso: datos {\"lote\": \"P-001\", \"peso_g\": 720, \"animales_pesados\": 8}. "
    "peso_g en gramos (si dice kilos, convierte). animales_pesados solo si lo dice.\n"
    "- registrar_muerte: datos {\"lote\": \"P-001\", \"cantidad\": 2, \"causa\": \"diarrea\"}. "
    "causa solo si la menciona.\n"
    "- registrar_alimento: datos {\"lote\": \"P-001\", \"tipo\": \"forraje|balanceado\", \"kg\": 12.5}.\n"
    "- registrar_parto: datos {\"hembra\": \"H003\", \"poza\": \"U-01\", "
    "\"nacidos_vivos\": 5, \"nacidos_muertos\": 0}. "
    "hembra o ubicación (con una basta); si no dice muertos, usa 0.\n"
    "- consultar_partos: datos {}. Preguntas sobre partos próximos.\n"
    "- consultar_lote: datos {\"lote\": \"P-001\"}. Preguntas sobre cómo va UNA poza.\n"
    "- consultar_lotes: datos {\"lotes\": [\"P-001\", \"P-002\"]}. Varias pozas a la vez, "
    "o todas las abiertas si preguntan en general (\"todas las pozas\", \"cómo van las pozas\"). "
    "Si no nombra ninguno, deja la lista vacía.\n"
    "- consultar_alertas: datos {}. Pide avisos, alertas o pendientes.\n"
    "- consultar_retiro: datos {}. Pregunta por retiro sanitario o si se puede vender.\n"
    "- sin_accion: datos {\"motivo\": \"frase corta en español\"}. "
    "Úsala si falta un dato obligatorio, el mensaje es ambiguo o no es de la granja. "
    "Si es saludo, despedida o agradecimiento, el motivo debe ser una respuesta humana "
    "y breve acorde (\"¡Hola! ¿En qué te ayudo?\", \"¡De nada! Aquí estoy para lo que necesites.\").\n"
    "Reglas:\n"
    "- No inventes datos.\n"
    "- Usa los códigos de poza y hembra del contexto aunque el mensaje los nombre "
    "aproximados ('poza 1' puede ser P-001). Si hay duda, usa sin_accion."
)


def _api_key():
    return os.environ.get("GROQ_API_KEY")


def disponible():
    return bool(_api_key())


def _extraer_json(texto):
    """Saca el primer objeto JSON del texto (tolera ```json ... ```)."""
    t = (texto or "").strip()
    t = re.sub(r"^```(?:json)?\s*", "", t, flags=re.I)
    t = re.sub(r"\s*```$", "", t)
    try:
        return json.loads(t)
    except json.JSONDecodeError:
        pass
    m = re.search(r"\{.*\}", t, re.S)
    if m:
        return json.loads(m.group(0))
    raise ValueError("la IA no devolvió JSON")


def interpretar(texto, lotes, hembras):
    """Devuelve (nombre_de_accion, datos). Lanza excepción si falla la API."""
    key = _api_key()
    if not key:
        raise RuntimeError("Falta GROQ_API_KEY en el .env")
    contexto = (
        "\n\nContexto de la granja:\n"
        f"Pozas abiertas: {', '.join(lotes) or 'ninguna'}.\n"
        "Hembras en gestación: "
        + (", ".join(f"{a} (ubicación {p})" for a, p in hembras) or "ninguna")
        + "."
    )
    resp = httpx.post(
        "https://api.groq.com/openai/v1/chat/completions",
        headers={"Authorization": f"Bearer {key}"},
        json={
            "model": os.environ.get("MODELO_IA", "openai/gpt-oss-20b"),
            "temperature": 0.1,
            "max_tokens": 300,
            "response_format": {"type": "json_object"},
            "messages": [
                {"role": "system", "content": SISTEMA + contexto},
                {"role": "user", "content": texto},
            ],
        },
        timeout=20.0,
    )
    try:
        resp.raise_for_status()
    except httpx.HTTPStatusError as e:
        raise RuntimeError(f"Groq {resp.status_code}: {resp.text[:300]}") from e
    contenido = resp.json()["choices"][0]["message"]["content"]
    obj = _extraer_json(contenido)
    accion = obj.get("accion")
    datos = obj.get("datos") or {}
    if accion not in ACCIONES_VALIDAS or not isinstance(datos, dict):
        return "sin_accion", {"motivo": "No pude interpretar el mensaje."}
    return accion, datos
