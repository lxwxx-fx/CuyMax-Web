# cuymax-ia — Worker de IA

Worker de **Cloudflare** que interpreta los mensajes del asistente de CuyMax y
devuelve **una acción estructurada**. Usa **Groq** como modelo.

```
Navegador (panel)
   │  POST /asistente  { texto, contexto }  +  Authorization: Bearer <ID token>
   ▼
Worker cuymax-ia  ──►  Groq (llama a gpt-oss)
   │
   ▼  { accion: "registrar_muerte", datos: { lote: "P-001", cantidad: 2 } }
Panel: valida, muestra "¿Lo guardo?" y solo escribe si la persona confirma
```

## Por qué el Worker no toca la base de datos

El Worker **no conoce Firestore ni Supabase**. Solo recibe texto y devuelve una
propuesta. Eso permite:

- cambiar de base (Firestore → Supabase) sin tocar el Worker;
- que la IA nunca escriba sola: el panel valida y la persona confirma;
- no repartir credenciales de base de datos a un tercero.

## Requisitos

- Cuenta de Cloudflare (plan gratis sirve: 100.000 peticiones/día).
- Una API key de Groq: https://console.groq.com/keys

## Probar en local

```bash
cd worker
npm install
copy .dev.vars.example .dev.vars   # y pega tu GROQ_API_KEY
npm run dev                        # http://127.0.0.1:8787
```

Prueba rápida:

```bash
curl http://127.0.0.1:8787/salud

curl -X POST http://127.0.0.1:8787/asistente \
  -H "Content-Type: application/json" \
  -d '{"texto":"se murieron 2 cuyes en P-001 por diarrea","contexto":{"pozas":["P-001"]}}'
```

Para probar sin iniciar sesión en local, en `.dev.vars`:

```
REQUIRE_AUTH=false
```

> `REQUIRE_AUTH=false` es **solo para desarrollo**. En producción debe quedar
> en `true`, que es el valor de `wrangler.jsonc`.

## Publicar

```bash
cd worker
npx wrangler login                              # abre el navegador
npx wrangler secret put GROQ_API_KEY            # pega la clave (no se guarda en el repo)
npm run deploy                                  # publica el Worker
```

Wrangler imprime la URL, por ejemplo:

```
https://cuymax-ia.TU-SUBDOMINIO.workers.dev
```

Ponla en `firebase-config.js`:

```js
var CUYMAX_IA_URL = "https://cuymax-ia.TU-SUBDOMINIO.workers.dev";
```

Y vuelve a publicar el panel (`firebase deploy --only hosting`).

Si `CUYMAX_IA_URL` queda vacía, el panel usa su **intérprete de reglas** y no
hace ninguna llamada de red (útil para demo o si Groq falla).

## Variables

| Nombre | Dónde | Para qué |
| --- | --- | --- |
| `GROQ_API_KEY` | secreto (`wrangler secret put`) | Clave de Groq. Nunca en el navegador. |
| `MODELO_IA` | `wrangler.jsonc` | Modelo de Groq. Por defecto `openai/gpt-oss-120b`. |
| `MODELO_IA_RESERVA` | `wrangler.jsonc` | Modelo alternativo que se usa solo si el principal se queda sin cupo (`429`). Por defecto `openai/gpt-oss-20b`. Vacío = sin reserva. |
| `FIREBASE_API_KEY` | `wrangler.jsonc` | API key **pública** del proyecto; solo valida el ID token del usuario. |
| `ALLOWED_ORIGINS` | `wrangler.jsonc` | Dominios que pueden llamar al Worker. |
| `REQUIRE_AUTH` | `wrangler.jsonc` | `true` exige sesión de Firebase. |

## Seguridad

- **Token**: cada petición debe traer el ID token de Firebase. El Worker lo
  valida contra Google y obtiene el `uid`; sin token responde `401`.
- **CORS**: solo los orígenes de `ALLOWED_ORIGINS` reciben cabeceras. Otros
  orígenes reciben `403`.
- **Límite**: 30 peticiones por usuario cada 5 minutos (mejor esfuerzo por
  isolate). Para un límite estricto, usar KV o Durable Objects.
- **Entrada**: el texto se recorta a 500 caracteres y el contexto a 60 pozas /
  60 hembras. La IA devuelve JSON y el Worker descarta acciones desconocidas.
- **La clave de Groq** vive en el Worker. Si se filtra, se rota con
  `wrangler secret put GROQ_API_KEY` sin tocar el panel.

## Coste

- Workers: 100.000 peticiones/día gratis; luego 5 USD por millón.
- Groq: capa gratuita con **8.000 tokens por minuto y por modelo**. Cada mensaje
  gasta unos 1.200 tokens (el prompt del sistema es largo a propósito), así que
  salen ~6 mensajes por minuto. Si se pasa, el Worker reintenta con
  `MODELO_IA_RESERVA` (los límites son por modelo) y, si tampoco hay cupo,
  responde `429` y el panel sigue con el intérprete de reglas.
- Si la granja crece, subir de plan en Groq es lo único que hay que tocar: el
  código no cambia.

## Reintentos

- `400` de Groq (el modelo no logró un JSON válido): se reintenta una vez sin
  salida estructurada y se extrae el objeto del texto.
- `429` de Groq (cupo por minuto): se reintenta con `MODELO_IA_RESERVA`.

## Errores frecuentes

| Síntoma | Causa |
| --- | --- |
| `503` + `Groq 401: Invalid API Key` | La clave de Groq está revocada o mal copiada. Créala de nuevo y actualiza el secreto. |
| `401` + `Falta el token de sesión` | El panel no está mandando el `Authorization`. Revisa `CUYMAX_IA_URL` y que haya sesión. |
| `403 Origen no permitido` | El dominio no está en `ALLOWED_ORIGINS`. |
| `429` | Dos causas: límite de 30 consultas / 5 min por usuario, o cupo de tokens por minuto de Groq (el mensaje lo dice). |
| El chat responde con el intérprete de reglas | `CUYMAX_IA_URL` vacía, error del Worker o Groq caído: el panel cae a reglas a propósito. |
