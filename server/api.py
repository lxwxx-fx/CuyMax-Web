"""API central de CuyMax (fase 1: adopción).
Expone la misma lógica que usa el bot (acciones.py) para que el bot, la
PWA y la futura app compartan validaciones y reglas.
Arranque local:  uvicorn api:app --host 0.0.0.0 --port 8000 --reload
Autenticación: header X-API-Key igual a API_TOKEN del .env. Si API_TOKEN
no está definido, la API queda abierta (solo desarrollo local)."""
import os
import re
from datetime import date, timedelta
from decimal import Decimal

from dotenv import load_dotenv

load_dotenv()

from fastapi import Depends, FastAPI, Header, HTTPException, Request  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402
from fastapi.responses import FileResponse, JSONResponse  # noqa: E402
from pydantic import BaseModel, Field  # noqa: E402
import psycopg  # noqa: E402
from psycopg import errors as pg_errors  # noqa: E402

import acciones as ac  # noqa: E402
import ia  # noqa: E402

app = FastAPI(title="CuyMax API", version="0.1")


@app.exception_handler(psycopg.IntegrityError)
async def _error_integridad(request: Request, exc: psycopg.IntegrityError):
    """Convierte errores de llaves/reglas de la base en un mensaje entendible."""
    print(f"Error de integridad en {request.url.path}: {exc}")
    return JSONResponse(
        status_code=400,
        content={"detail": "Esa operación choca con otros datos. Revisa el registro e inténtalo de nuevo."},
    )

# Raíz del proyecto CUYMAX-WEB (carpeta padre de server/)
BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# PWA instalable servida por el mismo proceso (mismo origen, sin CORS)
app.mount("/app", StaticFiles(directory=os.path.join(BASE, "app"), html=True), name="app")

# PWA en desarrollo: permitir cualquier origen (restringir en producción)
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
)

API_TOKEN = os.environ.get("API_TOKEN")
if not API_TOKEN:
    print("AVISO: API sin autenticación (define API_TOKEN en el .env).")


def auth(x_api_key: str | None = Header(default=None, alias="X-API-Key")) -> None:
    if API_TOKEN and x_api_key != API_TOKEN:
        raise HTTPException(status_code=401, detail="API key inválida")


def _u(granja_id: int) -> dict:
    return {"id": 0, "granja_id": granja_id, "nombre": "api"}


def _json(obj):
    """Convierte filas psycopg (Decimal, date) a JSON."""
    if isinstance(obj, dict):
        return {k: _json(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_json(v) for v in obj]
    if isinstance(obj, Decimal):
        return float(obj)
    if isinstance(obj, date):
        return obj.isoformat()
    return obj


def _registrar(granja_id: int, accion: str, datos: dict) -> dict:
    u = _u(granja_id)
    try:
        resumen, norm = ac.preparar(u, accion, datos)
    except ac.ErrorUsuario as e:
        raise HTTPException(status_code=400, detail=str(e))
    try:
        extra = ac.ejecutar(u, accion, norm)
    except ac.ErrorUsuario as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"ok": True, "resumen": resumen, "detalle": extra}


_ESQUEMA_EXTRA_LISTO = False


def _asegurar_esquema_extra(con) -> None:
    """Agrega columnas nuevas sin romper bases ya creadas (idempotente)."""
    global _ESQUEMA_EXTRA_LISTO
    if _ESQUEMA_EXTRA_LISTO:
        return
    con.execute("ALTER TABLE granjas ADD COLUMN IF NOT EXISTS precio_cuy numeric")
    _ESQUEMA_EXTRA_LISTO = True


def _lote_abierto(con, granja_id: int, codigo: str) -> dict:
    """Fila de un lote abierto de la granja (incluye vivos y último peso)."""
    codigo = (codigo or "").strip().upper()
    fila = con.execute(
        "SELECT l.id, l.poza_id, l.codigo, l.etapa, l.estado, "
        "v.vivos, v.cantidad_inicial, v.ultimo_peso_g "
        "FROM lotes l JOIN v_resumen_lotes v ON v.lote_id = l.id "
        "WHERE l.granja_id = %s AND UPPER(l.codigo) = %s AND l.estado = 'abierto'",
        (granja_id, codigo),
    ).fetchone()
    if not fila:
        raise HTTPException(status_code=404,
                            detail=f"No encuentro la poza abierta {codigo or '(sin código)'}.")
    return fila


def _poza_de_granja(con, granja_id: int, codigo: str) -> dict | None:
    codigo = (codigo or "").strip().upper()
    return con.execute(
        "SELECT p.id, p.codigo, p.tipo FROM pozas p "
        "JOIN galpones g ON g.id = p.galpon_id "
        "WHERE g.granja_id = %s AND UPPER(p.codigo) = %s ORDER BY p.id LIMIT 1",
        (granja_id, codigo),
    ).fetchone()


def _galpon_para(con, granja_id: int) -> int:
    fila = con.execute(
        "SELECT id FROM galpones WHERE granja_id = %s ORDER BY id LIMIT 1",
        (granja_id,),
    ).fetchone()
    if fila:
        return fila["id"]
    fila = con.execute(
        "INSERT INTO galpones (granja_id, nombre) VALUES (%s, 'Galpón 1') RETURNING id",
        (granja_id,),
    ).fetchone()
    return fila["id"]


def _poza_para_codigo(con, granja_id: int, codigo: str, tipo: str = "recria",
                      capacidad: int = 1) -> dict:
    """Busca una poza por código y, si no existe, la crea en el primer galpón."""
    poza = _poza_de_granja(con, granja_id, codigo)
    if poza:
        return poza
    galpon_id = _galpon_para(con, granja_id)
    fila = con.execute(
        "INSERT INTO pozas (galpon_id, codigo, tipo, capacidad) "
        "VALUES (%s, %s, %s, %s) RETURNING id, codigo, tipo",
        (galpon_id, (codigo or "").strip().upper(), tipo, max(1, int(capacidad))),
    ).fetchone()
    return fila



# ---------- Lecturas ----------

@app.get("/salud")
def salud():
    return {"ok": True}


@app.get("/api/partos-proximos")
def partos_proximos(granja_id: int, _: None = Depends(auth)):
    with ac.db() as con:
        filas = con.execute(
            "SELECT hembra, poza, dias_restantes FROM v_partos_proximos "
            "WHERE granja_id = %s ORDER BY dias_restantes",
            (granja_id,),
        ).fetchall()
    return _json(filas)


