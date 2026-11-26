# CuyMax Web

Sitio de **CuyMax** (DC PROJECTS): landing pública + panel PWA de gestión de granjas de cuyes.
En la nube el panel se conecta a **Cloud Firestore**; en local se sirve una API propia (FastAPI + PostgreSQL).

- Sitio publicado: https://cuymax-by-dc.web.app

## Los dos modos del panel

| Modo | Cómo se entra | Fuente de datos |
| --- | --- | --- |
| **Demo** | Botón *Probar Demo* de la landing → `app/` | Datos de ejemplo en memoria (`app/mock-data.js`); no escribe nada |
| **Monitoreo** | Botón *Monitorear* → `app/?modo=real` | **Cloud Firestore** (datos privados de la cuenta con sesión) |

`MODO_DEMO` solo se activa en el dominio publicado; `MODO_REAL` depende del parámetro `?modo=real`
en la URL. En local, sin ese parámetro, el panel consume la API de `server/`.

En modo monitoreo cada cuenta es una granja: el campo `granja_id` de todos los documentos es el
`uid` de Firebase Auth y `firestore.rules` impide leer o escribir los datos de otra cuenta. Una
cuenta nueva empieza vacía (sin pozas ni registros); el nombre y los precios (balanceado, forraje
y precio por cuy) se cargan en **Ajustes**.

Colecciones de Firestore: `granjas`, `lotes`, `pozas`, `pesajes`, `mortalidad`,
`consumo_alimento`, `partos`, `partos_proximos`, `destetes`, `ventas`, `faenas`, `retiros`,
`guano`, `avisos_atendidos`.

## Secciones del panel

| Sección | Qué hace |
| --- | --- |
| **Panel** | Indicadores (partos próximos, cuyes vivos, pozas en retiro, margen), evolución, nacimientos, resumen económico por poza |
| **Poza** | Ficha de una poza: curva de peso, mortalidad, economía y último alimento |
| **Guano** | Recolección de abono por poza y venta por kilo: stock disponible, ingreso acumulado y producción por poza |
| **Registrar** | Acceso rápido a los diez movimientos (peso, muerte, alimento, parto, ingreso, destete, venta, faena, retiro) |
| **Avisos** | Avisos del día (partos próximos, destetes vencidos, pesajes pendientes) y atendidos |
| **Últimos registros** | Movimientos recientes de todas las colecciones, con opción de borrar |
| **Cuenta** | Solo en móvil: correo de la sesión y cierre de sesión |

El ingreso del guano se informa **aparte** del margen de los cuyes: el margen de la tabla
económica sigue siendo ingreso por venta de cuyes menos costo de alimento.

## Asistente con IA (Worker de Cloudflare)

El chat del panel entiende lenguaje libre («se murieron 2 cuyes en P-001 por diarrea»)
y propone una acción; **nada se guarda** hasta que la persona confirma.

Quien interpreta el mensaje es un **Worker de Cloudflare** que llama a **Groq**:

- código y despliegue: `worker/` (ver `worker/README.md`);
- el panel apunta al Worker con `CUYMAX_IA_URL` en `firebase-config.js`;
- si esa variable está vacía, o el Worker falla, el panel usa su **intérprete de
  reglas**: sin red, sin costo y con los casos más frecuentes.

El Worker **no accede a la base de datos**: recibe el texto y un contexto mínimo
(pozas abiertas y hembras en gestación) y devuelve una acción. Por eso sirve igual
con Firestore (hoy) que con Supabase (ver `docs/supabase/`).

La clave de Groq vive como **secreto del Worker** (`wrangler secret put GROQ_API_KEY`),
nunca en el navegador ni en el repositorio.

## Estructura

| Ruta | Contenido |
| --- | --- |
| `index.html`, `landing.css` | Landing pública |
| `login.html` | Acceso (Firebase Auth: correo/contraseña) |
| `app/` | Panel PWA |
| `app/firestore-data.js` | Capa de datos reales para el modo monitoreo + asistente |
| `app/ia-asistente.js` | Puente con el Worker de IA (sirve para Firestore y Supabase) |
| `app/mock-data.js` | Datos de ejemplo y detección del modo |
| `worker/` | **Worker de IA en Cloudflare** (Groq): texto libre → acción estructurada |
| `functions/` | Cloud Function `asistente` (legado, sustituida por `worker/`). Requiere plan Blaze |
| `server/` | API local (FastAPI + PostgreSQL), opcional en la nube |
| `img/` | Imágenes de la landing |
| `docs/` | Documentación del proyecto (no se publica) |
| `iniciar.bat` | Arranque local (API + sitio en `http://localhost:8000`) |
| `firebase.json`, `.firebaserc` | Configuración de Firebase Hosting |
| `firestore.rules` | Reglas de Firestore: exigen sesión iniciada |
| `server/firebase-creds.json` | Cuenta de servicio (NO se versiona; ver `.gitignore`) |

## Requisitos

- Python 3.12+ y `pip install -r server/requirements.txt` (incluye `firebase-admin`)
- PostgreSQL 18 (solo para la API local; la base de datos `cuyes`)
- Firebase CLI para desplegar (`npm install -g firebase-tools`)

