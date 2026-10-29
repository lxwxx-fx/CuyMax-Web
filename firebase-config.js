var FIREBASE_CONFIG = {
  apiKey: "AIzaSyCasoyb4QuLSwk_5092O0X7cXojg9Tgh3Y",
  authDomain: "cuymax-by-dc.firebaseapp.com",
  projectId: "cuymax-by-dc",
  storageBucket: "cuymax-by-dc.firebasestorage.app",
  messagingSenderId: "287547612220",
  appId: "1:287547612220:web:0ef839f638b61fdf0c3739",
  measurementId: "G-Q5CF1EXL7R"
};

/* Worker de IA en Cloudflare (carpeta worker/). Dejalo vacio ("") para usar
   solo el interprete de reglas del panel, sin llamadas externas.
   Ejemplo: "https://cuymax-ia.tu-subdominio.workers.dev" */
var CUYMAX_IA_URL = "https://cuymax-ia.cuymax.workers.dev";

/* Clave pública VAPID para las notificaciones del celular. Es la mitad pública
   del par que firma el Worker (la privada vive como su secreto VAPID_JWK). */
var CUYMAX_VAPID_PUBLIC = "BExTcOOETRgrHMlsapl30Sxnu-MASS5vc47bjYZO-39z5k3495bWtvli8VXec_jrWajZY3-fAT_ntrUsVb9ceYo";
