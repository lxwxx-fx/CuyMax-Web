const puppeteer = require("puppeteer-core");
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const BASE = "https://cuymax-by-dc.web.app/";

const errores = [];
function enganchar(page, etiqueta) {
  page.on("pageerror", (e) => errores.push(etiqueta + " | pageerror: " + e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errores.push(etiqueta + " | console: " + m.text().slice(0, 160));
  });
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: EDGE, headless: "new", args: ["--no-sandbox"]
  });

  /* ---------- 1. PORTADA ---------- */
  const p1 = await browser.newPage();
  enganchar(p1, "portada");
  await p1.setViewport({ width: 1440, height: 900 });
  const r1 = await p1.goto(BASE, { waitUntil: "networkidle2", timeout: 60000 });
  const portada = await p1.evaluate(() => {
    const desc = document.getElementById("descarga");
    const tarjetas = desc ? desc.querySelectorAll("article, .descarga-card, .card").length : 0;
    const enlaces = Array.from(document.querySelectorAll('a[href*="app/"]')).map((a) => a.getAttribute("href"));
    return {
      titulo: document.title,
      estadoDescarga: !!desc,
      tarjetas,
      enlaces: [...new Set(enlaces)],
      imagenesRotas: Array.from(document.images).filter((i) => i.complete && i.naturalWidth === 0).length
    };
  });
  console.log("== 1. PORTADA ==");
  console.log("  HTTP:", r1.status(), "| titulo:", portada.titulo);
  console.log("  seccion descarga:", portada.estadoDescarga, "| tarjetas:", portada.tarjetas);
  console.log("  enlaces al panel:", portada.enlaces.join(" , "));
  console.log("  imagenes rotas:", portada.imagenesRotas);
  await p1.screenshot({ path: "C:/Users/Admin/AppData/Local/Temp/vs-portada.png" });

  /* ---------- 2. APP ESCRITORIO ---------- */
  const p2 = await browser.newPage();
  enganchar(p2, "app-escritorio");
  await p2.setViewport({ width: 1440, height: 900 });
  const r2 = await p2.goto(BASE + "app/?modo=demo", { waitUntil: "networkidle2", timeout: 60000 });
  await new Promise((r) => setTimeout(r, 3000));

  const navs = await p2.$$eval(".nav-item", (els) =>
    els.map((e) => ({ tab: e.dataset.tab || "(cuenta)", texto: e.textContent.trim().slice(0, 18) }))
  );
  console.log("\n== 2. APP ESCRITORIO (demo) ==");
  console.log("  HTTP:", r2.status(), "| titulo:", await p2.title());
  console.log("  botones de navegacion:", navs.length, "->", navs.map((n) => n.tab).join(", "));

  const secciones = ["panel", "lote", "guano", "registrar", "avisos", "registros"];
  for (const s of secciones) {
    await p2.evaluate((t) => {
      const b = document.querySelector('.nav-item[data-tab="' + t + '"]');
      if (b) b.click();
    }, s);
    await new Promise((r) => setTimeout(r, 700));
    const st = await p2.evaluate((t) => {
      const el = document.getElementById("tab-" + t);
      if (!el) return { existe: false };
      return {
        existe: true,
        activa: el.classList.contains("active"),
        alto: el.offsetHeight,
        titulo: document.title,
        migas: (document.getElementById("crumb-actual") || {}).textContent || ""
      };
    }, s);
    console.log(
      "  " + s.padEnd(10) +
      " visible:" + (st.alto > 50 ? "SI" : "NO") +
      " activa:" + (st.activa ? "SI" : "NO") +
      " alto:" + st.alto + "px | " + st.migas
    );
  }
  await p2.screenshot({ path: "C:/Users/Admin/AppData/Local/Temp/vs-app-escritorio.png" });

  /* ---------- 3. APP MOVIL ---------- */
  const p3 = await browser.newPage();
  enganchar(p3, "app-movil");
  await p3.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await p3.setUserAgent("Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36");
  await p3.goto(BASE + "app/?modo=demo", { waitUntil: "networkidle2", timeout: 60000 });
  await new Promise((r) => setTimeout(r, 3000));

  const movil = await p3.evaluate(() => {
    const cajas = Array.from(document.querySelectorAll(".nav-item")).map((e) => {
      const r = e.getBoundingClientRect();
      return { tab: e.dataset.tab || "cuenta", x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    });
    const filas = [...new Set(cajas.map((c) => c.y))].sort((a, b) => a - b);
    const columnas = [...new Set(cajas.map((c) => c.x))].sort((a, b) => a - b);
    const fab = document.getElementById("fab-registro");
    const rf = fab ? fab.getBoundingClientRect() : null;
    const iaFab = document.getElementById("ia-fab");
    const ri = iaFab ? iaFab.getBoundingClientRect() : null;
    return {
      nav: cajas,
      filas: filas.length,
      columnas: columnas.length,
      fabVisible: rf ? rf.width > 0 && rf.height > 0 && rf.bottom <= window.innerHeight + 2 : false,
      fabCaja: rf ? { w: Math.round(rf.width), h: Math.round(rf.height), bottom: Math.round(rf.bottom) } : null,
      iaFabVisible: ri ? ri.width > 0 && ri.height > 0 : false,
      desbordeHorizontal: document.documentElement.scrollWidth - window.innerWidth,
      anchoNav: Math.max(...cajas.map((c) => c.x + c.w)) 
    };
  });
  console.log("\n== 3. APP MOVIL (390x844) ==");
  console.log("  navegacion:", movil.nav.length, "botones |", movil.columnas, "columnas x", movil.filas, "filas");
  movil.nav.forEach((c) => console.log("    " + c.tab.padEnd(10) + " x:" + c.x + " y:" + c.y + " " + c.w + "x" + c.h));
  console.log("  boton flotante registro:", movil.fabVisible ? "visible" : "NO VISIBLE", JSON.stringify(movil.fabCaja));
  console.log("  boton asistente:", movil.iaFabVisible ? "visible" : "NO VISIBLE");
  console.log("  desborde horizontal:", movil.desbordeHorizontal + "px");
  await p3.screenshot({ path: "C:/Users/Admin/AppData/Local/Temp/vs-app-movil.png" });

  /* asistente en movil: abrir y medir */
  const abierto = await p3.evaluate(() => {
    const b = document.getElementById("ia-fab");
    if (!b) return false;
    b.click();
    return true;
  });
  await new Promise((r) => setTimeout(r, 1200));
  const panelIA = await p3.evaluate(() => {
    const p = document.getElementById("ia-panel");
    if (!p) return null;
    const r = p.getBoundingClientRect();
    const campo = document.querySelector("#ia-panel textarea, #ia-panel input[type=text]");
    const rc = campo ? campo.getBoundingClientRect() : null;
    return {
      visible: r.height > 0,
      top: Math.round(r.top), bottom: Math.round(r.bottom), alto: Math.round(r.height),
      altoVentana: window.innerHeight,
      campoVisible: rc ? rc.bottom <= window.innerHeight + 2 : null
    };
  });
  console.log("  panel del asistente:", JSON.stringify(panelIA));
  await p3.screenshot({ path: "C:/Users/Admin/AppData/Local/Temp/vs-app-asistente.png" });

  /* ---------- 4. ERRORES ---------- */
  console.log("\n== 4. ERRORES DE CONSOLA ==");
  if (!errores.length) console.log("  ninguno");
  else errores.slice(0, 12).forEach((e) => console.log("  " + e));

  await browser.close();
})();