## Ejecutar en local

1. Crear la base de datos `cuyes` en PostgreSQL.
2. Copiar `server/.env.example` a `server/.env` y completar los valores.
3. Instalar dependencias: `pip install -r server/requirements.txt`
4. Ejecutar `iniciar.bat` (verifica PostgreSQL y el puerto 8000, y abre el navegador).
5. Abrir http://localhost:8000

Para probar el modo monitoreo en local abre `http://localhost:8000/app/?modo=real`.

## Acceso en local

En local (sin `?modo=real`) el panel **no exige inicio de sesión**: trabaja contra la API
de `server/` y muestra "Modo local · sin sesión". El modo monitoreo (`?modo=real`) sigue
exigiendo una sesión de Firebase Auth para leer y escribir en Firestore.

La API local es abierta por defecto. Para protegerla define `API_TOKEN` en `server/.env`
y pega el mismo valor en **Ajustes → Clave de la API local** del panel; se guarda en el
navegador y se envía en el encabezado `X-API-Key`.

## Asistente (chat)

El panel tiene un chat en la pestaña **Asistente** con dos motores:

1. **Intérprete de reglas** (`app/firestore-data.js`, función `interpretarAsistente`).
   Funciona siempre, sin servidor ni clave: reconoce registros («se murieron 2 cuyes en
   P-001 por diarrea», «10 kg de balanceado para P-001», «peso de P-001 es 720 g»,
   «programar parto de H003…») y consultas («¿cómo va la poza P-001?», «¿cuántos vivos
   tiene P-001?», «¿qué avisos tengo?», «¿qué partos vienen?», «¿puedo vender?»).
   Las acciones de registro **siempre** se muestran como propuesta y solo se guardan si
   la persona pulsa *Confirmar*.

2. **IA en la nube** (Worker de Cloudflare, Groq). Entiende lenguaje libre. Se activa
   cuando `CUYMAX_IA_URL` apunta al Worker (en `firebase-config.js`); la clave de Groq
   vive como secreto del Worker, nunca en el navegador. La ruta antigua por `functions/`
   (Cloud Functions) quedó como legado porque exige el plan **Blaze**.

### Activar la IA (Worker de Cloudflare)

```bash
cd worker
npx wrangler login                          # abre el navegador
npx wrangler secret put GROQ_API_KEY        # pega la clave (no queda en el repo)
npm run deploy                              # publica el Worker
```

Poner la URL que imprime Wrangler en `firebase-config.js`:

```js
var CUYMAX_IA_URL = "https://cuymax-ia.TU-SUBDOMINIO.workers.dev";
```

Y volver a publicar el panel (`firebase deploy --only hosting`). `FS_IA_ACTIVA`
(en `app/firestore-data.js`) se calcula solo a partir de `CUYMAX_IA_URL`: si la URL
queda vacía o el Worker falla, el chat vuelve a las reglas sin tocar nada más.

## Despliegue

```bash
firebase deploy --only firestore:rules,hosting   # reglas + sitio (landing + panel)
```

`firebase deploy` **sin** `--only` intenta publicar también `functions/` y falla si el
proyecto sigue en plan Spark: usa siempre `--only firestore:rules,hosting` (o `desplegar.bat`).

**Reglas de Firestore**: `firestore.rules` solo deja leer y escribir documentos cuyo
`granja_id` sea el `uid` de la cuenta con sesión. Sin inicio de sesión, o pidiendo datos de
otra cuenta, la base devuelve 403. Las reglas se publican con el comando anterior.

**Nota de seguridad**: el `apiKey` de Firebase del cliente es público por diseño; lo que protege
la base son estas reglas. `server/firebase-creds.json` (clave privada del administrador) y
`server/.env` nunca deben subirse al repositorio.

## Verificación del sistema publicado

Cinco scripts con `puppeteer-core` prueban el sitio **en producción**, no en local:

| Script | Qué comprueba |
| --- | --- |
| `verificar-sistema.js` | Portada y panel: carga, las 7 secciones, consola sin errores, layout móvil |
| `verificar-flujos.js` | Flujos críticos: aviso de instalación, modo real sin sesión, login, recarga sin internet |
| `verificar-recursos.js` | Que ningún recurso de la página devuelva 404 |
| `verificar-registro.js` | 30 comprobaciones funcionales en demo: registra peso, muerte, alimento, venta y parto, y verifica que los KPI reaccionen |
| `prueba-real.js` | Modo real: abre una ventana para que inicies sesión a mano y luego comprueba el panel con datos reales (solo lectura) |

```bash
npm install puppeteer-core     # una sola vez
node verificar-sistema.js
node verificar-flujos.js
node verificar-recursos.js
node verificar-registro.js
node prueba-real.js            # pide iniciar sesión en la ventana que se abre
```

Necesitan un navegador basado en Chromium. Los scripts apuntan a Edge en Windows
(`const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"`); en otro
sistema cambia esa línea por la ruta de tu Chrome o Edge.
