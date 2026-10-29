"""Lógica del sistema: valida y escribe en la base de datos.
No usa Telegram ni IA, así la misma lógica sirve para cualquier canal (Telegram, WhatsApp...)."""
import os
import json
from datetime import date, datetime, timedelta, timezone

import psycopg
from psycopg.rows import dict_row

import firebase_admin
from firebase_admin import credentials, firestore

# Firebase Admin SDK initialization - try with service account file first
_firebase_initialized = False

try:
    cred_path = os.path.join(os.path.dirname(__file__), "firebase-creds.json")
    if os.path.exists(cred_path):
        cred = credentials.Certificate(cred_path)
        firebase_admin.initialize_app(cred)
        print(f"Firebase Admin SDK initialized with {cred_path}")
        _firebase_initialized = True
    else:
        # Try environment variable with base64-encoded credentials
        cred_b64 = os.environ.get("FIREBASE_CRED_BASE64")
        if cred_b64:
            import base64
            cred_data = base64.b64decode(cred_b64).decode("utf-8")
            cred_dict = json.loads(cred_data)
            cred = credentials.Certificate(cred_dict)
            firebase_admin.initialize_app(cred)
            print("Firebase Admin SDK initialized from environment variable FIREBASE_CRED_BASE64")
            _firebase_initialized = True
        else:
            # No credentials available - will use PostgreSQL only
            print("No Firebase credentials found - using PostgreSQL only")
except Exception as e:
    print(f"Firebase Admin SDK initialization skipped: {e}")
    # Continue with PostgreSQL only - _firebase_initialized stays False

# Only create Firestore client if Firebase was initialized successfully
if _firebase_initialized:
    db_firestore = firestore.client()
    print("Firestore client created successfully")
else:
    db_firestore = None
    print("Firestore disabled - using PostgreSQL only")


class ErrorUsuario(Exception):
    """Mensaje que se le puede mostrar tal cual a la persona."""


def db():
    return psycopg.connect(os.environ["DATABASE_URL"], row_factory=dict_row)


def _num(x, nombre):
    try:
        n = float(str(x).replace(",", "."))
    except (TypeError, ValueError):
        raise ErrorUsuario(f"No entendí el valor de {nombre}.")
    if n != n or abs(n) == float("inf"):
        raise ErrorUsuario(f"No entendí el valor de {nombre}.")
    return n


def _ent(x, nombre):
    n = _num(x, nombre)
    if n != int(n):
        raise ErrorUsuario(f"El valor de {nombre} debe ser un número entero.")
    return int(n)


def _lote(con, granja_id, codigo):
    codigo = (codigo or "").strip().upper()
    l = con.execute(
        "SELECT lote_id, codigo, vivos FROM v_resumen_lotes "
        "WHERE granja_id = %s AND codigo = %s AND estado = 'abierto'",
        (granja_id, codigo),
    ).fetchone()
    if not l:
        raise ErrorUsuario(f"No encuentro la poza abierta {codigo or '(sin código)'}.")
    return l


def contexto_granja(granja_id):
    """Datos mínimos que ayudan a la IA a interpretar: códigos de lotes y hembras en gestación."""
    with db() as con:
        lotes = [r["codigo"] for r in con.execute(
            "SELECT codigo FROM lotes WHERE granja_id = %s AND estado = 'abierto' ORDER BY codigo",
            (granja_id,),
        ).fetchall()]
        hembras = [(r["arete"], r["poza"]) for r in con.execute(
            "SELECT a.arete, p.codigo AS poza FROM empadres e "
            "JOIN animales a ON a.id = e.hembra_id JOIN pozas p ON p.id = e.poza_id "
            "WHERE a.granja_id = %s AND e.estado = 'en_gestacion' ORDER BY a.arete",
            (granja_id,),
        ).fetchall()]
    return lotes, hembras


def _firestore_add(collection, data):
    """Agrega un documento a Firestore sin romper la operación local si falla."""
    if not _firebase_initialized:
        return False
    try:
        db_firestore.collection(collection).add(data)
        return True
    except Exception as e:
        print(f"Aviso: no se pudo sincronizar {collection} en Firestore: {e}")
        return False