@app.get("/api/granja")
def obtener_granja(granja_id: int, _: None = Depends(auth)):
    """Datos de la granja y precios vigentes (para Ajustes y economía)."""
    with ac.db() as con:
        _asegurar_esquema_extra(con)
        fila = con.execute(
            "SELECT id, nombre, precio_cuy FROM granjas WHERE id = %s",
            (granja_id,),
        ).fetchone()
        if not fila:
            raise HTTPException(status_code=404, detail=f"No existe la granja {granja_id}.")
        precios = {}
        for r in con.execute(
            "SELECT DISTINCT ON (tipo) tipo, precio_kg FROM precios_alimento "
            "WHERE granja_id = %s AND vigente_desde <= CURRENT_DATE "
            "ORDER BY tipo, vigente_desde DESC",
            (granja_id,),
        ).fetchall():
            precios[r["tipo"] + "_kg"] = _json(r["precio_kg"])
        if fila["precio_cuy"] is not None:
            precios["cuy"] = _json(fila["precio_cuy"])
    return {"id": fila["id"], "nombre": fila["nombre"], "precios": precios}


class PreciosGranjaIn(BaseModel):
    balanceado_kg: float | None = Field(default=None, ge=0)
    forraje_kg: float | None = Field(default=None, ge=0)
    cuy: float | None = Field(default=None, ge=0)


class GranjaIn(BaseModel):
    granja_id: int
    nombre: str | None = Field(default=None, max_length=120)
    precios: PreciosGranjaIn | None = None


@app.post("/api/granja")
def guardar_granja(d: GranjaIn, _: None = Depends(auth)):
    """Guarda el nombre y los precios de la granja (Ajustes del panel)."""
    nombre = (d.nombre or "").strip()
    with ac.db() as con:
        _asegurar_esquema_extra(con)
        actual = con.execute(
            "SELECT id, nombre FROM granjas WHERE id = %s", (d.granja_id,)
        ).fetchone()
        if not actual:
            nombre = nombre or f"Granja {d.granja_id}"
            con.execute(
                "INSERT INTO granjas (id, nombre) VALUES (%s, %s)",
                (d.granja_id, nombre),
            )
            con.execute(
                "SELECT setval(pg_get_serial_sequence('granjas', 'id'), "
                "GREATEST((SELECT COALESCE(MAX(id), 1) FROM granjas), 1))"
            )
        elif nombre and nombre != actual["nombre"]:
            con.execute("UPDATE granjas SET nombre = %s WHERE id = %s",
                        (nombre, d.granja_id))

        p = d.precios
        if p:
            for tipo, valor in (("balanceado", p.balanceado_kg), ("forraje", p.forraje_kg)):
                if valor is None or valor <= 0:
                    continue
                con.execute(
                    "INSERT INTO precios_alimento "
                    "(granja_id, tipo, precio_kg, vigente_desde, observaciones) "
                    "VALUES (%s, %s, %s, CURRENT_DATE, 'Guardado desde el panel') "
                    "ON CONFLICT (granja_id, tipo, vigente_desde) "
                    "DO UPDATE SET precio_kg = EXCLUDED.precio_kg",
                    (d.granja_id, tipo, valor),
                )
            if p.cuy is not None and p.cuy >= 0:
                con.execute("UPDATE granjas SET precio_cuy = %s WHERE id = %s",
                            (p.cuy, d.granja_id))

        final = con.execute(
            "SELECT nombre FROM granjas WHERE id = %s", (d.granja_id,)
        ).fetchone()
    return {"ok": True, "resumen": "Granja actualizada",
            "detalle": (final or {}).get("nombre") or nombre}




@app.get("/api/lotes")
def lotes(granja_id: int, _: None = Depends(auth)):
    with ac.db() as con:
        filas = con.execute(
            "SELECT * FROM v_resumen_lotes WHERE granja_id = %s ORDER BY codigo",
            (granja_id,),
        ).fetchall()
    return _json(filas)


@app.get("/api/lotes/{codigo}")
def lote(codigo: str, granja_id: int, _: None = Depends(auth)):
    with ac.db() as con:
        fila = con.execute(
            "SELECT * FROM v_resumen_lotes WHERE granja_id = %s AND codigo = %s",
            (granja_id, codigo.upper()),
        ).fetchone()
    if not fila:
        raise HTTPException(status_code=404, detail=f"No existe la poza {codigo.upper()}")
    return _json(fila)


@app.get("/api/lotes/{codigo}/pesajes")
def pesajes_lote(codigo: str, granja_id: int, _: None = Depends(auth)):
    """Historial de pesajes de un lote (solo lectura, para la curva de peso)."""
    with ac.db() as con:
        filas = con.execute(
            "SELECT ps.fecha, ps.peso_promedio_g, ps.animales_pesados FROM pesajes ps "
            "JOIN lotes l ON l.id = ps.lote_id "
            "WHERE l.granja_id = %s AND l.codigo = %s ORDER BY ps.fecha",
            (granja_id, codigo.upper()),
        ).fetchall()
    return _json(filas)


@app.get("/api/resumen-economico")
def resumen_economico(granja_id: int, _: None = Depends(auth)):
    with ac.db() as con:
        filas = con.execute(
            "SELECT * FROM v_resumen_economico_lotes WHERE granja_id = %s ORDER BY codigo",
            (granja_id,),
        ).fetchall()
    return _json(filas)


@app.get("/api/retiros")
def retiros(granja_id: int, _: None = Depends(auth)):
    with ac.db() as con:
        filas = con.execute(
            "SELECT * FROM v_en_retiro WHERE granja_id = %s ORDER BY fecha_fin_retiro",
            (granja_id,),
        ).fetchall()
    return _json(filas)


@app.get("/api/evolucion")
def evolucion(granja_id: int, semanas: int = 6, _: None = Depends(auth)):
    """Historial semanal: población reconstruida e ingresos por ventas.
    Solo lectura; no crea nada."""
    with ac.db() as con:
        filas = con.execute(
            "SELECT to_char(s.semana, 'DD/MM') AS etiqueta, "
            "GREATEST(COALESCE((SELECT SUM(l.cantidad_inicial) FROM lotes l "
            "WHERE l.granja_id = %s AND l.fecha_inicio <= s.semana), 0) "
            "- COALESCE((SELECT SUM(m.cantidad) FROM mortalidad m JOIN lotes l ON l.id = m.lote_id "
            "WHERE l.granja_id = %s AND m.fecha <= s.semana), 0) "
            "- COALESCE((SELECT SUM(v.cantidad) FROM ventas v JOIN lotes l ON l.id = v.lote_id "
            "WHERE l.granja_id = %s AND v.fecha <= s.semana), 0) "
            "- COALESCE((SELECT SUM(f.cantidad) FROM faenas f JOIN lotes l ON l.id = f.lote_id "
            "WHERE l.granja_id = %s AND f.fecha <= s.semana), 0), 0) AS poblacion, "
            "COALESCE((SELECT SUM(v.precio_total) FROM ventas v JOIN lotes l ON l.id = v.lote_id "
            "WHERE l.granja_id = %s AND v.fecha > s.semana - 7 AND v.fecha <= s.semana), 0) AS ingresos "
            "FROM (SELECT CURRENT_DATE - (gs.n * 7) AS semana "
            "FROM generate_series(0, %s) gs(n)) s ORDER BY s.semana",
            (granja_id, granja_id, granja_id, granja_id, granja_id, max(semanas, 1) - 1),
        ).fetchall()
    return _json(filas)


