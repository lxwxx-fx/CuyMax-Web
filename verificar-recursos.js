const puppeteer = require("puppeteer-core");
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const BASE = "https://cuymax-by-dc.web.app/";

(async () => {
  const browser = await puppeteer.launch({ executablePath: EDGE, headless: "new", args: ["--no-sandbox"] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });

  async function revisar(url, etiqueta) {
    const fallos = [];
    page.on("response", (r) => {
      if (r.status() >= 400) fallos.push(r.status() + " " + r.url().replace(BASE, ""));
    });
    await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
    await new Promise((r) => setTimeout(r, 2000));
    // forzar carga de imagenes con lazy
    await page.evaluate(async () => {
      document.querySelectorAll("img[loading=lazy]").forEach((i) => (i.loading = "eager"));
      window.scrollTo(0, document.body.scrollHeight);
      await new Promise((r) => setTimeout(r, 1200));
      window.scrollTo(0, 0);
    });
    await new Promise((r) => setTimeout(r, 1500));
    const rotas = await page.evaluate(() =>
      Array.from(document.images)
        .filter((i) => i.complete && i.naturalWidth === 0)
        .map((i) => i.currentSrc || i.src)
    );
    const total = await page.evaluate(() => document.images.length);
    console.log("== " + etiqueta + " ==");
    console.log("  imagenes:", total, "| rotas:", rotas.length, rotas.slice(0, 6).map((u) => u.replace(location.origin, "")));
    console.log("  respuestas >=400:", fallos.length);
    [...new Set(fallos)].slice(0, 12).forEach((f) => console.log("    " + f));
    page.removeAllListeners("response");
  }

  await revisar(BASE, "PORTADA");
  await revisar(BASE + "app/?modo=demo", "APP (demo)");
  await revisar(BASE + "login.html", "LOGIN");

  await browser.close();
})();
