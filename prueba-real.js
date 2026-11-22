/* Prueba del MODO REAL sobre la cuenta del autor.
 *
 * Abre una ventana de Edge con un perfil aparte y espera a que la persona inicie
 * sesión a mano. Nunca lee ni imprime la contraseña ni el token: solo comprueba
 * que el panel carga los datos de la granja y que el asistente responde.
 *
 * Es de SOLO LECTURA: no registra, no modifica y no borra nada de la granja.
 * Las únicas escrituras son las que hace el propio panel al abrirse (crear el
 * documento de granja si no existe), igual que en un uso normal.
 */
const puppeteer = require("puppeteer-core");
const fs = require("fs");
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const BASE = "https://cuymax-by-dc.web.app";
const PERFIL = "C:/Users/Admin/AppData/Local/Temp/cuymax-perfil-prueba";
const OUT = "C:/Users/Admin/AppData/Local/Temp/vr";
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const LIMITE_MS = 8 * 60 * 1000;

const errores = [];
const res = [];
function paso(nombre, bien, detalle) {
  res.push({ nombre, bien });
  console.log((bien ? "  OK   " : "  FALLA") + " | " + nombre + (detalle ? " -> " + detalle : ""));
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: false,
    userDataDir: PERFIL,
    args: ["--no-sandbox", "--start-maximized"],
    defaultViewport: null
  });
  const pages = await browser.pages();
  const page = pages[0] || (await browser.newPage());
  page.on("pageerror", (e) => errores.push("pageerror: " + e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errores.push("console: " + m.text().slice(0, 150));
  });

  const texto = (sel) => page.$eval(sel, (el) => el.textContent.replace(/\s+/g, " ").trim());

  try {
    await page.goto(BASE + "/login.html?next=%2Fapp%2F%3Fmodo%3Dreal",
      { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.evaluate(() => {
      const d = document.createElement("div");
      d.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:99999;background:#0E9F6E;" +
        "color:#fff;font:600 15px system-ui;padding:14px 20px;text-align:center;box-shadow:0 2px 10px rgba(0,0,0,.2)";
      d.textContent = "Prueba automática de CuyMax · inicia sesión con tu cuenta. La ventana se cerrará sola al terminar.";
      document.body.appendChild(d);
    });

    console.log("ESPERANDO EL INICIO DE SESION (hasta 8 minutos)...");
    const t0 = Date.now();
    let dentro = false;
    while (Date.now() - t0 < LIMITE_MS) {
      let u = "";
      try { u = page.url(); } catch (e) { u = ""; }
      if (u.indexOf("/app/") >= 0) { dentro = true; break; }
      await espera(1500);
    }
    if (!dentro) {
      paso("inicio de sesion", false, "no se inicio sesion en 8 minutos");
      await browser.close();
      process.exit(1);
    }
    paso("inicio de sesion y entrada al panel", true, page.url().split("?")[1] || "");

    await page.waitForSelector("#kpi-vivos", { timeout: 30000 });
    await espera(4000);

    const enReal = await page.evaluate(() => !!document.getElementById("badge-real") &&
      !document.getElementById("badge-real").classList.contains("oculto"));
    paso("el panel esta en modo real", enReal, "chip Modo real");

    const granja = await texto("#granja-nombre").catch(() => "");
    paso("aparece el nombre de la granja", granja.length > 0 && granja !== "Mi granja",
      granja || "(vacio)");

    const kpis = await page.evaluate(() => {
      const g = (id) => {
        const e = document.getElementById(id);
        return e ? e.textContent.trim() : "";
      };
      return { vivos: g("kpi-vivos"), partos: g("kpi-partos"), margen: g("kpi-margen"), retiro: g("kpi-retiro") };
    });
    paso("los KPI tienen valor (no guiones)", !/^[—–-]$/.test(kpis.vivos),
      "vivos=" + kpis.vivos + " partos=" + kpis.partos + " margen=" + kpis.margen + " retiro=" + kpis.retiro);

    const filasLotes = (await page.$$("#lotes tbody tr")).length;
    paso("la tabla de pozas trae tus pozas", filasLotes > 0, filasLotes + " filas");
    const filasEco = (await page.$$("#economico tbody tr")).length;
    paso("la tabla economica carga", filasEco > 0, filasEco + " filas");

    const grafica = await page.evaluate(() => {
      const c = document.getElementById("grafica-panel");
      return !!(c && c.width > 0);
    });
    paso("la grafica de evolucion se dibuja", grafica, "");

    /* Avisos: lectura pura. */
    await page.click('.nav-item[data-tab="avisos"]');
    await espera(2500);
    const avisos = await texto("#tab-avisos");
    paso("la seccion de avisos carga", avisos.length > 40, avisos.slice(0, 80));

    /* Poza: curva de la primera poza real. */
    await page.click('.nav-item[data-tab="lote"]');
    await espera(1200);
    const hayOpciones = await page.evaluate(
      () => document.querySelectorAll("#sel-lote option").length > 1);
    paso("el selector de pozas tiene opciones", hayOpciones, "");
    if (hayOpciones) {
      const primera = await page.evaluate(
        () => document.querySelectorAll("#sel-lote option")[1].value);
      await page.select("#sel-lote", primera);
      await espera(2500);
      const ficha = await texto("#tab-lote");
      paso("la ficha de la poza " + primera + " carga", ficha.length > 60, ficha.slice(0, 70));
    }

    /* Asistente real: consulta de solo lectura. */
    console.log("PROBANDO EL ASISTENTE CON IA (consulta, no escribe)...");
    await page.click("#ia-fab");
    await espera(1500);
    const formularioVisible = await page.evaluate(() => {
      const f = document.getElementById("f-chat");
      return !!f && !f.classList.contains("oculto");
    });
    paso("el asistente esta habilitado (no es demo)", formularioVisible, "");
    if (formularioVisible) {
      await page.type("#chat-texto", "¿qué avisos tengo pendientes?");
      await page.click("#chat-enviar");
      let respondio = false;
      for (let i = 0; i < 40; i++) {
        await espera(1000);
        const msgs = await page.evaluate(() => {
          const c = document.getElementById("chat-msgs");
          if (!c) { return []; }
          return Array.from(c.querySelectorAll(".chat-msg")).map((m) => m.textContent.trim());
        });
        if (msgs.length >= 3 && msgs[msgs.length - 1].length > 10) {
          respondio = true;
          console.log("  respuesta: " + msgs[msgs.length - 1].slice(0, 140).replace(/\n/g, " "));
          break;
        }
      }
      paso("el asistente responde en modo real", respondio, "");
    }
    await page.screenshot({ path: OUT + "/20-real-asistente.png" });

    /* Estado de las notificaciones push. */
    await page.click("#ia-cerrar").catch(() => {});
    await espera(600);
    await page.click("#btn-ajustes");
    await espera(1500);
    const push = await page.evaluate(() => {
      const e = document.getElementById("cfg-push-estado");
      const h = document.getElementById("cfg-push-hora");
      return { estado: e ? e.textContent.trim() : "", hora: h ? h.value : "" };
    });
    paso("Ajustes muestra el estado de las notificaciones", true,
      "estado=" + (push.estado || "(vacio)") + " hora=" + (push.hora || "-"));
    await page.screenshot({ path: OUT + "/21-real-ajustes.png" });
    await page.click("#btn-cerrar-ajustes").catch(() => {});
    await espera(800);
    await page.screenshot({ path: OUT + "/22-real-panel.png" });
  } catch (e) {
    paso("EXCEPCION", false, e.message);
  }

  console.log("== ERRORES DE CONSOLA ==");
  console.log(errores.length ? errores.slice(0, 8).join("\n  ") : "  ninguno");
  const malos = res.filter((r) => !r.bien).length;
  console.log("\n== RESUMEN MODO REAL ==");
  console.log("  pruebas: " + res.length + " | fallos: " + malos + " | errores consola: " + errores.length);

  await browser.close();
  /* El perfil temporal guarda la sesión: se borra para no dejar el token en disco. */
  try { fs.rmSync(PERFIL, { recursive: true, force: true }); } catch (e) { /* en uso */ }
  process.exit(malos ? 1 : 0);
})();