def _firestore_lote_ref(codigo, granja_id):
    """Devuelve la referencia del lote en Firestore (nuevo esquema o legado)."""
    if not _firebase_initialized:
        return None
    codigo = (codigo or "").strip().upper()
    if not codigo:
        return None
    try:
        base = db_firestore.collection("lotes")
        # Esquema nuevo: el ID incluye la granja para que dos granjas puedan
        # tener una poza con el mismo código sin pisarse.
        nuevo = base.document(f"g{granja_id}_{codigo}")
        if nuevo.get().exists:
            return nuevo
        # Compatibilidad con los documentos antiguos (ID = código).
        viejo = base.document(codigo)
        snap = viejo.get()
        if snap.exists:
            datos = snap.to_dict() or {}
            gid = datos.get("granja_id")
            if gid is None:
                if granja_id == 1:
                    return viejo
            else:
                try:
                    if int(gid) == int(granja_id):
                        return viejo
                except (TypeError, ValueError):
                    pass
    except Exception as e:
        print(f"Aviso: no se pudo leer el lote {codigo} de Firestore: {e}")
    return None


def _firestore_update_lote(codigo, granja_id, campos=None, incrementar=None):
    """Actualiza los totales del lote en Firestore, si existe."""
    ref = _firestore_lote_ref(codigo, granja_id)
    if ref is None:
        return False
    datos = dict(campos or {})
    for campo, delta in (incrementar or {}).items():
        datos[campo] = firestore.Increment(delta)
    try:
        ref.update(datos)
        return True
    except Exception as e:
        print(f"Aviso: no se pudo actualizar el lote {codigo} en Firestore: {e}")
        return False


def _firestore_borrar_partos_proximos(hembra, granja_id):
    """Quita de partos_proximos la hembra que ya parió (si estaba programada)."""
    if not _firebase_initialized:
        return
    hembra = (hembra or "").strip().upper()
    if not hembra:
        return
    try:
        for doc in db_firestore.collection("partos_proximos").stream():
            datos = doc.to_dict() or {}
            if str(datos.get("hembra") or "").strip().upper() != hembra:
                continue
            gid = datos.get("granja_id")
            if gid is None:
                if granja_id != 1:
                    continue
            else:
                try:
                    if int(gid) != int(granja_id):
                        continue
                except (TypeError, ValueError):
                    continue
            doc.reference.delete()
    except Exception as e:
        print(f"Aviso: no se pudo borrar el parto programado de {hembra}: {e}")


def _hoy_iso():
    return date.today().isoformat()


def _en_dias_iso(dias):
    return (date.today() + timedelta(days=dias)).isoformat()


def _ahora_iso():
    return datetime.now(timezone.utc).isoformat()



