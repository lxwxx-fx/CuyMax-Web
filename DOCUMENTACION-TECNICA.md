# Documentación técnica — CuyMax

| Campo | Valor |
|---|---|
| Sistema | CuyMax — registro y control productivo de granjas de cuyes |
| Autor | Roger Alberto Gonzales Peña |
| Empresa | DC PROJECTS |
| Versión del panel | v61 (`app/sw.js`, constante `CACHE`; 11 referencias `?v=61` en `app/index.html`) |
| Commit documentado | `fb887e2` (rama `main`) |
| Fecha del documento | 22 de noviembre de 2026 |
| Repositorio | https://github.com/lxwxx-fx/CuyMax-Web |
| Sitio publicado | https://cuymax-by-dc.web.app |

## Índice

1. [Introducción](#1-introducción)
2. [Stack tecnológico](#2-stack-tecnológico)
3. [Arquitectura](#3-arquitectura)
4. [PWA y modo offline](#4-pwa-y-modo-offline)
5. [Base de datos](#5-base-de-datos)
6. [Lógica de negocio](#6-lógica-de-negocio)
7. [Autenticación y seguridad](#7-autenticación-y-seguridad)
8. [Integración con el bot de mensajería](#8-integración-con-el-bot-de-mensajería)
9. [Configuración y variables de entorno](#9-configuración-y-variables-de-entorno)
10. [Despliegue paso a paso](#10-despliegue-paso-a-paso)
11. [Mantenimiento](#11-mantenimiento)
12. [Limitaciones conocidas y mejoras futuras](#12-limitaciones-conocidas-y-mejoras-futuras)
13. [Apéndice: elementos «NO ENCONTRADO EN EL CÓDIGO»](#13-apéndice-elementos-no-encontrado-en-el-código)

---

# 1. Introducción

## 1.1 Propósito

CuyMax es una aplicación web progresiva (PWA) para que un productor de cuyes registre y controle la operación de su granja desde el celular, sin depender de un cuaderno de campo.

El sistema resuelve cinco tareas concretas, todas verificables en el código:

| Tarea | Dónde está implementada |
|---|---|
| Registrar movimientos productivos: peso, muerte, alimento, parto, destete, ingreso, venta, faena y retiro sanitario | `app/firestore-data.js`, funciones `fsRegistrarPeso()`, `fsRegistrarMuerte()`, `fsRegistrarAlimento()`, `fsRegistrarParto()`, `fsRegistrarDestete()`, `fsRegistrarIngreso()`, `fsRegistrarVenta()`, `fsRegistrarFaena()`, `fsRegistrarRetiro()` |
| Calcular indicadores: población viva, mortalidad, margen en soles, pozas en retiro | `app/app.js`, `cargarPanel()`; `app/firestore-data.js`, `fsLoteFila()` y la ruta `GET /api/resumen-economico` de `apiReal()` |
| Avisar de partos próximos, destetes por edad, pesajes pendientes y retiros | `app/firestore-data.js`, `fsAvisosDe()` |
| Interpretar lenguaje natural para registrar o consultar («se murieron 2 cuyes en P-001 por diarrea») | `worker/src/index.js`, `interpretar()`; respaldo local en `app/firestore-data.js`, `interpretarAsistente()` |
| Funcionar sin conexión y sincronizar al volver la señal | `app/sw.js` (caché de la interfaz) y `app/firestore-data.js`, `fsdb()` (persistencia de Firestore) |

El sistema no es una maqueta: está desplegado en Firebase Hosting y opera contra Cloud Firestore con datos reales por cuenta.

## 1.2 Alcance

El documento cubre el código de la rama `main` en el commit `ed3cfcb`. El repositorio contiene **tres backends distintos** que conviven, y confundirlos es el error más fácil de cometer al leer el proyecto:

| Backend | Archivo | Cuándo se usa |
|---|---|---|
| Cloud Firestore | `app/firestore-data.js` | Modo monitoreo: la URL lleva `?modo=real` |
| Datos en memoria | `app/mock-data.js` | Modo demo: la URL lleva `?modo=demo`, o el host termina en `web.app` / `firebaseapp.com` / `e2b.app` |
| API local FastAPI + PostgreSQL | `server/api.py` | Ninguno de los dos anteriores: el panel llama a `/api/...` en el mismo origen |

La selección ocurre en `app/app.js`, función `api()`, y la detección de modo en `app/mock-data.js`, líneas 7-11.

### Qué queda dentro

- Panel PWA (`app/`), landing pública (`index.html`) y pantalla de acceso (`login.html`).
- Worker de Cloudflare con el asistente de IA y el envío de notificaciones push (`worker/`).
- Reglas de seguridad de Firestore (`firestore.rules`).
- API local con PostgreSQL (`server/`), usada en desarrollo.
- Cloud Function `asistente` (`functions/`), conservada como legado.

### Qué queda fuera

| Fuera del alcance | Motivo |
|---|---|
| Bot de Telegram o WhatsApp | No existe implementación. Hay endpoints de soporte en `server/api.py` y una tabla `usuarios` con campos `whatsapp`, pero ningún proceso que reciba o envíe mensajes. Ver sección 8 |
| Notas de voz | No hay captura de audio ni transcripción en ningún archivo |
| Aplicación nativa (Android/iOS) | Es una PWA instalable; no hay proyecto nativo ni contenedor |
| Pasarela de pagos, facturación electrónica | No hay integración de cobros |
| Módulo de sanidad distinto del retiro | Solo se registra el retiro sanitario (`retiros`); no hay historial clínico ni tratamientos |

### Dos precisiones que el código impone

**Las etapas de una poza (lote) son solo dos.** `fsCrearLote()` y `fsActualizarLote()` en `app/firestore-data.js` validan el campo `etapa` contra `"recria"` y `"engorde"`, y rechazan cualquier otro valor con el mensaje «La etapa debe ser recría o engorde». No existen «reproducción» ni «lactancia» como etapas de lote en el código. El término `reproduccion` aparece únicamente como `tipo` de una ubicación en los datos de ejemplo (`app/mock-data.js`, arreglo `pozas`), donde `tipo` es texto libre de hasta 30 caracteres (`fsCrearPoza()`).

**La meta de 900 g no es una constante del sistema.** El peso objetivo es un campo por poza, `peso_objetivo_g`, validado entre 20 y 3000 g en `fsActualizarLote()`. El valor 900 solo está precargado en los datos de demostración. Cada granja define su propio objetivo.

## 1.3 Público objetivo

### Lectores del documento

| Perfil | Qué busca | Secciones de interés |
|---|---|---|
| Desarrollador que mantiene el sistema | Dónde tocar sin romper nada, qué está acoplado y qué no | 3, 4, 6, 11 |
| Monitor de prácticas o evaluador técnico | Verificar que lo descrito corresponde al código | 2, 3, 5, 13 |
| Autor del proyecto | Referencia para retomarlo meses después | 9, 10, 11, 12 |
| Administrador de la infraestructura | Desplegar, rotar secretos, diagnosticar caídas | 7, 9, 10, 11 |

### Usuarios del sistema

El diseño del panel responde a un usuario concreto, y esto se deduce de decisiones visibles en el código, no de una suposición:

- **Usa el celular, no una computadora.** La navegación cambia a una rejilla de 3×2 por debajo de 860 px (`app/styles.css`) y existe un botón flotante de registro rápido (`#fab-registro` en `app/index.html`).
- **Trabaja donde no hay señal.** El panel abre desde la caché del service worker y las escrituras se acumulan en el teléfono hasta que vuelve la conexión (`app/sw.js`, `fsdb()`).
- **No escribe frases perfectas.** El intérprete de reglas acepta variantes como «H003» y «H-001» para la misma hembra (`fsCodigo()`) y el prompt de la IA admite errores y abreviaturas (`worker/src/index.js`, constante `SISTEMA`).
- **Necesita el dato en soles, no en porcentajes.** La rentabilidad se calcula y se muestra en S/ (`apiReal()`, ruta `resumen-economico`; `app/app.js`, `soles()`).

Una misma cuenta es una granja: el campo `granja_id` de todos los documentos es el `uid` de Firebase Auth del dueño (`firestore.rules`, `fsGranja()`). El sistema no contempla varias granjas por cuenta ni varios usuarios por granja.