@app.get("/api/nacimientos-salidas")
def nacimientos_salidas(granja_id: int, meses: int = 8, _: None = Depends(auth)):
    """Crías nacidas (partos) y cuyes vendidos por mes. Solo lectura."""
    with ac.db() as con:
        filas = con.execute(
            "SELECT m.mes::date AS mes, "
            "COALESCE((SELECT SUM(p.nacidos_vivos) FROM partos p "
            "JOIN empadres e ON e.id = p.empadre_id JOIN animales a ON a.id = e.hembra_id "
            "WHERE a.granja_id = %s AND date_trunc('month', p.fecha_parto) = m.mes), 0) AS nacidas, "
            "COALESCE((SELECT SUM(v.cantidad) FROM ventas v JOIN lotes l ON l.id = v.lote_id "
            "WHERE l.granja_id = %s AND date_trunc('month', v.fecha) = m.mes), 0) AS ventas "
            "FROM (SELECT date_trunc('month', CURRENT_DATE) - (gs.n || ' months')::interval AS mes "
            "FROM generate_series(0, %s) gs(n)) m ORDER BY m.mes",
            (granja_id, granja_id, max(meses, 1) - 1),
        ).fetchall()
    return _json(filas)


@app.get("/api/alertas")
def alertas(granja_id: int, pendientes: bool = True, _: None = Depends(auth)):
    with ac.db() as con:
        filas = con.execute(
            "SELECT a.id, a.tipo, a.fecha_aviso, a.mensaje, a.enviada, a.estado, "
            "a.fecha_objetivo, h.arete AS hembra, "
            "COALESCE(pl.codigo, pp.codigo) AS poza, l.codigo AS lote, "
            "p.fecha_parto AS fecha_nac, hd.arete AS hembra_parto, "
            "(SELECT CURRENT_DATE - COALESCE(MAX(ps.fecha), CURRENT_DATE) FROM pesajes ps "
            "WHERE ps.lote_id = a.lote_id) AS dias_sin_pesaje "
            "FROM alertas a "
            "LEFT JOIN empadres e ON e.id = a.empadre_id "
            "LEFT JOIN animales h ON h.id = e.hembra_id "
            "LEFT JOIN pozas pl ON pl.id = e.poza_id "
            "LEFT JOIN lotes l ON l.id = a.lote_id "
            "LEFT JOIN pozas pp ON pp.id = a.poza_id "
            "LEFT JOIN partos p ON p.id = a.parto_id "
            "LEFT JOIN empadres ed ON ed.id = p.empadre_id "
            "LEFT JOIN animales hd ON hd.id = ed.hembra_id "
            "WHERE a.granja_id = %s AND a.estado <> 'eliminado' AND (%s OR NOT a.enviada) ORDER BY a.id",
            (granja_id, not pendientes),
        ).fetchall()
    return _json(filas)


@app.post("/api/alertas/{aviso_id}/atender")
def atender_alerta(aviso_id: int, granja_id: int, _: None = Depends(auth)):
    """Marca un aviso como atendido (también lo saca de pendientes)."""
    with ac.db() as con:
        fila = con.execute(
            "UPDATE alertas SET estado = 'atendido', enviada = TRUE "
            "WHERE id = %s AND granja_id = %s AND estado <> 'atendido' RETURNING id",
            (aviso_id, granja_id),
        ).fetchone()
    if not fila:
        raise HTTPException(status_code=404, detail="Aviso no encontrado")
    return {"ok": True}


@app.post("/api/alertas/generar")
def generar_alertas(_: None = Depends(auth)):
    return {"ok": True, "creadas": ac.generar_alertas()}


@app.post("/api/alertas/marcar")
def marcar_alertas(granja_id: int, _: None = Depends(auth)):
    """Marca como enviadas las pendientes de la granja."""
    with ac.db() as con:
        filas = con.execute(
            "SELECT id FROM alertas WHERE granja_id = %s AND NOT enviada",
            (granja_id,),
        ).fetchall()
    ac.marcar_alertas_enviadas([f["id"] for f in filas])
    return {"ok": True, "marcadas": len(filas)}


class InterpretarIn(BaseModel):
    granja_id: int
    texto: str


@app.post("/api/interpretar")
def interpretar(d: InterpretarIn, _: None = Depends(auth)):
    """Interpreta texto libre con IA (para el bot de WhatsApp)."""
    if not ia.disponible():
        raise HTTPException(status_code=503, detail="IA no disponible")
    lotes, hembras = ac.contexto_granja(d.granja_id)
    try:
        accion, datos = ia.interpretar(d.texto, lotes, hembras)
    except Exception:
        raise HTTPException(status_code=502, detail="Falló la consulta a la IA")
    return {"accion": accion, "datos": datos}


@app.get("/api/usuarios/por-telefono")
def usuario_por_telefono(telefono: str, _: None = Depends(auth)):
    """Busca usuario activo por número WhatsApp o LID (solo dígitos)."""
    dig = "".join(c for c in telefono if c.isdigit())
    with ac.db() as con:
        fila = con.execute(
            "SELECT id, granja_id, nombre FROM usuarios "
            "WHERE (whatsapp = %s OR whatsapp_lid = %s) AND activo",
            (dig, dig),
        ).fetchone()
    if not fila:
        raise HTTPException(status_code=404, detail="Usuario no registrado")
    return {"id": fila["id"], "granja_id": fila["granja_id"], "nombre": fila["nombre"]}


@app.get("/api/usuarios/contactos")
def contactos(_: None = Depends(auth)):
    """Contactos WhatsApp activos (para el envío diario de alertas)."""
    with ac.db() as con:
        filas = con.execute(
            "SELECT granja_id, whatsapp, whatsapp_lid FROM usuarios "
            "WHERE activo AND (whatsapp IS NOT NULL OR whatsapp_lid IS NOT NULL)",
        ).fetchall()
    return [
        {"granja_id": f["granja_id"], "whatsapp": f["whatsapp"], "whatsapp_lid": f["whatsapp_lid"]}
        for f in filas
    ]


# ---------- Escrituras (misma validación que el bot) ----------

class PesoIn(BaseModel):
    granja_id: int
    lote: str
    peso_g: float = Field(gt=0)
    animales_pesados: int | None = Field(default=None, gt=0)


class MuerteIn(BaseModel):
    granja_id: int
    lote: str
    cantidad: int = Field(gt=0)
    causa: str | None = None


class AlimentoIn(BaseModel):
    granja_id: int
    lote: str
    tipo: str
    kg: float = Field(gt=0)


class PartoIn(BaseModel):
    granja_id: int
    hembra: str | None = None
    poza: str | None = None
    nacidos_vivos: int = Field(ge=0)
    nacidos_muertos: int = 0


class PartoProximoIn(BaseModel):
    granja_id: int
    hembra: str = Field(min_length=1, max_length=40)
    poza: str | None = Field(default=None, max_length=40)
    fecha_objetivo: date