def preparar(u, accion, a):
    """Valida el pedido y devuelve (resumen_para_la_persona, datos_normalizados).
    Lanza ErrorUsuario si algo no cuadra. NO escribe nada."""
    g = u["granja_id"]
    with db() as con:
        if accion == "registrar_peso":
            l = _lote(con, g, a.get("lote"))
            peso = _num(a.get("peso_g"), "el peso")
            n = _ent(a.get("animales_pesados") or 10, "la muestra")
            if not (20 <= peso <= 3000) or n <= 0:
                raise ErrorUsuario("Peso fuera de rango. Debe ir en gramos, por ejemplo 720.")
            return (f"peso de la poza {l['codigo']}: {peso:g} g (muestra de {n})",
                    {"granja_id": g, "lote_id": l["lote_id"], "lote": l["codigo"],
                     "peso": peso, "n": n})



        if accion == "registrar_muerte":
            l = _lote(con, g, a.get("lote"))
            cant = _ent(a.get("cantidad"), "la cantidad")
            if cant <= 0:
                raise ErrorUsuario("La cantidad de muertes debe ser mayor que cero.")
            if cant > l["vivos"]:
                raise ErrorUsuario(f"La poza {l['codigo']} solo tiene {l['vivos']} vivos.")
            causa = (a.get("causa") or "").strip()[:100] or None
            texto = f"{cant} muerte(s) en la poza {l['codigo']}"
            if causa:
                texto += f" (causa: {causa})"
            return texto, {"granja_id": g, "lote_id": l["lote_id"], "lote": l["codigo"],
                           "cantidad": cant, "causa": causa}



        if accion == "registrar_alimento":
            l = _lote(con, g, a.get("lote"))
            tipo = (a.get("tipo") or "").strip().lower()
            kg = _num(a.get("kg"), "los kilos")
            if tipo not in ("forraje", "balanceado"):
                raise ErrorUsuario("Dime si el alimento fue forraje o balanceado.")
            if not (0 < kg <= 500):
                raise ErrorUsuario("Los kilos de alimento no parecen correctos.")
            return (f"{kg:g} kg de {tipo} para la poza {l['codigo']}",
                    {"granja_id": g, "lote_id": l["lote_id"], "lote": l["codigo"],
                     "tipo": tipo, "kg": kg})



        if accion == "registrar_parto":
            vivos = _ent(a.get("nacidos_vivos"), "los nacidos vivos")
            muertos = _ent(a.get("nacidos_muertos") or 0, "los nacidos muertos")
            if not (0 <= vivos <= 15) or not (0 <= muertos <= 15) or vivos + muertos == 0:
                raise ErrorUsuario("La cantidad de crías no parece correcta.")
            hembra = (a.get("hembra") or "").strip().upper()
            poza = (a.get("poza") or "").strip().upper()
            if not hembra and not poza:
                raise ErrorUsuario("¿Qué hembra parió? Dime su arete (por ejemplo H003) o la ubicación.")
            sql = ("SELECT e.id AS empadre_id, an.arete, p.codigo AS poza FROM empadres e "
                   "JOIN animales an ON an.id = e.hembra_id JOIN pozas p ON p.id = e.poza_id "
                   "WHERE an.granja_id = %s AND e.estado = 'en_gestacion' AND ")
            if hembra:
                filas = con.execute(sql + "an.arete = %s", (g, hembra)).fetchall()
            else:
                filas = con.execute(sql + "p.codigo = %s", (g, poza)).fetchall()
            if not filas:
                if hembra:
                    raise ErrorUsuario(f"No encuentro la hembra '{hembra}' en gestación en esta granja. Verifica el arete o si está en gestación.")
                else:
                    raise ErrorUsuario(f"No encuentro la poza '{poza}' con una hembra en gestación en esta granja.")
            if len(filas) > 1:
                opciones = ", ".join(f["arete"] for f in filas)
                raise ErrorUsuario(f"Hay varias hembras en gestación ahí ({opciones}). ¿Cuál parió?")
            f = filas[0]
            return (f"parto de {f['arete']} (ubicación {f['poza']}): {vivos} vivos y {muertos} muertos",
                    {"granja_id": g, "empadre_id": f["empadre_id"], "hembra": f["arete"],
                     "poza": f["poza"], "vivos": vivos, "muertos": muertos})



    raise ErrorUsuario("Eso todavía no lo sé hacer.")


