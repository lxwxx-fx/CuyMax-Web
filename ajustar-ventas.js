/* Deja el margen de cada poza en positivo para la presentacion.
 *
 * El costo de una poza es solo alimento (firestore-data.js:1233). Con 12 kg de
 * balanceado + 25 kg de forraje por poza el costo es S/ 117.50, y una venta de
 * 4 cuyes solo cubre S/ 100. Este script completa cada poza hasta 6 cuyes
 * vendidos usando el propio api("POST","ventas"), asi que respeta la validacion
 * de stock y actualiza vendidos/vivos igual que la interfaz.
 *
 * Es idempotente: lee las ventas que ya existen y solo vende la diferencia.
 */
const puppeteer = require("puppeteer-core");
const fs = require("fs");
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const BASE = "https://cuymax-by-dc.web.app";
const PERFIL = "C:/Users/Admin/AppData/Local/Temp/cuymax-perfil-carga";
const OUT = "C:/Users/Admin/AppData/Local/Temp/vr";
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const LIMITE_MS = 8 * 60 * 1000;

const OBJETIVO_POR_POZA = 6;
const PRECIO_CUY = 25;

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
      d.textContent = "Ajuste de ventas de CuyMax · inicia sesión. La ventana se cerrará sola.";
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

    /* ---------- ajuste ---------- */
    const log = await page.evaluate(async (CFG) => {
      const out = [];
      const push = (t) => out.push(t);
      try {
        const lotes = await api("GET", "lotes");
        const db = firebase.firestore();
        const uid = fsGranja();
        const snap = await db.collection("ventas").where("granja_id", "==", uid).get();
        const vendidos = {};
        snap.forEach((d) => {
          const v = d.data();
          const k = String(v.lote || "").toUpperCase();
          vendidos[k] = (vendidos[k] || 0) + (Number(v.cantidad) || 0);
        });

        for (const l of lotes) {
          const ya = vendidos[String(l.codigo).toUpperCase()] || 0;
          const falta = CFG.objetivo - ya;
          if (falta <= 0) { push(l.codigo + ": ya tiene " + ya + " vendidos, se omite"); continue; }
          if (falta > l.vivos) { push(l.codigo + ": stock insuficiente (" + l.vivos + " vivos), se omite"); continue; }
          try {
            const r = await api("POST", "ventas", {
              lote: l.codigo, cantidad: falta, precio_unitario: CFG.precio
            });
            push(l.codigo + ": +" + falta + " vendidos -> " + r.detalle);
          } catch (e) {
            push(l.codigo + ": " + e.message);
          }
        }
      } catch (e) {
        push("ERROR: " + e.message);
      }
      return out;
    }, { objetivo: OBJETIVO_POR_POZA, precio: PRECIO_CUY });

    console.log("== AJUSTE ==");
    log.forEach((l) => console.log("  · " + l));

    /* ---------- verificacion ---------- */
    await page.reload({ waitUntil: "networkidle2" });
    await page.waitForSelector("#kpi-vivos", { timeout: 30000 });
    await espera(5000);

    const v = await page.evaluate(() => {
      const t = (id) => { const e = document.getElementById(id); return e ? e.textContent.trim() : ""; };
      const filas = Array.from(document.querySelectorAll("#economico tbody tr")).map((tr) =>
        Array.from(tr.children).map((td) => td.textContent.replace(/\s+/g, " ").trim()));
      const negativas = document.querySelectorAll("#economico td.neg").length;
      return {
        vivos: t("kpi-vivos"), partos: t("kpi-partos"),
        margen: t("kpi-margen"), retiro: t("kpi-retiro"),
        filas: filas, negativas: negativas
      };
    });

    console.log("== DESPUES ==");
    console.log("  vivos=" + v.vivos + " partos=" + v.partos + " margen=" + v.margen + " retiro=" + v.retiro);
    v.filas.forEach((f) => console.log("  eco | " + f.join(" | ")));
    console.log("  celdas de margen en negativo: " + v.negativas);

    await page.screenshot({ path: OUT + "/33-margen-positivo.png" });
  } catch (e) {
    console.log("EXCEPCION: " + e.message);
  }

  console.log("errores de consola: " + (errores.length ? errores.slice(0, 5).join(" | ") : "ninguno"));
  await browser.close();
  try { fs.rmSync(PERFIL, { recursive: true, force: true }); } catch (e) { /* en uso */ }
})();
