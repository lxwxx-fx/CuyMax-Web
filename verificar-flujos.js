const puppeteer = require("puppeteer-core");
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const BASE = "https://cuymax-by-dc.web.app/";
const errores = [];
function enganchar(page, etiqueta) {
  page.on("pageerror", (e) => errores.push(etiqueta + " | pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errores.push(etiqueta + " | " + m.text().slice(0, 140)); });
}

(async () => {
  const browser = await puppeteer.launch({ executablePath: EDGE, headless: "new", args: ["--no-sandbox"] });

  /* 1. Aviso de instalacion */
  const p1 = await browser.newPage();
  enganchar(p1, "instalar");
  await p1.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await p1.setUserAgent("Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36");
  await p1.goto(BASE + "app/?modo=demo&instalar=1", { waitUntil: "networkidle2", timeout: 60000 });
  await new Promise((r) => setTimeout(r, 2500));
  const aviso = await p1.evaluate(() => {
    const a = document.getElementById("instalar-aviso");
    if (!a) return { existe: false };
    const r = a.getBoundingClientRect();
    const cs = getComputedStyle(a);
    return {
      existe: true, visible: cs.display !== "none" && r.height > 0,
      top: Math.round(r.top), alto: Math.round(r.height),
      titulo: (document.getElementById("instalar-titulo") || {}).textContent || "",
      detalle: (document.getElementById("instalar-detalle") || {}).textContent || ""
    };
  });
  console.log("== 1. AVISO DE INSTALACION ==");
  console.log("  ", JSON.stringify(aviso));
  await p1.screenshot({ path: "C:/Users/Admin/AppData/Local/Temp/vs-instalar.png" });

  /* 2. Modo real sin sesion */
  const p2 = await browser.newPage();
  enganchar(p2, "real-sin-sesion");
  await p2.setViewport({ width: 1440, height: 900 });
  await p2.goto(BASE + "app/?modo=real", { waitUntil: "networkidle2", timeout: 60000 });
  await new Promise((r) => setTimeout(r, 2500));
  const real = await p2.evaluate(() => ({
    url: location.href,
    titulo: document.title,
    texto: document.body.innerText.replace(/\s+/g, " ").slice(0, 160),
    campos: document.querySelectorAll("input").length
  }));
  console.log("\n== 2. MODO REAL SIN SESION ==");
  console.log("  url:", real.url);
  console.log("  titulo:", real.titulo, "| inputs:", real.campos);
  console.log("  texto:", real.texto);

  /* 3. Login */
  const p3 = await browser.newPage();
  enganchar(p3, "login");
  await p3.setViewport({ width: 1440, height: 900 });
  const r3 = await p3.goto(BASE + "login.html?next=%2Fapp%2F%3Fmodo%3Dreal", { waitUntil: "networkidle2", timeout: 60000 });
  await new Promise((r) => setTimeout(r, 1500));
  const login = await p3.evaluate(() => ({
    titulo: document.title,
    correo: !!document.querySelector('input[type="email"], input[name="email"]'),
    clave: !!document.querySelector('input[type="password"]'),
    botones: Array.from(document.querySelectorAll("button")).map((b) => b.textContent.trim().slice(0, 26)).filter(Boolean)
  }));
  console.log("\n== 3. LOGIN ==");
  console.log("  HTTP:", r3.status(), "| titulo:", login.titulo);
  console.log("  campo correo:", login.correo, "| campo clave:", login.clave);
  console.log("  botones:", login.botones.join(" | "));
  await p3.screenshot({ path: "C:/Users/Admin/AppData/Local/Temp/vs-login.png" });

  /* 4. Sin internet (service worker) */
  const p4 = await browser.newPage();
  enganchar(p4, "offline");
  await p4.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await p4.goto(BASE + "app/?modo=demo", { waitUntil: "networkidle2", timeout: 60000 });
  await new Promise((r) => setTimeout(r, 4000));
  const cache = await p4.evaluate(async () => {
    const nombres = await caches.keys();
    let archivos = 0;
    for (const n of nombres) {
      const c = await caches.open(n);
      archivos += (await c.keys()).length;
    }
    return { nombres, archivos, controlado: !!navigator.serviceWorker.controller };
  });
  await p4.setOfflineMode(true);
  let offline = {};
  try {
    await p4.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
    await new Promise((r) => setTimeout(r, 2500));
    offline = await p4.evaluate(() => ({
      titulo: document.title,
      navs: document.querySelectorAll(".nav-item").length,
      texto: document.body.innerText.replace(/\s+/g, " ").slice(0, 90),
      alto: document.body.scrollHeight
    }));
  } catch (e) {
    offline = { error: e.message.slice(0, 90) };
  }
  console.log("\n== 4. SIN INTERNET ==");
  console.log("  cache:", cache.nombres.join(", "), "| archivos:", cache.archivos, "| controlado por SW:", cache.controlado);
  console.log("  recarga offline:", JSON.stringify(offline));
  await p4.screenshot({ path: "C:/Users/Admin/AppData/Local/Temp/vs-offline.png" });

  console.log("\n== ERRORES ==");
  if (!errores.length) console.log("  ninguno");
  else errores.slice(0, 10).forEach((e) => console.log("  " + e));

  await browser.close();
})();