def ejecutar(u, accion, d):
    """Escribe en la base de datos (datos ya validados por preparar). Devuelve un detalle corto."""
    with db() as con:
        if accion == "registrar_peso":
            ant = con.execute(
                "SELECT peso_promedio_g FROM pesajes WHERE lote_id = %s ORDER BY fecha DESC, id DESC LIMIT 1",
                (d["lote_id"],),
            ).fetchone()
            con.execute(
                "INSERT INTO pesajes (lote_id, fecha, peso_promedio_g, animales_pesados) "
                "VALUES (%s, CURRENT_DATE, %s, %s)",
                (d["lote_id"], d["peso"], d["n"]),
            )
            _firestore_add("pesajes", {
                "granja_id": d["granja_id"], "lote": d["lote"], "fecha": _hoy_iso(),
                "peso_promedio_g": d["peso"], "animales_pesados": d["n"],
                "creado_en": _ahora_iso(),
            })
            _firestore_update_lote(d["lote"], d["granja_id"],
                                   campos={"ultimo_peso_g": d["peso"]})
            return f"Antes: {float(ant['peso_promedio_g']):g} g." if ant else ""



        if accion == "registrar_muerte":
            vivos = con.execute(
                "SELECT vivos FROM v_resumen_lotes WHERE lote_id = %s", (d["lote_id"],)
            ).fetchone()["vivos"]
            if d["cantidad"] > vivos:
                raise ErrorUsuario(f"Ya no se puede: la poza solo tiene {vivos} vivos.")
            con.execute(
                "INSERT INTO mortalidad (lote_id, fecha, cantidad, causa) VALUES (%s, CURRENT_DATE, %s, %s)",
                (d["lote_id"], d["cantidad"], d["causa"]),
            )
            _firestore_add("mortalidad", {
                "granja_id": d["granja_id"], "lote": d["lote"], "fecha": _hoy_iso(),
                "cantidad": d["cantidad"], "causa": d["causa"],
                "creado_en": _ahora_iso(),
            })
            _firestore_update_lote(d["lote"], d["granja_id"],
                                   incrementar={"vivos": -d["cantidad"],
                                               "muertos": d["cantidad"]})
            return f"Quedan {vivos - d['cantidad']} vivos."



        if accion == "registrar_alimento":
            con.execute(
                "INSERT INTO consumo_alimento (lote_id, fecha, tipo, kg) VALUES (%s, CURRENT_DATE, %s, %s)",
                (d["lote_id"], d["tipo"], d["kg"]),
            )
            _firestore_add("consumo_alimento", {
                "granja_id": d["granja_id"], "lote": d["lote"], "fecha": _hoy_iso(),
                "tipo": d["tipo"], "kg": d["kg"], "creado_en": _ahora_iso(),
            })
            _firestore_update_lote(d["lote"], d["granja_id"],
                                   incrementar={"alimento_kg": d["kg"]})
            return f"Total acumulado en {d['lote']}."


        if accion == "registrar_parto":
            e = con.execute("SELECT estado FROM empadres WHERE id = %s", (d["empadre_id"],)).fetchone()
            if not e or e["estado"] != "en_gestacion":
                raise ErrorUsuario("Ese parto ya estaba registrado.")
            con.execute(
                "INSERT INTO partos (empadre_id, fecha_parto, nacidos_vivos, nacidos_muertos) "
                "VALUES (%s, CURRENT_DATE, %s, %s)",
                (d["empadre_id"], d["vivos"], d["muertos"]),
            )
            con.execute("UPDATE empadres SET estado = 'parida' WHERE id = %s", (d["empadre_id"],))
            _firestore_add("partos", {
                "granja_id": d["granja_id"], "hembra": d["hembra"], "poza": d["poza"],
                "fecha": _hoy_iso(), "nacidos_vivos": d["vivos"],
                "nacidos_muertos": d["muertos"], "crias_actuales": d["vivos"],
                "destetado": d["vivos"] == 0,
                "fecha_destete_prevista": _en_dias_iso(16),
                "creado_en": _ahora_iso(),
            })
            _firestore_borrar_partos_proximos(d["hembra"], d["granja_id"])
            return "La hembra ya no aparece en partos próximos."


    raise ErrorUsuario("Eso todavía no lo sé hacer.")


def texto_partos(u):
    with db() as con:
        filas = con.execute(
            "SELECT hembra, poza, dias_restantes FROM v_partos_proximos "
            "WHERE granja_id = %s ORDER BY dias_restantes",
            (u["granja_id"],),
        ).fetchall()
    if not filas:
        return "No hay partos próximos en los siguientes 10 días."
    lineas = ["Partos próximos (10 días):"]
    for f in filas:
        d = f["dias_restantes"]
        cuando = "hoy" if d == 0 else (f"en {d} días" if d > 0 else f"atrasado {-d} días")
        lineas.append(f"{f['hembra']} · ubicación {f['poza']} · {cuando}")
    return "\n".join(lineas)


def texto_lote(u, codigo):
    codigo = (codigo or "").strip().upper()
    with db() as con:
        l = con.execute(
            "SELECT * FROM v_resumen_lotes WHERE granja_id = %s AND codigo = %s",
            (u["granja_id"], codigo),
        ).fetchone()
    if not l:
        return f"No encuentro la poza {codigo or '(sin código)'}."
    peso = f"{float(l['ultimo_peso_g']):g} g" if l["ultimo_peso_g"] else "sin pesajes"
    mort = f"{float(l['mortalidad_pct']):g} %" if l["mortalidad_pct"] is not None else "s/d"
    alim = f"{float(l['alimento_kg']):g} kg" if l["alimento_kg"] is not None else "s/d"
    return (
        f"Poza {l['codigo']} ({l['etapa']}, {l['estado']})\n"
        f"Vivos: {l['vivos']} de {l['cantidad_inicial']}\n"
        f"Mortalidad: {mort}\n"
        f"Alimento total: {alim}\n"
        f"Último peso: {peso}"
    )


def generar_alertas():
    """Crea las alertas del día (función SQL generar_alertas).
    Devuelve cuántas se crearon."""
    with db() as con:
        return con.execute("SELECT generar_alertas() AS n").fetchone()["n"]