@app.post("/api/partos-proximos")
def crear_parto_proximo(d: PartoProximoIn, _: None = Depends(auth)):
    """Programa un parto: registra la hembra en gestación con fecha probable."""
    hembra = d.hembra.strip().upper()
    poza_cod = (d.poza or "").strip().upper()
    with ac.db() as con:
        animal = con.execute(
            "SELECT id, arete, poza_id FROM animales "
            "WHERE granja_id = %s AND UPPER(arete) = %s AND estado = 'activo'",
            (d.granja_id, hembra),
        ).fetchone()

        poza = None
        if poza_cod:
            poza = _poza_de_granja(con, d.granja_id, poza_cod)
            if not poza:
                raise HTTPException(status_code=400,
                                    detail=f"No existe la ubicación {poza_cod} en esta granja.")

        if not animal:
            # La persona puede programar una hembra que aún no está fichada.
            if not poza:
                poza = con.execute(
                    "SELECT p.id, p.codigo FROM pozas p JOIN galpones g ON g.id = p.galpon_id "
                    "WHERE g.granja_id = %s ORDER BY p.id LIMIT 1",
                    (d.granja_id,),
                ).fetchone()
            if not poza:
                raise HTTPException(status_code=400,
                                    detail="Primero registra una ubicación (poza) para la granja.")
            animal = con.execute(
                "INSERT INTO animales (granja_id, arete, sexo, poza_id, estado) "
                "VALUES (%s, %s, 'H', %s, 'activo') RETURNING id, arete, poza_id",
                (d.granja_id, hembra, poza["id"]),
            ).fetchone()
        else:
            if poza and animal["poza_id"] != poza["id"]:
                con.execute("UPDATE animales SET poza_id = %s WHERE id = %s",
                            (poza["id"], animal["id"]))
                animal = dict(animal, poza_id=poza["id"])
            if not animal["poza_id"]:
                if not poza:
                    poza = con.execute(
                        "SELECT p.id, p.codigo FROM pozas p JOIN galpones g ON g.id = p.galpon_id "
                        "WHERE g.granja_id = %s ORDER BY p.id LIMIT 1",
                        (d.granja_id,),
                    ).fetchone()
                if not poza:
                    raise HTTPException(status_code=400,
                                        detail="Primero registra una ubicación (poza) para la granja.")
                con.execute("UPDATE animales SET poza_id = %s WHERE id = %s",
                            (poza["id"], animal["id"]))
                animal = dict(animal, poza_id=poza["id"])

        ya = con.execute(
            "SELECT 1 FROM empadres WHERE hembra_id = %s AND estado = 'en_gestacion'",
            (animal["id"],),
        ).fetchone()
        if ya:
            raise HTTPException(status_code=400,
                                detail=f"La hembra {hembra} ya tiene un parto programado.")

        macho = con.execute(
            "SELECT id, arete FROM animales WHERE granja_id = %s AND sexo = 'M' "
            "AND estado = 'activo' ORDER BY (poza_id = %s) DESC, id LIMIT 1",
            (d.granja_id, animal["poza_id"]),
        ).fetchone()
        creado_macho = False
        if not macho:
            macho = con.execute(
                "INSERT INTO animales (granja_id, arete, sexo, poza_id, estado) "
                "VALUES (%s, 'M001', 'M', %s, 'activo') RETURNING id, arete",
                (d.granja_id, animal["poza_id"]),
            ).fetchone()
            creado_macho = True

        # fecha_parto_probable es una columna generada (fecha_empadre + 67 días),
        # así que ajustamos la fecha de empadre para que coincida con la pedida.
        fecha_empadre = d.fecha_objetivo - timedelta(days=67)
        fila = con.execute(
            "INSERT INTO empadres "
            "(hembra_id, macho_id, poza_id, fecha_empadre, estado) "
            "VALUES (%s, %s, %s, %s, 'en_gestacion') "
            "RETURNING id, fecha_parto_probable",
            (animal["id"], macho["id"], animal["poza_id"], fecha_empadre),
        ).fetchone()

        poza_nombre = con.execute(
            "SELECT codigo FROM pozas WHERE id = %s", (animal["poza_id"],)
        ).fetchone()["codigo"]

    dias = (fila["fecha_parto_probable"] - date.today()).days
    cuando = "hoy" if dias == 0 else (f"en {dias} días" if dias > 0 else f"atrasado {-dias} días")
    detalle = f"Fecha probable: {fila['fecha_parto_probable']} ({cuando})."
    if creado_macho:
        detalle += " Se registró el macho M001 como reproductor de referencia."
    ac.sincronizar("partos_proximos", {
        "granja_id": d.granja_id, "hembra": hembra, "poza": poza_nombre,
        "fecha_objetivo": fila["fecha_parto_probable"].isoformat(),
        "creado_en": ac._ahora_iso(),
    })
    return {"ok": True, "resumen": f"parto de {hembra} programado", "detalle": detalle}



@app.post("/api/pesajes")
def crear_pesaje(d: PesoIn, _: None = Depends(auth)):
    return _registrar(d.granja_id, "registrar_peso",
                      {"lote": d.lote, "peso_g": d.peso_g,
                       "animales_pesados": d.animales_pesados})


@app.post("/api/muertes")
def crear_muerte(d: MuerteIn, _: None = Depends(auth)):
    return _registrar(d.granja_id, "registrar_muerte",
                      {"lote": d.lote, "cantidad": d.cantidad, "causa": d.causa})


@app.post("/api/alimento")
def crear_alimento(d: AlimentoIn, _: None = Depends(auth)):
    return _registrar(d.granja_id, "registrar_alimento",
                      {"lote": d.lote, "tipo": d.tipo, "kg": d.kg})


@app.post("/api/partos")
def crear_parto(d: PartoIn, _: None = Depends(auth)):
    return _registrar(d.granja_id, "registrar_parto",
                      {"hembra": d.hembra, "poza": d.poza,
                       "nacidos_vivos": d.nacidos_vivos,
                       "nacidos_muertos": d.nacidos_muertos})


class VentaIn(BaseModel):
    granja_id: int
    lote: str
    cantidad: int = Field(gt=0)
    precio_unitario: float | None = Field(default=None, ge=0)
    peso_total_kg: float | None = Field(default=None, gt=0)
    comprador: str | None = Field(default=None, max_length=120)


