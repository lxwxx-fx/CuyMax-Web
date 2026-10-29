/* CuyMax — datos de ejemplo para modo demo (presentaciones sin servidor).
   MODO_DEMO se activa solo en la página publicada (web.app / firebaseapp.com)
   y queda apagado en local (localhost usa la API central /api/...).
   Las fechas se calculan desde hoy para que la demo nunca se vea vencida. */
/* Modo monitoreo: el botón "Monitorear" abre el panel con ?modo=real y ahí
   se trabaja con datos reales de Firestore en vez de los de ejemplo. */
var MODO_REAL = /(?:^|[?&])modo=real(?:&|$)/.test(location.search);
var MODO_DEMO = !MODO_REAL && (
  /(?:^|[?&])modo=demo(?:&|$)/.test(location.search) ||
  /\.(web\.app|firebaseapp\.com|e2b\.app)$/i.test(location.hostname)
);

function demoHaceDias(n) {
  var d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

function demoEnDias(n) {
  var d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

function demoCurva(pesos, diasAtras, muestra) {
  return pesos.map(function (p, i) {
    return { fecha: demoHaceDias(diasAtras[i]), peso_promedio_g: p, animales_pesados: muestra || 10 };
  });
}

var MOCK = {
  lotes: [
    { codigo: "P-001", nombre: "Engorde A", etapa: "engorde", estado: "abierto",
      cantidad_inicial: 30, vivos: 17, muertos: 6, vendidos: 5, faenados: 2,
      alimento_kg: 68.7, ultimo_peso_g: 730, mortalidad_pct: 20.0,
      edad_dias: 52, peso_objetivo_g: 900 },
    { codigo: "P-002", nombre: "Engorde B", etapa: "engorde", estado: "abierto",
      cantidad_inicial: 25, vivos: 25, muertos: 0, vendidos: 0, faenados: 0,
      alimento_kg: 31.4, ultimo_peso_g: 510, mortalidad_pct: 0.0,
      edad_dias: 26, peso_objetivo_g: 900 },
    { codigo: "P-003", nombre: "Recría A", etapa: "recria", estado: "abierto",
      cantidad_inicial: 20, vivos: 20, muertos: 0, vendidos: 0, faenados: 0,
      alimento_kg: 12.8, ultimo_peso_g: 320, mortalidad_pct: 0.0,
      edad_dias: 12, peso_objetivo_g: 600 },
    { codigo: "P-004", nombre: "Engorde cerrado", etapa: "engorde", estado: "cerrado",
      cantidad_inicial: 40, vivos: 0, muertos: 5, vendidos: 35, faenados: 0,
      alimento_kg: 210.5, ultimo_peso_g: 950, mortalidad_pct: 12.5,
      edad_dias: 75, peso_objetivo_g: 900 }
  ],

  pesos: {
    "P-001": demoCurva([300, 380, 460, 540, 610, 660, 700, 730], [49, 42, 35, 28, 21, 14, 7, 0]),
    "P-002": demoCurva([320, 400, 470, 510], [21, 14, 7, 0], 8),
    "P-003": demoCurva([180, 250, 320], [14, 7, 0], 8),
    "P-004": demoCurva([300, 420, 540, 650, 740, 820, 880, 920, 945, 950], [63, 56, 49, 42, 35, 28, 21, 14, 7, 1])
  },

  partos: [
    { hembra: "H003", poza: "U-01", dias_restantes: 1, fecha: demoEnDias(1) },
    { hembra: "H001", poza: "U-01", dias_restantes: 6, fecha: demoEnDias(6) },
    { hembra: "H005", poza: "U-02", dias_restantes: 9, fecha: demoEnDias(9) }
  ],

  economico: [
    { codigo: "P-001", estado: "abierto", cantidad_vendida: 5, ingresos: 120.00,
      costo_alimento: 47.46, kg_sin_precio: 0, otros_gastos: 25.00,
      costo_total: 72.46, costo_por_cuy_logrado: 3.02, margen: 47.54 },
    { codigo: "P-002", estado: "abierto", cantidad_vendida: 0, ingresos: 0,
      costo_alimento: 18.20, kg_sin_precio: 0, otros_gastos: 6.00,
      costo_total: 24.20, costo_por_cuy_logrado: 0.97, margen: -24.20 },
    { codigo: "P-003", estado: "abierto", cantidad_vendida: 0, ingresos: 0,
      costo_alimento: 7.90, kg_sin_precio: 0, otros_gastos: 0,
      costo_total: 7.90, costo_por_cuy_logrado: 0.40, margen: -7.90 },
    { codigo: "P-004", estado: "cerrado", cantidad_vendida: 35, ingresos: 1450.00,
      costo_alimento: 812.60, kg_sin_precio: 0, otros_gastos: 96.00,
      costo_total: 908.60, costo_por_cuy_logrado: 25.96, margen: 541.40 }
  ],

  retiros: [
    { lote: "P-001", poza: null, producto: "Enrofloxacina 10%", tipo: "tratamiento",
      dias_restantes: 4, fecha_fin_retiro: demoEnDias(4) },
    { lote: "P-002", poza: null, producto: "Oxitetraciclina", tipo: "tratamiento",
      dias_restantes: 9, fecha_fin_retiro: demoEnDias(9) }
  ],

  pozas: [
    { id: 1, codigo: "U-01", tipo: "reproduccion", capacidad: 11 },
    { id: 2, codigo: "U-02", tipo: "reproduccion", capacidad: 11 },
    { id: 3, codigo: "U-10", tipo: "engorde", capacidad: 40 }
  ],

  avisos: [
    { id: 1, tipo: "parto_proximo", hembra: "H003", poza: "U-01", fecha_objetivo: demoEnDias(1), fecha_aviso: demoHaceDias(0),
      mensaje: "La hembra H003 (ubicación U-01) pare mañana. Prepara la ubicación.", enviada: false, estado: "pendiente" },
    { id: 2, tipo: "destete", fecha_aviso: demoHaceDias(0),
      mensaje: "Las crías del parto PAR-008 cumplen 16 días: toca destetar (ventana de 15 a 21 días).", enviada: false, estado: "pendiente" },
    { id: 3, tipo: "pesaje_pendiente", fecha_aviso: demoHaceDias(0),
      mensaje: "La poza P-002 lleva 9 días sin pesaje.", enviada: false, estado: "pendiente" },
    { id: 4, tipo: "parto_proximo", hembra: "H001", poza: "U-01", fecha_objetivo: demoEnDias(6), fecha_aviso: demoHaceDias(0),
      mensaje: "La hembra H001 (ubicación U-01) pare en 6 días. Prepara la ubicación.", enviada: false, estado: "pendiente" },
    { id: 5, tipo: "otra", fecha_aviso: demoHaceDias(0),
      mensaje: "La poza P-001 sale de retiro sanitario en 4 días: ya se puede programar su venta.", enviada: false, estado: "pendiente" }
      
  ],

  evolucion: {
    semanas: ["Sem 1", "Sem 2", "Sem 3", "Sem 4", "Sem 5", "Sem 6"],
    poblacion: [58, 64, 71, 78, 84, 87],
    ingresos: [0, 0, 120, 180, 320, 480]
  },

  nacimientosSalidas: {
    meses: ["Mar 26", "Abr 26", "May 26", "Jun 26", "Jul 26", "Ago 26", "Sep 26", "Oct 26"],
    nacidas: [22, 35, 45, 28, 51, 33, 41, 18],
    ventas: [0, 12, 108, 25, 40, 0, 65, 20]
  }
};
