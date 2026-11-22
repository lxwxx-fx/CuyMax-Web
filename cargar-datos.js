/* Carga datos de presentación en la granja real del autor.
 *
 * Usa las funciones del propio panel (api() → apiReal() → fsRegistrar...), así
 * que cada escritura pasa por las mismas validaciones que la interfaz. La única
 * excepción son los pesajes históricos: fsRegistrarPeso() siempre guarda con la
 * fecha de hoy, y la curva de peso necesita fechas distintas para dibujarse.
 *
 * No imprime ni guarda la contraseña ni el token: todo ocurre dentro de la página.
 */
const puppeteer = require("puppeteer-core");
const fs = require("fs");
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const BASE = "https://cuymax-by-dc.web.app";
const PERFIL = "C:/Users/Admin/AppData/Local/Temp/cuymax-perfil-carga";
const OUT = "C:/Users/Admin/AppData/Local/Temp/vr";
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const LIMITE_MS = 8 * 60 * 1000;

const PRECIOS = { balanceado_kg: 2.5, forraje_kg: 3.5, cuy: 25 };
const NOMBRE = "Granja Mochumi";

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: EDGE, headless: false, userDataDir: PERFIL,
    args: ["--no-sandbox", "--start-maximized"], defaultViewport: null
  });
  const pages = await browser.pages();
  const page = pages[0] || (await browser.newPage());
  const errores = [];
  page.on("pageerror", (e) => errores.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errores.push("console: " + m.text().slice(0, 140)); });

  try {
    await page.goto(BASE + "/login.html?next=%2Fapp%2F%3Fmodo%3Dreal",
      { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.evaluate(() => {
      const d = document.createElement("div");
      d.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:99999;background:#0E9F6E;" +
        "color:#fff;font:600 15px system-ui;padding:14px 20px;text-align:center";
      d.textContent = "Carga de datos de CuyMax · inicia sesión. La ventana se cerrará sola al terminar.";
      document.body.appendChild(d);
    });

    console.log("ESPERANDO INICIO DE SESION (hasta 8 min)...");
    const t0 = Date.now();
    while (Date.now() - t0 < LIMITE_MS) {
      let u = "";
      try { u = page.url(); } catch (e) { u = ""; }
      if (u.indexOf("/app/") >= 0) { break; }
      await espera(1500);
    }
    if (page.url().indexOf("/app/") < 0) {
      console.log("  FALLA | no se inicio sesion");
      await browser.close();
      process.exit(1);
    }
    console.log("  sesion iniciada");

    await page.waitForSelector("#kpi-vivos", { timeout: 30000 });
    await espera(4000);

    /* ---------- carga ---------- */
    const registro = await page.evaluate(async (P) => {
      const log = [];
      const push = (t) => log.push(t);
      const fechaHace = (dias) => new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Lima", year: "numeric", month: "2-digit", day: "2-digit"
      }).format(new Date(Date.now() - dias * 86400000));
      const fechaEn = (dias) => new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Lima", year: "numeric", month: "2-digit", day: "2-digit"
      }).format(new Date(Date.now() + dias * 86400000));

      try {
        /* 1. Nombre y precios */
        const g = await api("POST", "granja", { nombre: P.nombre, precios: P.precios });
        push("granja: " + g.resumen + " · " + g.detalle);

        /* 2. Pozas existentes */
        const lotes = await api("GET", "lotes");
        push("pozas encontradas: " + lotes.length + " -> " +
          lotes.map((l) => l.codigo + " (" + l.vivos + ")").join(", "));

        const db = firebase.firestore();
        const uid = fsGranja();
        const hoyISO = new Date().toISOString();

        /* 3. Pesajes históricos (4 por poza, fechas repartidas) */
        const curva = [[28, 380], [21, 470], [14, 560], [7, 650]];
        for (const l of lotes) {
          const previos = await db.collection("pesajes")
            .where("granja_id", "==", uid).where("lote", "==", l.codigo).get();
          if (!previos.empty) {
            push("pesajes de " + l.codigo + ": ya tenia " + previos.size + ", se omite");
            continue;
          }
          for (const [dias, peso] of curva) {
            await db.collection("pesajes").add({
              granja_id: uid, lote: l.codigo, fecha: fechaHace(dias),
              peso_promedio_g: peso, animales_pesados: 8, creado_en: hoyISO
            });
          }
          await db.collection("lotes").doc("g" + uid + "_" + l.codigo)
            .update({ ultimo_peso_g: curva[curva.length - 1][1] });
          push("pesajes de " + l.codigo + ": 4 registros (380 a 650 g)");
        }

        /* 4. Alimento de hoy */
        for (const l of lotes) {
          await api("POST", "alimento", { lote: l.codigo, tipo: "balanceado", kg: 12 });
          await api("POST", "alimento", { lote: l.codigo, tipo: "forraje", kg: 25 });
          push("alimento de " + l.codigo + ": 12 kg balanceado + 25 kg forraje");
        }

        /* 5. Partos programados */
        const partos = [["H-001", 3], ["H-002", 7]];
        for (const [hembra, dias] of partos) {
          try {
            const r = await api("POST", "partos-proximos", {
              hembra: hembra, poza: "", fecha_objetivo: fechaEn(dias)
            });
            push("parto " + hembra + ": " + r.resumen + " (" + r.detalle + ")");
          } catch (e) {
            push("parto " + hembra + ": " + e.message);
          }
        }

        /* 6. Una venta, para que el margen tenga ingresos */
        if (lotes.length) {
          const cod = lotes[0].codigo;
          try {
            const v = await api("POST", "ventas", { lote: cod, cantidad: 4, precio_unitario: P.precios.cuy });
            push("venta: " + v.resumen + " · " + v.detalle);
          } catch (e) {
            push("venta: " + e.message);
          }
        }
      } catch (e) {
        push("ERROR: " + e.message);
      }
      return log;
    }, { nombre: NOMBRE, precios: PRECIOS });

    console.log("== CARGA ==");
    registro.forEach((l) => console.log("  · " + l));

    /* ---------- verificación ---------- */
    await page.reload({ waitUntil: "networkidle2" });
    await page.waitForSelector("#kpi-vivos", { timeout: 30000 });
    await espera(5000);

    const v = await page.evaluate(() => {
      const t = (id) => { const e = document.getElementById(id); return e ? e.textContent.trim() : ""; };
      const c = document.getElementById("grafica-panel");
      return {
        granja: t("granja-nombre"),
        vivos: t("kpi-vivos"), partos: t("kpi-partos"),
        margen: t("kpi-margen"), retiro: t("kpi-retiro"),
        filasEco: document.querySelectorAll("#economico tbody tr").length,
        filasLotes: document.querySelectorAll("#lotes tbody tr").length,
        grafica: !!(c && c.width > 0)
      };
    });
    console.log("== DESPUES ==");
    console.log("  granja: " + v.granja);
    console.log("  vivos=" + v.vivos + " partos=" + v.partos + " margen=" + v.margen + " retiro=" + v.retiro);
    console.log("  filas economicas: " + v.filasEco + " | filas pozas: " + v.filasLotes + " | grafica: " + v.grafica);
    await page.screenshot({ path: OUT + "/30-datos-panel.png" });

    await page.click('.nav-item[data-tab="lote"]');
    await espera(1200);
    const opciones = await page.evaluate(
      () => Array.from(document.querySelectorAll("#sel-lote option")).slice(1, 3).map((o) => o.value));
    if (opciones.length) {
      await page.select("#sel-lote", opciones[0]);
      await espera(3000);
      const curvaOk = await page.evaluate(() => {
        const c = document.getElementById("grafica-peso");
        return !!c && !c.classList.contains("oculto");
      });
      console.log("  curva de peso en " + opciones[0] + ": " + curvaOk);
      await page.screenshot({ path: OUT + "/31-datos-curva.png" });
    }

    await page.click('.nav-item[data-tab="avisos"]');
    await espera(2500);
    const avisos = await page.evaluate(
      () => document.getElementById("tab-avisos").textContent.replace(/\s+/g, " ").slice(0, 260));
    console.log("  avisos: " + avisos);
    await page.screenshot({ path: OUT + "/32-datos-avisos.png" });
  } catch (e) {
    console.log("EXCEPCION: " + e.message);
  }

  console.log("errores de consola: " + (errores.length ? errores.slice(0, 5).join(" | ") : "ninguno"));
  await browser.close();
  try { fs.rmSync(PERFIL, { recursive: true, force: true }); } catch (e) { /* en uso */ }
})();