@app.post("/api/ventas")
def crear_venta(d: VentaIn, _: None = Depends(auth)):
    """Registra una venta. Si no se indica peso, se estima con el último pesaje."""
    with ac.db() as con:
        lote = _lote_abierto(con, d.granja_id, d.lote)
        if d.cantidad > lote["vivos"]:
            raise HTTPException(status_code=400,
                                detail=f"La poza {lote['codigo']} solo tiene {lote['vivos']} vivos.")
        peso_kg = d.peso_total_kg
        if not peso_kg:
            base_g = float(lote["ultimo_peso_g"] or 800)
            peso_kg = round(base_g * d.cantidad / 1000, 2)
        peso_kg = max(peso_kg, 0.01)

        precio = d.precio_unitario
        if precio is None:
            _asegurar_esquema_extra(con)
            g = con.execute("SELECT precio_cuy FROM granjas WHERE id = %s",
                            (d.granja_id,)).fetchone()
            precio = float(g["precio_cuy"]) if g and g["precio_cuy"] is not None else 0.0
        total = round(float(precio) * d.cantidad, 2)

        # precio_kg es una columna generada por la base (precio_total / peso_total_kg).
        fila = con.execute(
            "INSERT INTO ventas "
            "(lote_id, fecha, cantidad, peso_total_kg, precio_total, comprador) "
            "VALUES (%s, CURRENT_DATE, %s, %s, %s, %s) RETURNING id",
            (lote["id"], d.cantidad, peso_kg, total, d.comprador),
        ).fetchone()
        con.execute(
            "UPDATE lotes SET cantidad_vendida = COALESCE(cantidad_vendida, 0) + %s "
            "WHERE id = %s",
            (d.cantidad, lote["id"]),
        )

    ac.sincronizar("ventas", {
        "granja_id": d.granja_id, "lote": lote["codigo"], "fecha": ac._hoy_iso(),
        "cantidad": d.cantidad, "precio_unitario": float(precio),
        "precio_total": total, "creado_en": ac._ahora_iso(),
    })
    ac.actualizar_lote_firestore(lote["codigo"], d.granja_id,
                                 incrementar={"vivos": -d.cantidad,
                                              "vendidos": d.cantidad})
    return {
        "ok": True,
        "resumen": f"{d.cantidad} cuy(es) vendidos de la poza {lote['codigo']}",
        "detalle": (f"Ingreso: S/ {total:.2f}. Quedan "
                    f"{lote['vivos'] - d.cantidad} vivos."),
    }


class FaenaIn(BaseModel):
    granja_id: int
    lote: str
    cantidad: int = Field(gt=0)
    peso_vivo_total_kg: float | None = Field(default=None, gt=0)
    peso_carcasa_kg: float | None = Field(default=None, gt=0)
    destino: str | None = Field(default=None, max_length=80)


@app.post("/api/faenas")
def crear_faena(d: FaenaIn, _: None = Depends(auth)):
    """Registra una faena. Estima pesos si no se envían (70% de rendimiento)."""
    with ac.db() as con:
        lote = _lote_abierto(con, d.granja_id, d.lote)
        if d.cantidad > lote["vivos"]:
            raise HTTPException(status_code=400,
                                detail=f"La poza {lote['codigo']} solo tiene {lote['vivos']} vivos.")
        vivo = d.peso_vivo_total_kg
        if not vivo:
            base_g = float(lote["ultimo_peso_g"] or 800)
            vivo = round(base_g * d.cantidad / 1000, 2)
        vivo = max(vivo, 0.01)
        carcasa = d.peso_carcasa_kg or round(vivo * 0.70, 2)
        carcasa = max(carcasa, 0.01)
        if carcasa > vivo:
            raise HTTPException(status_code=400,
                                detail="El peso de carcasa no puede superar el peso vivo.")
        rendimiento = round(carcasa / vivo * 100, 2)

        # rendimiento_pct lo calcula la base a partir de los pesos.
        con.execute(
            "INSERT INTO faenas "
            "(lote_id, fecha, cantidad, peso_vivo_total_kg, peso_carcasa_kg, destino) "
            "VALUES (%s, CURRENT_DATE, %s, %s, %s, %s)",
            (lote["id"], d.cantidad, vivo, carcasa, d.destino),
        )

    ac.sincronizar("faenas", {
        "granja_id": d.granja_id, "lote": lote["codigo"], "fecha": ac._hoy_iso(),
        "cantidad": d.cantidad, "creado_en": ac._ahora_iso(),
    })
    ac.actualizar_lote_firestore(lote["codigo"], d.granja_id,
                                 incrementar={"vivos": -d.cantidad,
                                              "faenados": d.cantidad})
    return {
        "ok": True,
        "resumen": f"{d.cantidad} cuy(es) faenados de la poza {lote['codigo']}",
        "detalle": f"Quedan {lote['vivos'] - d.cantidad} vivos. Rendimiento: {rendimiento:g}%.",
    }


class RetiroIn(BaseModel):
    granja_id: int
    lote: str
    producto: str = Field(min_length=1, max_length=120)
    dias: int = Field(ge=1, le=90)
    tipo: str = "tratamiento"


@app.post("/api/retiros")
def crear_retiro(d: RetiroIn, _: None = Depends(auth)):
    """Registra un tratamiento y su periodo de retiro sanitario."""
    producto = d.producto.strip()
    if not producto:
        raise HTTPException(status_code=400, detail="Dime qué producto se aplicó.")
    with ac.db() as con:
        lote = _lote_abierto(con, d.granja_id, d.lote)
        tipo = (d.tipo or "tratamiento").strip().lower()
        if tipo not in ("tratamiento", "enfermedad", "vacunacion", "desparasitacion", "otro"):
            tipo = "tratamiento"
        # fecha_fin_retiro es generada por la base (fecha + dias_retiro).
        fila = con.execute(
            "INSERT INTO eventos_sanitarios "
            "(granja_id, fecha, tipo, poza_id, lote_id, animales_afectados, descripcion, "
            "producto, dias_retiro) "
            "VALUES (%s, CURRENT_DATE, %s, %s, %s, %s, %s, %s, %s) "
            "RETURNING fecha + dias_retiro AS fecha_fin_retiro",
            (d.granja_id, tipo, lote["poza_id"], lote["id"],
             lote["vivos"] if lote["vivos"] > 0 else None,
             f"Retiro sanitario: {producto}"[:200], producto, d.dias),
        ).fetchone()

    ac.sincronizar("retiros", {
        "granja_id": d.granja_id, "lote": lote["codigo"], "poza": None,
        "producto": producto, "tipo": tipo, "fecha_inicio": ac._hoy_iso(),
        "fecha_fin_retiro": fila["fecha_fin_retiro"].isoformat(),
        "dias": d.dias, "creado_en": ac._ahora_iso(),
    })
    return {
        "ok": True,
        "resumen": f"retiro sanitario de {d.dias} día(s) para la poza {lote['codigo']}",
        "detalle": f"No vender hasta el {fila['fecha_fin_retiro']}.",
    }


class DesteteIn(BaseModel):
    granja_id: int
    hembra: str
    cantidad: int = Field(gt=0)
    poza_destino: str = Field(min_length=1, max_length=40)