def alertas_pendientes(granja_id):
    with db() as con:
        return con.execute(
            "SELECT id, mensaje FROM alertas "
            "WHERE granja_id = %s AND NOT enviada ORDER BY id",
            (granja_id,),
        ).fetchall()


def marcar_alertas_enviadas(ids):
    if not ids:
        return
    with db() as con:
        con.execute(
            "UPDATE alertas SET enviada = TRUE, enviada_en = now(), estado = 'enviado' "
            "WHERE id = ANY(%s) AND estado = 'pendiente'",
            (list(ids),),
        )


def texto_alertas(u):
    """Avisos pendientes de la granja (genera los de hoy, sin marcarlos)."""
    generar_alertas()
    filas = alertas_pendientes(u["granja_id"])
    if not filas:
        return "No tienes avisos pendientes."
    return "Avisos pendientes:\n" + "\n".join(f"- {f['mensaje']}" for f in filas)


def texto_retiros(u):
    """Pozas en retiro sanitario (no vender todavía)."""
    with db() as con:
        filas = con.execute(
            "SELECT lote, poza, producto, tipo, dias_restantes FROM v_en_retiro "
            "WHERE granja_id = %s ORDER BY fecha_fin_retiro",
            (u["granja_id"],),
        ).fetchall()
    if not filas:
        return "Nada en retiro sanitario: se puede vender con normalidad."
    lineas = ["En retiro sanitario (no vender todavía):"]
    for f in filas:
        que = f["lote"] or f["poza"] or ""
        d = f["dias_restantes"]
        queda = "queda 1 día" if d == 1 else f"quedan {d} días"
        lineas.append(f"{que} · {f['producto'] or f['tipo']} · {queda}")
    return "\n".join(lineas)


def sincronizar(coleccion, datos):
    """Copia un movimiento a Firestore (para el panel de monitoreo)."""
    return _firestore_add(coleccion, datos)


def actualizar_lote_firestore(codigo, granja_id, campos=None, incrementar=None):
    return _firestore_update_lote(codigo, granja_id, campos, incrementar)


def crear_lote_firestore(codigo, granja_id, datos):
    """Crea (o actualiza) el documento del lote con el ID que usa el panel."""
    if not _firebase_initialized:
        return False
    codigo = (codigo or "").strip().upper()
    if not codigo:
        return False
    try:
        ref = _firestore_lote_ref(codigo, granja_id)
        if ref is None:
            ref = db_firestore.collection("lotes").document(f"g{granja_id}_{codigo}")
            ref.set(datos)
        else:
            ref.update(datos)
        return True
    except Exception as e:
        print(f"Aviso: no se pudo crear el lote {codigo} en Firestore: {e}")
        return False


def quitar_parto_programado(hembra, granja_id):
    _firestore_borrar_partos_proximos(hembra, granja_id)


def borrar_lote_firestore(codigo, granja_id):
    """Elimina el documento de un lote en Firestore (si existe)."""
    ref = _firestore_lote_ref(codigo, granja_id)
    if ref is None:
        return False
    try:
        ref.delete()
        return True
    except Exception as e:
        print(f"Aviso: no se pudo borrar el lote {codigo} en Firestore: {e}")
        return False


def texto_lotes(u, codigos=None):
    """Resumen corto de varios lotes abiertos (o todos si no se indican)."""
    with db() as con:
        filas = con.execute(
            "SELECT codigo, etapa, estado, vivos, cantidad_inicial, ultimo_peso_g "
            "FROM v_resumen_lotes WHERE granja_id = %s AND estado = 'abierto' ORDER BY codigo",
            (u["granja_id"],),
        ).fetchall()
    pedidos = {(c or "").strip().upper() for c in (codigos or []) if c}
    if pedidos:
        filas = [f for f in filas if f["codigo"] in pedidos]
        faltan = pedidos - {f["codigo"] for f in filas}
    else:
        faltan = set()
    if not filas:
        return "No encuentro esas pozas abiertas."
    lineas = []
    for f in filas:
        peso = f"{float(f['ultimo_peso_g']):g} g" if f["ultimo_peso_g"] else "s/p"
        lineas.append(f"{f['codigo']}: {f['vivos']}/{f['cantidad_inicial']} vivos · {peso}")
    if faltan:
        lineas.append("No existen: " + ", ".join(sorted(faltan)) + ".")
    return "\n".join(lineas)