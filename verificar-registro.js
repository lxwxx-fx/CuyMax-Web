/* Prueba funcional de CuyMax sobre el sitio publicado, en modo demo.
   Registra movimientos reales (peso, muerte, alimento, parto, venta) y comprueba
   que el panel y la lista de registros reaccionan. En modo demo las escrituras
   viven en memoria (MOCK), así que no toca datos reales de ninguna granja. */
const puppeteer = require("puppeteer-core");
const fs = require("fs");
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const BASE = "https://cuymax-by-dc.web.app";
const OUT = "C:/Users/Admin/AppData/Local/Temp/vr";
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

const errores = [];
const resultados = [];
function paso(nombre, bien, detalle) {
  resultados.push({ nombre, bien, detalle: detalle || "" });
  console.log((bien ? "  OK   " : "  FALLA") + " | " + nombre + (detalle ? " -> " + detalle : ""));
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: EDGE, headless: "new",
    args: ["--no-sandbox", "--disable-dev-shm-usage"]
  });
  const page = await browser.newPage();
  page.on("pageerror", (e) => errores.push("pageerror: " + e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errores.push("console: " + m.text().slice(0, 150));
  });
  await page.setViewport({ width: 1440, height: 900 });

  const kpi = async (id) => {
    const t = await page.$eval("#" + id, (el) => el.textContent.trim());
    const n = Number(String(t).replace(/[^\d.-]/g, ""));
    return { texto: t, num: isNaN(n) ? 0 : n };
  };

  async function abrir(accion) {
    const abierto = await page.$("#dlg-registrar[open]");
    if (!abierto) {
      /* El botón flotante solo existe en móvil (CSS: display:none por encima de
         860 px). En escritorio el registro se abre con el botón de la barra. */
      const fabVisible = await page.evaluate(() => {
        const f = document.getElementById("fab-registro");
        return !!f && f.getBoundingClientRect().width > 0;
      });
      await page.click(fabVisible ? "#fab-registro" : "#btn-rapido");
      await page.waitForSelector("#dlg-registrar[open]", { timeout: 8000 });
      await espera(400);
    }
    if (accion) {
      await page.click('button.dlg-accion[data-accion="' + accion + '"]');
      await espera(450);
    }
  }
  async function cerrar() {
    await page.click("#dlg-cerrar");
    await espera(350);
  }
  async function enviar(formId) {
    await page.click("#" + formId + ' button[type="submit"]');
    const h = await page.waitForFunction(
      (id) => {
        const el = document.querySelector("#" + id + " .r");
        if (!el) { return null; }
        const t = el.textContent.trim();
        return /Listo|Error|No se pudo|no parece|Revisa|Dime|solo tiene|existe/i.test(t) ? t : null;
      },
      { timeout: 15000 }, formId
    );
    return h.jsonValue();
  }
  const texto = (sel) => page.$eval(sel, (el) => el.textContent.replace(/\s+/g, " ").trim());

  try {
    console.log("== 1. CARGA DEL PANEL (modo demo) ==");
    await page.goto(BASE + "/app/?modo=demo", { waitUntil: "networkidle2", timeout: 45000 });
    await page.waitForSelector("#kpi-vivos", { timeout: 20000 });
    await espera(1500);
    const vivos0 = await kpi("kpi-vivos");
    const partos0 = await kpi("kpi-partos");
    const margen0 = await kpi("kpi-margen");
    paso("panel carga con KPI", vivos0.num > 0,
      "vivos=" + vivos0.texto + " partos=" + partos0.texto + " margen=" + margen0.texto);
    paso("tabla de pozas con filas", (await page.$$("#lotes tbody tr")).length >= 4,
      (await page.$$("#lotes tbody tr")).length + " filas");
    paso("tabla economica con filas", (await page.$$("#economico tbody tr")).length >= 4,
      (await page.$$("#economico tbody tr")).length + " filas");
    paso("grafica de evolucion dibujada",
      await page.evaluate(() => {
        const c = document.getElementById("grafica-panel");
        return !!(c && c.width > 0 && c.getContext("2d").getImageData(0, 0, c.width, c.height)
          .data.some((v, i) => i % 4 === 3 && v > 0));
      }), "canvas con pixeles");
    await page.screenshot({ path: OUT + "/01-panel.png" });

    console.log("== 2. REGISTRAR PESO (P-002, 640 g) ==");
    await abrir("peso");
    await page.waitForFunction(
      () => document.querySelectorAll("#peso-lote option").length > 1, { timeout: 10000 });
    await page.select("#peso-lote", "P-002");
    await page.type("#peso-g", "640");
    await page.type("#peso-n", "8");
    const rPeso = await enviar("f-peso");
    paso("peso guardado", /Listo/i.test(rPeso) && /640/.test(rPeso), rPeso);
    await page.screenshot({ path: OUT + "/02-peso.png" });
    await cerrar();
    await espera(1200);

    console.log("== 3. REGISTRAR MUERTE (P-001, 2 cuyes) ==");
    await abrir("muerte");
    await page.waitForFunction(
      () => document.querySelectorAll("#muerte-lote option").length > 1, { timeout: 10000 });
    await page.select("#muerte-lote", "P-001");
    await page.type("#muerte-cant", "2");
    await page.type("#muerte-causa", "diarrea");
    const rMuerte = await enviar("f-muerte");
    paso("muerte guardada", /Listo/i.test(rMuerte) && /2 muerte/i.test(rMuerte), rMuerte);
    await cerrar();
    await espera(1600);
    const vivos1 = await kpi("kpi-vivos");
    paso("KPI vivos baja en 2", vivos1.num === vivos0.num - 2,
      vivos0.num + " -> " + vivos1.num);

    console.log("== 4. REGISTRAR ALIMENTO (P-002, 10 kg balanceado) ==");
    await abrir("alimento");
    await page.waitForFunction(
      () => document.querySelectorAll("#alim-lote option").length > 1, { timeout: 10000 });
    await page.select("#alim-lote", "P-002");
    await page.select("#alim-tipo", "balanceado");
    await page.type("#alim-kg", "10");
    const rAlim = await enviar("f-alimento");
    paso("alimento guardado", /Listo/i.test(rAlim) && /10 kg/i.test(rAlim), rAlim);
    await cerrar();
    await espera(1200);

    console.log("== 5. REGISTRAR VENTA (P-001, 1 cuy a S/ 30) ==");
    await abrir("venta");
    await page.waitForFunction(
      () => document.querySelectorAll("#venta-lote option").length > 1, { timeout: 10000 });
    await page.select("#venta-lote", "P-001");
    await page.type("#venta-cant", "1");
    await page.type("#venta-precio", "30");
    const rVenta = await enviar("f-venta");
    paso("venta guardada", /Listo/i.test(rVenta) && /vendido/i.test(rVenta), rVenta);
    await cerrar();
    await espera(1800);
    const vivos2 = await kpi("kpi-vivos");
    paso("KPI vivos baja con la venta", vivos2.num === vivos1.num - 1,
      vivos1.num + " -> " + vivos2.num);
    const margen1 = await kpi("kpi-margen");
    paso("modo demo: el margen NO se recalcula (limitacion conocida)",
      margen1.num === margen0.num, margen0.texto + " -> " + margen1.texto);

    console.log("== 6. REGISTRAR PARTO (H003, 4 vivos) ==");
    await abrir("parto");
    await page.type("#parto-hembra", "H003");
    await page.type("#parto-vivos", "4");
    const rParto = await enviar("f-parto");
    paso("parto guardado", /Listo/i.test(rParto) && /4 vivos/i.test(rParto), rParto);
    await cerrar();
    await espera(1600);
    const partos1 = await kpi("kpi-partos");
    paso("KPI partos baja (H003 sale de la lista)", partos1.num === partos0.num - 1,
      partos0.num + " -> " + partos1.num);

    console.log("== 7. LISTA DE REGISTROS ==");
    await page.click('.nav-item[data-tab="registros"]');
    await espera(1600);
    const regs = await texto("#card-registros");
    const filasReg = (await page.$$("#registros .reg-row, #registros tbody tr, #registros > *")).length;
    paso("la lista de registros tiene contenido", filasReg > 0, filasReg + " filas");
    paso("modo demo: la lista es el ejemplo y no incluye lo recien registrado (limitacion conocida)",
      /Pesaje semanal/.test(regs) && !/640 g/.test(regs), regs.slice(0, 80));
    await page.screenshot({ path: OUT + "/03-registros.png" });

    console.log("== 8. AVISOS ==");
    await page.click('.nav-item[data-tab="avisos"]');
    await espera(1400);
    const avisos = await texto("#tab-avisos");
    paso("avisos con contenido", avisos.length > 80, avisos.slice(0, 100));
    paso("muestra partos proximos", /parto|pare/i.test(avisos), "");
    paso("muestra destete", /destet/i.test(avisos), "");
    await page.screenshot({ path: OUT + "/04-avisos.png" });

    console.log("== 9. POZA: CURVA DE PESO ==");
    await page.click('.nav-item[data-tab="lote"]');
    await espera(900);
    await page.waitForFunction(
      () => document.querySelectorAll("#sel-lote option").length > 1, { timeout: 10000 });
    await page.select("#sel-lote", "P-001");
    await espera(2200);
    const curva = await page.evaluate(() => {
      const c = document.getElementById("grafica-peso");
      if (!c || c.classList.contains("oculto")) { return { visible: false }; }
      return { visible: true, w: c.width, h: c.height };
    });
    paso("curva de peso visible en P-001", curva.visible, JSON.stringify(curva));
    const ficha = await texto("#tab-lote");
    paso("ficha muestra mortalidad y edad", /mort|d[ií]as/i.test(ficha), "");
    await page.screenshot({ path: OUT + "/05-poza.png" });

    console.log("== 10. ASISTENTE (modo demo) ==");
    await page.click("#ia-fab");
    await espera(1200);
    const chat = await texto("#chat-msgs");
    paso("el panel del asistente abre", chat.length > 20, chat.slice(0, 90));
    paso("en demo avisa que esta desactivado", /desactivado/i.test(chat), "");
    await page.screenshot({ path: OUT + "/06-asistente.png" });
    await page.click("#ia-cerrar");
    await page.waitForFunction(() => document.getElementById("ia-panel").hidden, { timeout: 6000 });
    await espera(500);
    paso("el panel del asistente se cierra", true, "oculto");

    console.log("== 11. BUSCADOR Y CUENTA ==");
    await page.click("#buscador");
    await page.type("#buscador", "P-003");
    await page.keyboard.press("Enter");
    await espera(1800);
    const trasBuscar = await page.evaluate(() => document.getElementById("crumb-actual").textContent);
    paso("el buscador lleva a la poza", /Poza/i.test(trasBuscar), trasBuscar);
    /* En escritorio «Cuenta» está oculto (cuymax-theme.css: .nav-item-cuenta
       display:none) y Ajustes se abre con el botón de la barra superior. */
    const cuentaVisible = await page.evaluate(() => {
      const c = document.getElementById("nav-cuenta");
      return !!c && c.getBoundingClientRect().width > 0;
    });
    await page.click(cuentaVisible ? "#nav-cuenta" : "#btn-ajustes");
    await espera(900);
    const ajustesVisible = await page.evaluate(() => {
      const a = document.getElementById("ajustes");
      return !!a && !a.classList.contains("oculto");
    });
    paso("Ajustes abre en escritorio", ajustesVisible, cuentaVisible ? "via Cuenta" : "via boton Ajustes");
    await page.screenshot({ path: OUT + "/07-cuenta.png" });
    await page.click("#btn-cerrar-ajustes");
    await espera(500);

    console.log("== 12. MOVIL: registro rapido ==");
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    await page.goto(BASE + "/app/?modo=demo", { waitUntil: "networkidle2" });
    await page.waitForSelector("#fab-registro", { timeout: 15000 });
    await espera(1500);
    const fab = await page.$eval("#fab-registro", (el) => {
      const r = el.getBoundingClientRect();
      return { visible: r.width > 0, w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom) };
    });
    paso("boton flotante visible en movil", fab.visible && fab.h === 56, JSON.stringify(fab));
    await page.tap("#fab-registro");
    await page.waitForSelector("#dlg-registrar[open]", { timeout: 8000 });
    await espera(900);
    const dlg = await page.evaluate(() => {
      const d = document.getElementById("dlg-registrar");
      const r = d.getBoundingClientRect();
      return { alto: Math.round(r.height), ancho: Math.round(r.width), altoVentana: window.innerHeight };
    });
    paso("el dialogo cabe en la pantalla", dlg.alto <= dlg.altoVentana, JSON.stringify(dlg));
    await page.screenshot({ path: OUT + "/08-movil-registro.png" });
    await page.tap('button.dlg-accion[data-accion="peso"]');
    await espera(800);
    const formMovil = await page.evaluate(() => {
      const f = document.getElementById("f-peso");
      const b = f.querySelector('button[type="submit"]');
      const r = b.getBoundingClientRect();
      return { botonVisible: r.top > 0 && r.bottom <= window.innerHeight, y: Math.round(r.top) };
    });
    paso("el boton Guardar es alcanzable en movil", formMovil.botonVisible, JSON.stringify(formMovil));
    await page.screenshot({ path: OUT + "/09-movil-form.png" });
    await page.tap("#dlg-cerrar");
    await espera(600);
    const cuentaMovil = await page.evaluate(() => {
      const c = document.getElementById("nav-cuenta");
      return !!c && c.getBoundingClientRect().width > 0;
    });
    paso("en movil aparece el boton Cuenta", cuentaMovil, "");
    await page.tap("#nav-cuenta");
    await espera(900);
    const ajustesMovil = await page.evaluate(() => {
      const a = document.getElementById("ajustes");
      const r = a.getBoundingClientRect();
      return { visible: !a.classList.contains("oculto"), ancho: Math.round(r.width) };
    });
    paso("Cuenta abre Ajustes en movil", ajustesMovil.visible, JSON.stringify(ajustesMovil));
    await page.screenshot({ path: OUT + "/10-movil-cuenta.png" });
  } catch (e) {
    paso("EXCEPCION EN LA PRUEBA", false, e.message);
  }

  console.log("== ERRORES DE CONSOLA ==");
  if (!errores.length) { console.log("  ninguno"); }
  errores.slice(0, 10).forEach((e) => console.log("  " + e));

  const malos = resultados.filter((r) => !r.bien).length;
  console.log("\n== RESUMEN ==");
  console.log("  pruebas: " + resultados.length + " | fallos: " + malos +
    " | errores de consola: " + errores.length);

  await browser.close();
  process.exit(malos || errores.length ? 1 : 0);
})();