@app.post("/api/destetes")
def crear_destete(d: DesteteIn, _: None = Depends(auth)):
    """Desteta las crías de una hembra y las pasa a una poza de recría."""
    hembra = d.hembra.strip().upper()
    destino = d.poza_destino.strip().upper()
    if not destino:
        raise HTTPException(status_code=400, detail="Dime a qué poza pasan las crías.")
    with ac.db() as con:
        parto = con.execute(
            "SELECT p.id AS parto_id, p.nacidos_vivos, COALESCE(p.destetados, 0) AS destetados, "
            "a.arete FROM partos p "
            "JOIN empadres e ON e.id = p.empadre_id "
            "JOIN animales a ON a.id = e.hembra_id "
            "WHERE a.granja_id = %s AND UPPER(a.arete) = %s "
            "AND NOT EXISTS (SELECT 1 FROM destetes x WHERE x.parto_id = p.id) "
            "ORDER BY p.fecha_parto DESC, p.id DESC LIMIT 1",
            (d.granja_id, hembra),
        ).fetchone()
        if not parto:
            raise HTTPException(status_code=400,
                                detail=f"No encuentro crías pendientes de destete para {hembra}.")
        disponibles = parto["nacidos_vivos"] - parto["destetados"]
        if d.cantidad > disponibles:
            raise HTTPException(status_code=400,
                                detail=f"Esa hembra solo tiene {disponibles} cría(s) por destetar.")

        poza = _poza_para_codigo(con, d.granja_id, destino, "recria", d.cantidad)
        lote = con.execute(
            "SELECT id, estado FROM lotes WHERE granja_id = %s AND UPPER(codigo) = %s",
            (d.granja_id, destino),
        ).fetchone()
        if lote:
            if lote["estado"] != "abierto":
                raise HTTPException(status_code=400,
                                    detail=f"La poza {destino} está cerrada.")
            con.execute(
                "UPDATE lotes SET cantidad_inicial = cantidad_inicial + %s WHERE id = %s",
                (d.cantidad, lote["id"]),
            )
            lote_id = lote["id"]
        else:
            fila_lote = con.execute(
                "INSERT INTO lotes "
                "(granja_id, poza_id, codigo, etapa, fecha_inicio, cantidad_inicial) "
                "VALUES (%s, %s, %s, 'recria', CURRENT_DATE, %s) RETURNING id",
                (d.granja_id, poza["id"], destino, d.cantidad),
            ).fetchone()
            lote_id = fila_lote["id"]

        con.execute(
            "INSERT INTO destetes "
            "(parto_id, fecha, machos, hembras, poza_destino_id, observaciones) "
            "VALUES (%s, CURRENT_DATE, 0, %s, %s, %s)",
            (parto["parto_id"], d.cantidad, poza["id"], f"lote_id={lote_id}"),
        )
        con.execute(
            "UPDATE partos SET destetados = COALESCE(destetados, 0) + %s, "
            "fecha_destete = CURRENT_DATE WHERE id = %s",
            (d.cantidad, parto["parto_id"]),
        )
        quedan = disponibles - d.cantidad

    ac.sincronizar("destetes", {
        "granja_id": d.granja_id, "hembra": parto["arete"], "cantidad": d.cantidad,
        "poza_destino": destino, "fecha": ac._hoy_iso(),
        "parto_id": parto["parto_id"], "creado_en": ac._ahora_iso(),
    })
    ac.actualizar_lote_firestore(destino, d.granja_id,
                                 incrementar={"vivos": d.cantidad,
                                              "cantidad_inicial": d.cantidad})
    return {
        "ok": True,
        "resumen": f"{d.cantidad} cría(s) destetadas a la poza {destino}",
        "detalle": (f"Quedan {quedan} con la madre." if quedan > 0
                    else "Ya no quedan crías con esa hembra."),
    }



# ---------- Ingresos de cuyes (compras / llegadas a la granja) ----------

class IngresoIn(BaseModel):
    granja_id: int
    lote: str
    cantidad: int = Field(gt=0)


class LoteNuevoIn(BaseModel):
    granja_id: int
    codigo: str
    cantidad_inicial: int = Field(gt=0)
    etapa: str = "engorde"
    poza_id: int | None = None


@app.get("/api/pozas")
def pozas(granja_id: int, _: None = Depends(auth)):
    """Pozas de la granja (para ubicar los lotes nuevos)."""
    with ac.db() as con:
        filas = con.execute(
            "SELECT p.id, p.codigo, p.tipo, p.capacidad FROM pozas p "
            "JOIN galpones g ON g.id = p.galpon_id WHERE g.granja_id = %s ORDER BY p.codigo",
            (granja_id,),
        ).fetchall()
    return _json(filas)


@app.post("/api/ingresos")
def crear_ingreso(d: IngresoIn, _: None = Depends(auth)):
    """Suma cuyes comprados a un lote abierto (sube su cantidad inicial)."""
    codigo = d.lote.strip().upper()
    with ac.db() as con:
        fila = con.execute(
            "UPDATE lotes SET cantidad_inicial = cantidad_inicial + %s "
            "WHERE granja_id = %s AND UPPER(codigo) = %s AND estado = 'abierto' "
            "RETURNING codigo, cantidad_inicial",
            (d.cantidad, d.granja_id, codigo),
        ).fetchone()
    if not fila:
        raise HTTPException(status_code=404, detail=f"No encuentro la poza abierta {codigo}.")
    ac.actualizar_lote_firestore(codigo, d.granja_id,
                                 incrementar={"vivos": d.cantidad,
                                              "cantidad_inicial": d.cantidad})
    return {"ok": True, "resumen": f"{d.cantidad} cuyes ingresados a la poza {fila['codigo']}",
            "detalle": f"Ahora son {fila['cantidad_inicial']} en total."}


@app.post("/api/lotes")
def crear_lote(d: LoteNuevoIn, _: None = Depends(auth)):
    """Crea un lote nuevo (cuyes que llegan por compra) en una poza."""
    codigo = d.codigo.strip().upper()
    etapa = d.etapa.strip().lower()
    if not codigo:
        raise HTTPException(status_code=400, detail="Dime el código de la poza nueva.")
    if etapa not in ("recria", "engorde"):
        raise HTTPException(status_code=400, detail="La etapa debe ser recria o engorde.")
    with ac.db() as con:
        poza_id = d.poza_id
        if poza_id is None:
            poza = _poza_para_codigo(con, d.granja_id, codigo, etapa, d.cantidad_inicial)
            poza_id = poza["id"]
        else:
            poza = con.execute(
                "SELECT p.id FROM pozas p JOIN galpones g ON g.id = p.galpon_id "
                "WHERE p.id = %s AND g.granja_id = %s",
                (poza_id, d.granja_id),
            ).fetchone()
            if not poza:
                raise HTTPException(status_code=400, detail="Esa poza no pertenece a esta granja.")
        existe = con.execute(
            "SELECT 1 FROM lotes WHERE granja_id = %s AND UPPER(codigo) = %s",
            (d.granja_id, codigo),
        ).fetchone()
        if existe:
            raise HTTPException(status_code=400, detail=f"La poza {codigo} ya existe en esta granja.")
        con.execute(
            "INSERT INTO lotes (granja_id, poza_id, codigo, etapa, fecha_inicio, cantidad_inicial) "
            "VALUES (%s, %s, %s, %s, CURRENT_DATE, %s)",
            (d.granja_id, poza_id, codigo, etapa, d.cantidad_inicial),
        )
    ac.crear_lote_firestore(codigo, d.granja_id, {
        "granja_id": d.granja_id, "codigo": codigo, "nombre": "", "etapa": etapa,
        "estado": "abierto", "cantidad_inicial": d.cantidad_inicial,
        "vivos": d.cantidad_inicial, "muertos": 0, "vendidos": 0, "faenados": 0,
        "alimento_kg": 0, "ultimo_peso_g": None, "peso_objetivo_g": None,
        "fecha_inicio": ac._hoy_iso(), "creado_en": ac._ahora_iso(),
    })
    return {"ok": True, "resumen": f"poza {codigo} creada con {d.cantidad_inicial} cuyes",
            "detalle": "Ya puedes pesarlo y registrar su alimento."}


# ---------- Asistente (chat en el panel) ----------

class AsistenteIn(BaseModel):
    granja_id: int
    texto: str = Field(min_length=1, max_length=500)


class ConfirmarAsistenteIn(BaseModel):
    granja_id: int
    accion: str
    datos: dict


REGISTROS_ASISTENTE = {"registrar_peso", "registrar_muerte", "registrar_alimento", "registrar_parto"}


def _consulta_asistente(accion: str, u: dict, datos: dict) -> str:
    if accion == "consultar_partos":
        return ac.texto_partos(u)
    if accion == "consultar_lote":
        return ac.texto_lote(u, datos.get("lote"))
    if accion == "consultar_lotes":
        return ac.texto_lotes(u, datos.get("lotes") or None)
    if accion == "consultar_alertas":
        return ac.texto_alertas(u)
    if accion == "consultar_retiro":
        return ac.texto_retiros(u)
    return "Eso todavía no lo sé hacer."


@app.post("/api/asistente")
def asistente(d: AsistenteIn, _: None = Depends(auth)):
    """Interpreta un mensaje del panel: responde consultas o propone un registro."""
    if not ia.disponible():
        return {"tipo": "error", "texto": "El asistente no está configurado (falta GROQ_API_KEY en el .env)."}
    u = _u(d.granja_id)
    lotes, hembras = ac.contexto_granja(d.granja_id)
    try:
        accion, datos = ia.interpretar(d.texto, lotes, hembras)
    except Exception:
        return {"tipo": "error", "texto": "No pude entender el mensaje. Prueba escribirlo de otra forma."}
    if accion == "sin_accion":
        return {"tipo": "respuesta", "texto": datos.get("motivo") or "No entendí el mensaje."}
    if accion in REGISTROS_ASISTENTE:
        try:
            resumen, _norm = ac.preparar(u, accion, datos)
        except ac.ErrorUsuario as e:
            return {"tipo": "respuesta", "texto": str(e)}
        return {"tipo": "propuesta", "accion": accion, "resumen": resumen, "datos": datos}
    try:
        texto = _consulta_asistente(accion, u, datos)
    except Exception:
        return {"tipo": "error", "texto": "No pude consultar los datos. Intenta de nuevo."}
    return {"tipo": "respuesta", "texto": texto}


@app.post("/api/asistente/confirmar")
def asistente_confirmar(d: ConfirmarAsistenteIn, _: None = Depends(auth)):
    """Guarda una propuesta del asistente (la persona ya confirmó)."""
    if d.accion not in REGISTROS_ASISTENTE:
        raise HTTPException(status_code=400, detail="Acción no permitida.")
    res = _registrar(d.granja_id, d.accion, d.datos)
    extra = res.get("detalle") or ""
    texto = "Listo: " + res["resumen"] + ("." if not extra else ". " + extra)
    return {"ok": True, "texto": texto}


# ---------- Últimos registros y borrado ----------

@app.get("/api/registros")
def registros(granja_id: int, limite: int = 15, _: None = Depends(auth)):
    """Últimos movimientos de la granja, del más nuevo al más viejo."""
    with ac.db() as con:
        filas = con.execute(
            """
            SELECT 'peso' AS tipo, ps.id, ps.fecha, l.codigo AS lote, NULL::varchar AS hembra,
                   'Peso ' || trim_scale(ps.peso_promedio_g)::text || ' g (muestra ' ||
                   ps.animales_pesados::text || ')' AS detalle
            FROM pesajes ps JOIN lotes l ON l.id = ps.lote_id
            WHERE l.granja_id = %s
            UNION ALL
            SELECT 'muerte', m.id, m.fecha, l.codigo, NULL::varchar,
                   m.cantidad::text || ' muerte(s)' || COALESCE(' · ' || m.causa, '')
            FROM mortalidad m JOIN lotes l ON l.id = m.lote_id
            WHERE l.granja_id = %s
            UNION ALL
            SELECT 'alimento', c.id, c.fecha, l.codigo, NULL::varchar,
                   trim_scale(c.kg)::text || ' kg de ' || c.tipo
            FROM consumo_alimento c JOIN lotes l ON l.id = c.lote_id
            WHERE l.granja_id = %s
            UNION ALL
            SELECT 'parto', p.id, p.fecha_parto, NULL::varchar, a.arete,
                   p.nacidos_vivos::text || ' vivos, ' || p.nacidos_muertos::text || ' muertos'
            FROM partos p
            JOIN empadres e ON e.id = p.empadre_id
            JOIN animales a ON a.id = e.hembra_id
            WHERE a.granja_id = %s
            UNION ALL
            SELECT 'destete', d.id, d.fecha, NULL::varchar, a.arete,
                   (d.machos + d.hembras)::text || ' crías destetadas a ' || pz.codigo
            FROM destetes d
            JOIN partos p ON p.id = d.parto_id
            JOIN empadres e ON e.id = p.empadre_id
            JOIN animales a ON a.id = e.hembra_id
            JOIN pozas pz ON pz.id = d.poza_destino_id
            WHERE a.granja_id = %s
            UNION ALL
            SELECT 'venta', v.id, v.fecha, l.codigo, NULL::varchar,
                   v.cantidad::text || ' vendidos · S/ ' || round(v.precio_total, 2)::text
            FROM ventas v JOIN lotes l ON l.id = v.lote_id
            WHERE l.granja_id = %s
            UNION ALL
            SELECT 'faena', f.id, f.fecha, l.codigo, NULL::varchar,
                   f.cantidad::text || ' faenados'
            FROM faenas f JOIN lotes l ON l.id = f.lote_id
            WHERE l.granja_id = %s
            UNION ALL
            SELECT 'retiro', ev.id, ev.fecha, COALESCE(l.codigo, pz.codigo),
                   NULL::varchar,
                   COALESCE(ev.producto, ev.tipo) || ' · ' ||
                   COALESCE(ev.dias_retiro, 0)::text || ' días de retiro'
            FROM eventos_sanitarios ev
            LEFT JOIN lotes l ON l.id = ev.lote_id
            LEFT JOIN pozas pz ON pz.id = ev.poza_id
            WHERE ev.granja_id = %s AND ev.dias_retiro IS NOT NULL
            ORDER BY fecha DESC, id DESC
            LIMIT %s
            """,
            (granja_id, granja_id, granja_id, granja_id, granja_id,
             granja_id, granja_id, granja_id, max(1, min(limite, 100))),
        ).fetchall()
    return _json(filas)


TABLAS_REGISTRO = {
    "peso": "pesajes",
    "muerte": "mortalidad",
    "alimento": "consumo_alimento",
    "parto": "partos",
    "destete": "destetes",
    "venta": "ventas",
    "faena": "faenas",
    "retiro": "eventos_sanitarios",
}


@app.delete("/api/registros/{tipo}/{registro_id}")
def borrar_registro(tipo: str, registro_id: int, granja_id: int, _: None = Depends(auth)):
    """Borra un movimiento cargado por error (la persona lo confirma en el panel)."""
    if tipo not in TABLAS_REGISTRO:
        raise HTTPException(status_code=400, detail="Tipo de registro no válido.")
    lote_borrado = None
    with ac.db() as con:
        if tipo == "parto":
            con_destete = con.execute(
                "SELECT 1 FROM destetes d JOIN partos p ON p.id = d.parto_id "
                "WHERE p.id = %s", (registro_id,)
            ).fetchone()
            if con_destete:
                raise HTTPException(
                    status_code=400,
                    detail="Ese parto ya tiene un destete registrado. Borra primero el destete.")
            fila = con.execute(
                "DELETE FROM partos p USING empadres e, animales a "
                "WHERE p.id = %s AND e.id = p.empadre_id AND a.id = e.hembra_id "
                "AND a.granja_id = %s RETURNING p.empadre_id",
                (registro_id, granja_id),
            ).fetchone()
            if fila:
                con.execute(
                    "UPDATE empadres SET estado = 'en_gestacion' WHERE id = %s "
                    "AND NOT EXISTS (SELECT 1 FROM partos WHERE empadre_id = %s)",
                    (fila["empadre_id"], fila["empadre_id"]),
                )
        elif tipo == "destete":
            fila = con.execute(
                "DELETE FROM destetes d USING partos p, empadres e, animales a "
                "WHERE d.id = %s AND p.id = d.parto_id AND e.id = p.empadre_id "
                "AND a.id = e.hembra_id AND a.granja_id = %s "
                "RETURNING d.parto_id, d.machos + d.hembras AS cantidad, d.observaciones",
                (registro_id, granja_id),
            ).fetchone()
            if fila:
                con.execute(
                    "UPDATE partos SET destetados = GREATEST(COALESCE(destetados, 0) - %s, 0), "
                    "fecha_destete = NULL WHERE id = %s",
                    (fila["cantidad"], fila["parto_id"]),
                )
                m = re.match(r"lote_id=(\d+)", fila["observaciones"] or "")
                if m:
                    lote_id = int(m.group(1))
                    lote = con.execute(
                        "SELECT cantidad_inicial, codigo FROM lotes "
                        "WHERE id = %s AND granja_id = %s",
                        (lote_id, granja_id),
                    ).fetchone()
                    if lote and lote["cantidad_inicial"] > fila["cantidad"]:
                        con.execute(
                            "UPDATE lotes SET cantidad_inicial = cantidad_inicial - %s "
                            "WHERE id = %s",
                            (fila["cantidad"], lote_id),
                        )
                    elif lote and lote["cantidad_inicial"] == fila["cantidad"]:
                        # La poza nació con este destete: si no tiene otros
                        # movimientos se elimina (cantidad_inicial no puede ser 0).
                        con_otros = con.execute(
                            "SELECT 1 FROM lotes l WHERE l.id = %s AND ("
                            "EXISTS (SELECT 1 FROM pesajes WHERE lote_id = l.id) OR "
                            "EXISTS (SELECT 1 FROM ventas WHERE lote_id = l.id) OR "
                            "EXISTS (SELECT 1 FROM faenas WHERE lote_id = l.id) OR "
                            "EXISTS (SELECT 1 FROM mortalidad WHERE lote_id = l.id) OR "
                            "EXISTS (SELECT 1 FROM consumo_alimento WHERE lote_id = l.id) OR "
                            "EXISTS (SELECT 1 FROM eventos_sanitarios WHERE lote_id = l.id))",
                            (lote_id,),
                        ).fetchone()
                        if con_otros:
                            raise HTTPException(
                                status_code=400,
                                detail="La poza de recría ya tiene movimientos. "
                                       "Borra primero esos registros para quitar el destete.",
                            )
                        con.execute("DELETE FROM lotes WHERE id = %s AND granja_id = %s",
                                    (lote_id, granja_id))
                        lote_borrado = lote["codigo"]
                    elif lote:
                        raise HTTPException(
                            status_code=400,
                            detail="No puedo revertir el destete: la poza de recría "
                                   "tiene menos animales de los que se destetaron.",
                        )
        elif tipo == "retiro":
            fila = con.execute(
                "DELETE FROM eventos_sanitarios "
                "WHERE id = %s AND granja_id = %s RETURNING id",
                (registro_id, granja_id),
            ).fetchone()
        elif tipo in ("venta", "faena"):
            tabla = TABLAS_REGISTRO[tipo]
            fila = con.execute(
                "DELETE FROM " + tabla + " t USING lotes l "
                "WHERE t.id = %s AND l.id = t.lote_id AND l.granja_id = %s "
                "RETURNING t.lote_id, t.cantidad",
                (registro_id, granja_id),
            ).fetchone()
            if fila and tipo == "venta":
                con.execute(
                    "UPDATE lotes SET cantidad_vendida = GREATEST(COALESCE(cantidad_vendida, 0) - %s, 0) "
                    "WHERE id = %s",
                    (fila["cantidad"], fila["lote_id"]),
                )
        else:
            fila = con.execute(
                "DELETE FROM " + TABLAS_REGISTRO[tipo] + " t USING lotes l "
                "WHERE t.id = %s AND l.id = t.lote_id AND l.granja_id = %s RETURNING t.id",
                (registro_id, granja_id),
            ).fetchone()
    if not fila:
        raise HTTPException(status_code=404, detail="El registro no existe o no es de esta granja.")
    if lote_borrado:
        ac.borrar_lote_firestore(lote_borrado, granja_id)
    return {"ok": True}


# ---------- Landing y archivos públicos de la raíz de CUYMAX-WEB ----------

ARCHIVOS_RAIZ = {"login.html", "landing.css", "firebase-config.js", "logo.png"}


@app.get("/", include_in_schema=False)
def raiz():
    return FileResponse(os.path.join(BASE, "index.html"))


@app.get("/{archivo}", include_in_schema=False)
def archivo_raiz(archivo: str):
    if archivo in ARCHIVOS_RAIZ:
        return FileResponse(os.path.join(BASE, archivo))
    raise HTTPException(status_code=404, detail="No encontrado")


app.mount("/img", StaticFiles(directory=os.path.join(BASE, "img")), name="img")
