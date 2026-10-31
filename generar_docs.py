# -*- coding: utf-8 -*-
"""Genera los dos documentos de CuyMax conservando la identidad visual original.

Usa el .docx original como plantilla (estilos, tema, pie de página y tamaño A4)
y reconstruye el cuerpo desde cero para eliminar párrafos duplicados.
"""
import os
import re
import sys

sys.stdout.reconfigure(encoding="utf-8")

import docx
from docx.shared import Pt, Cm, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.oxml.ns import qn
from docx.oxml import OxmlElement

DOCS = r"C:\Users\Admin\Desktop\CUYMAX-WEB\docs"
SHOTS = os.path.join(os.environ.get("TEMP", r"C:\Users\Admin\AppData\Local\Temp"), "cm-shots", "out")

MARRON = "754B2E"
GRIS = "595959"
CREMA = "F6F1EA"

TOKEN = re.compile(r"(\*\*.+?\*\*|`.+?`)")


# ---------------------------------------------------------------- utilidades

def _runs(p, texto, size=None, color=None, bold=False, italic=False):
    """Escribe texto admitiendo **negrita** y `código`."""
    for tok in TOKEN.split(texto):
        if not tok:
            continue
        if tok.startswith("**") and tok.endswith("**") and len(tok) > 4:
            r = p.add_run(tok[2:-2])
            r.bold = True
        elif tok.startswith("`") and tok.endswith("`") and len(tok) > 2:
            r = p.add_run(tok[1:-1])
            r.font.name = "Consolas"
            r.font.size = Pt((size or 11) - 1)
            r.bold = bold
        else:
            r = p.add_run(tok)
            r.bold = bold
        if size and not (tok.startswith("`") and tok.endswith("`")):
            r.font.size = Pt(size)
        if color:
            r.font.color.rgb = RGBColor.from_string(color)
        if italic:
            r.italic = True


def limpiar(doc):
    """Quita todo el cuerpo dejando solo el sectPr (tamaño, márgenes, pie)."""
    body = doc.element.body
    for hijo in list(body):
        if hijo.tag == qn("w:sectPr"):
            continue
        body.remove(hijo)


def par(doc, texto="", style=None, align=None, size=None, color=None,
        bold=False, italic=False, antes=None, despues=None, keep=False):
    p = doc.add_paragraph(style=style)
    if texto:
        _runs(p, texto, size=size, color=color, bold=bold, italic=italic)
    if align is not None:
        p.alignment = align
    pf = p.paragraph_format
    if antes is not None:
        pf.space_before = Pt(antes)
    if despues is not None:
        pf.space_after = Pt(despues)
    if keep:
        pf.keep_with_next = True
    return p


def h1(doc, texto):
    return par(doc, texto, style="Heading 1", keep=True)


def h2(doc, texto):
    return par(doc, texto, style="Heading 2", keep=True)


def cuerpo(doc, texto):
    return par(doc, texto, align=WD_ALIGN_PARAGRAPH.JUSTIFY)


def vinetas(doc, items):
    for it in items:
        par(doc, it, style="List Bullet", align=WD_ALIGN_PARAGRAPH.LEFT)


def _nueva_num(doc, abstract_id=7):
    """Crea una numeración nueva para que cada lista vuelva a empezar en 1."""
    numbering = doc.part.numbering_part.element
    ids = [int(n.get(qn("w:numId"))) for n in numbering.findall(qn("w:num"))]
    nuevo = max(ids) + 1
    num = OxmlElement("w:num")
    num.set(qn("w:numId"), str(nuevo))
    abs_el = OxmlElement("w:abstractNumId")
    abs_el.set(qn("w:val"), str(abstract_id))
    num.append(abs_el)
    ov = OxmlElement("w:lvlOverride")
    ov.set(qn("w:ilvl"), "0")
    so = OxmlElement("w:startOverride")
    so.set(qn("w:val"), "1")
    ov.append(so)
    num.append(ov)
    numbering.append(num)
    return nuevo


def numerada(doc, items):
    num_id = _nueva_num(doc)
    for it in items:
        p = doc.add_paragraph(style="List Number")
        pPr = p._p.get_or_add_pPr()
        numPr = OxmlElement("w:numPr")
        ilvl = OxmlElement("w:ilvl")
        ilvl.set(qn("w:val"), "0")
        numId = OxmlElement("w:numId")
        numId.set(qn("w:val"), str(num_id))
        numPr.append(ilvl)
        numPr.append(numId)
        pPr.append(numPr)
        _runs(p, it)
        p.alignment = WD_ALIGN_PARAGRAPH.LEFT


def _sombrear(cell, color):
    tcPr = cell._tc.get_or_add_tcPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:color"), "auto")
    shd.set(qn("w:fill"), color)
    tcPr.append(shd)


def _preparar_tabla(tabla, ancho_twips, arriba=60, izq=110):
    """Ancho total y márgenes de celda, respetando el orden del esquema OOXML.

    `tabla.autofit = False` ya crea `w:tblLayout type="fixed"`, así que aquí
    solo se ajusta el ancho y se añaden los márgenes.
    """
    tblPr = tabla._tbl.tblPr

    tblW = tblPr.find(qn("w:tblW"))
    if tblW is None:
        tblW = OxmlElement("w:tblW")
        tblPr.insert_element_before(tblW, "w:jc", "w:tblCellSpacing", "w:tblInd",
                                    "w:tblBorders", "w:shd", "w:tblLayout",
                                    "w:tblCellMar", "w:tblLook")
    tblW.set(qn("w:w"), str(ancho_twips))
    tblW.set(qn("w:type"), "dxa")

    for viejo in tblPr.findall(qn("w:tblCellMar")):
        tblPr.remove(viejo)
    mar = OxmlElement("w:tblCellMar")
    for lado, val in (("top", arriba), ("left", izq), ("bottom", arriba), ("right", izq)):
        el = OxmlElement("w:" + lado)
        el.set(qn("w:w"), str(val))
        el.set(qn("w:type"), "dxa")
        mar.append(el)
    tblPr.insert_element_before(mar, "w:tblLook", "w:tblCaption", "w:tblDescription")


def tabla(doc, cabeceras, filas, anchos, size=9.5):
    t = doc.add_table(rows=1, cols=len(cabeceras))
    t.style = "Table Grid"
    t.alignment = WD_TABLE_ALIGNMENT.CENTER
    t.autofit = False
    _preparar_tabla(t, int(round(sum(anchos) / 2.54 * 1440)))

    for i, ancho in enumerate(anchos):
        t.columns[i].width = Cm(ancho)

    # Encabezado
    hdr = t.rows[0]
    trPr = hdr._tr.get_or_add_trPr()
    th = OxmlElement("w:tblHeader")
    trPr.append(th)
    for i, texto in enumerate(cabeceras):
        c = hdr.cells[i]
        c.width = Cm(anchos[i])
        _sombrear(c, MARRON)
        p = c.paragraphs[0]
        p.paragraph_format.space_after = Pt(0)
        p.paragraph_format.space_before = Pt(0)
        r = p.add_run(texto)
        r.bold = True
        r.font.size = Pt(size)
        r.font.color.rgb = RGBColor.from_string("FFFFFF")

    # Cuerpo
    for fila in filas:
        row = t.add_row()
        for i, texto in enumerate(fila):
            c = row.cells[i]
            c.width = Cm(anchos[i])
            p = c.paragraphs[0]
            p.paragraph_format.space_after = Pt(0)
            p.paragraph_format.space_before = Pt(0)
            _runs(p, texto, size=size)
    return t


FIG_N = {"n": 0}


def figura(doc, archivo, leyenda, ancho_cm=15.4):
    # Prefiere la versión optimizada (JPEG) si existe.
    opt = os.path.join(os.path.dirname(SHOTS), "opt", archivo.replace(".png", ".jpg"))
    ruta = opt if os.path.exists(opt) else os.path.join(SHOTS, archivo)
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p.paragraph_format.space_before = Pt(10)
    p.paragraph_format.space_after = Pt(3)
    p.paragraph_format.keep_with_next = True
    p.add_run().add_picture(ruta, width=Cm(ancho_cm))

    FIG_N["n"] += 1
    c = doc.add_paragraph()
    c.alignment = WD_ALIGN_PARAGRAPH.CENTER
    c.paragraph_format.space_after = Pt(14)
    r = c.add_run("Figura %d. %s" % (FIG_N["n"], leyenda))
    r.font.size = Pt(9)
    r.font.color.rgb = RGBColor.from_string(GRIS)
    r.italic = True


def salto(doc):
    p = doc.add_paragraph()
    p.paragraph_format.space_after = Pt(0)
    p.add_run().add_break(WD_BREAK.PAGE)


def portada(doc, titulo):
    for _ in range(5):
        par(doc, "", despues=10)
    par(doc, "CUYMAX", align=WD_ALIGN_PARAGRAPH.CENTER, size=34, color=MARRON, bold=True)
    par(doc, "Sistema web de gestión de granjas de cuyes",
        align=WD_ALIGN_PARAGRAPH.CENTER, size=13, color=GRIS)
    for _ in range(6):
        par(doc, "", despues=10)
    par(doc, titulo, align=WD_ALIGN_PARAGRAPH.CENTER, size=20, bold=True)
    for _ in range(7):
        par(doc, "", despues=10)
    par(doc, "Autor: Rogger Gonzales", align=WD_ALIGN_PARAGRAPH.CENTER, size=12)
    par(doc, "Proyecto: DC PROJECTS", align=WD_ALIGN_PARAGRAPH.CENTER, size=12)
    par(doc, "Octubre de 2026", align=WD_ALIGN_PARAGRAPH.CENTER, size=12)


def contenido(doc, secciones):
    h1(doc, "Contenido")
    for s in secciones:
        p = par(doc, s, despues=4)
        p.paragraph_format.left_indent = Cm(0.5)
    salto(doc)


NOMBRES = {
    "Documentaci": "Documentación del Sistema.docx",
    "Manual": "Manual de Usuario.docx",
}


def pie(doc, titulo):
    """Pie de página con el nombre del documento y el número de página."""
    p = doc.sections[0].footer.paragraphs[0]
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    r = p.add_run(titulo + "   ·   página ")
    r.font.size = Pt(8.5)
    r.font.color.rgb = RGBColor.from_string(GRIS)
    fld = OxmlElement("w:fldSimple")
    fld.set(qn("w:instr"), "PAGE")
    run = OxmlElement("w:r")
    rPr = OxmlElement("w:rPr")
    sz = OxmlElement("w:sz")
    sz.set(qn("w:val"), "17")
    col = OxmlElement("w:color")
    col.set(qn("w:val"), GRIS)
    rPr.append(sz)
    rPr.append(col)
    run.append(rPr)
    t = OxmlElement("w:t")
    t.text = "1"
    run.append(t)
    fld.append(run)
    p._p.append(fld)


def abrir_plantilla(nombre_busqueda):
    """Los .docx originales se perdieron al vaciarse la carpeta del proyecto, así
    que la plantilla se arma aquí: A4, márgenes de 2,5 cm, la tipografía y los
    colores de CuyMax, y pie de página con el nombre del documento."""
    os.makedirs(DOCS, exist_ok=True)
    d = docx.Document()
    sec = d.sections[0]
    sec.page_width, sec.page_height = Cm(21), Cm(29.7)
    sec.top_margin = sec.bottom_margin = Cm(2.5)
    sec.left_margin = sec.right_margin = Cm(2.5)

    normal = d.styles["Normal"]
    normal.font.name = "Calibri"
    normal.font.size = Pt(11)
    normal.paragraph_format.space_after = Pt(6)
    normal.paragraph_format.line_spacing = 1.15

    h1s = d.styles["Heading 1"]
    h1s.font.name = "Calibri"
    h1s.font.size = Pt(15)
    h1s.font.bold = True
    h1s.font.color.rgb = RGBColor.from_string(MARRON)
    h1s.paragraph_format.space_before = Pt(18)
    h1s.paragraph_format.space_after = Pt(8)
    h1s.paragraph_format.keep_with_next = True

    h2s = d.styles["Heading 2"]
    h2s.font.name = "Calibri"
    h2s.font.size = Pt(12.5)
    h2s.font.bold = True
    h2s.font.color.rgb = RGBColor.from_string("0B7A5A")
    h2s.paragraph_format.space_before = Pt(12)
    h2s.paragraph_format.space_after = Pt(6)
    h2s.paragraph_format.keep_with_next = True

    nombre = NOMBRES.get(nombre_busqueda, nombre_busqueda + ".docx")
    pie(d, nombre.replace(".docx", ""))
    return d, os.path.join(DOCS, nombre)


# ------------------------------------------------------- DOCUMENTO DEL SISTEMA

def build_sistema():
    doc, ruta = abrir_plantilla("Documentaci")
    FIG_N["n"] = 0
    portada(doc, "Documentación del Sistema")
    salto(doc)

    contenido(doc, [
        "1. Introducción",
        "2. Descripción general",
        "3. Tecnologías utilizadas",
        "4. Arquitectura y flujo de datos",
        "5. Estructura del proyecto",
        "6. Base de datos",
        "7. API del sistema",
        "8. Seguridad",
        "9. Etiquetas NFC",
        "10. Instalación y despliegue",
        "11. Estado actual y pendientes",
    ])

    # ---- 1
    h1(doc, "1. Introducción")
    cuerpo(doc, "Este documento describe el funcionamiento de CuyMax Web, la versión web del sistema de gestión de granjas de cuyes del proyecto CuyMax (DC PROJECTS).")
    cuerpo(doc, "Explica qué hace el sistema, con qué tecnologías está construido, cómo está organizado internamente, cómo protege la información de cada granja y cómo se instala y se despliega. Está dirigido a las personas que le darán mantenimiento o continuidad al proyecto.")
    cuerpo(doc, "La información corresponde al estado del sistema en octubre de 2026 e incluye los cambios de la última versión: el asistente de IA como ventana flotante, las etiquetas NFC para abrir la ficha de una poza, el aislamiento de datos por granja, el servicio de IA alojado en la nube y la instalación del panel como aplicación, con trabajo sin conexión.")

    # ---- 2
    h1(doc, "2. Descripción general")
    cuerpo(doc, "CuyMax Web es una aplicación web para registrar y controlar la producción de una granja de cuyes. Se compone de una página pública (landing), una pantalla de acceso y un panel de trabajo con cinco secciones: Panel, Poza, Registrar, Avisos y Últimos registros. El asistente de IA no ocupa una sección propia: se abre como una ventana flotante desde cualquier pantalla del panel.")
    cuerpo(doc, "La información se guarda en Cloud Firestore cuando el panel trabaja con datos reales en la nube, o en PostgreSQL a través de la API propia cuando se usa la versión local. En ambos casos la lógica de validación es la misma.")

    h2(doc, "2.1 Módulos principales")
    vinetas(doc, [
        "**Landing pública:** presenta el sistema y da acceso al panel.",
        "**Acceso:** registro e inicio de sesión con Firebase Authentication (correo y contraseña).",
        "**Panel general:** indicadores de la granja, evolución de la población e ingresos, nacimientos y salidas, partos próximos y estado de las pozas.",
        "**Ficha de poza:** estado productivo, curva de peso, economía, acciones rápidas de registro y etiqueta NFC de la poza.",
        "**Registrar:** selector con diez movimientos de campo (peso, muerte, alimento, parto, programar parto, destete, ingreso por compra, venta, faena y retiro sanitario).",
        "**Avisos:** alertas de trabajo (parto próximo, destete, pesaje pendiente, retiro sanitario).",
        "**Últimos registros:** historial de movimientos con borrado y confirmación.",
        "**Asistente flotante:** chat que interpreta mensajes en lenguaje natural, responde consultas y prepara registros para confirmar. Se abre con el botón flotante o con Ctrl + K (⌘ + K en Mac).",
        "**Etiquetas NFC:** cada poza puede llevar una etiqueta que abre su ficha al acercar el teléfono.",
        "**Aplicación instalable:** el panel se instala en el celular con su propio ícono y sigue funcionando sin señal; los registros se guardan en el teléfono y se suben al volver la conexión.",
        "**Avisos al celular:** con las notificaciones activadas, el sistema avisa cada día a la hora elegida si hay trabajo pendiente (partos próximos, destetes, pesajes o retiros).",
        "**Worker de IA:** servicio en Cloudflare que valida la sesión y conversa con Groq sin exponer la clave.",
        "**API local:** servicio FastAPI que valida y guarda la información en PostgreSQL, con la misma lógica que usa el bot.",
        "**Modo demo:** el panel funciona con datos de ejemplo, sin sesión y sin guardar nada, para mostraciones y pruebas.",
    ])

    h2(doc, "2.2 Modos de funcionamiento")
    cuerpo(doc, "El panel elige su fuente de datos según la dirección con la que se abre. Los tres modos son excluyentes:")
    tabla(doc,
          ["Modo", "Cómo se abre", "Dónde guarda", "Asistente"],
          [
              ["Demo", "Botón «Probar Demo» o `app/?modo=demo`", "Datos de ejemplo en memoria; no guarda nada", "Desactivado (explica cómo se usa)"],
              ["Datos reales", "Botón «Monitorear» o `app/?modo=real`, con sesión iniciada", "Cloud Firestore, aislado por granja", "Activo, a través del Worker"],
              ["Local", "`iniciar.bat` en la computadora de la granja", "PostgreSQL, mediante la API", "Activo, con el servidor local"],
          ],
          [2.6, 4.9, 4.6, 4.1])
    par(doc, "", despues=6)
    cuerpo(doc, "En la web publicada el modo de datos reales exige haber iniciado sesión; sin sesión, el panel entra en modo demo aunque no se indique el parámetro en la dirección.")
    figura(doc, "panel.png", "Aspecto del panel general en modo demo.", 15.0)

    # ---- 3
    h1(doc, "3. Tecnologías utilizadas")
    cuerpo(doc, "La siguiente tabla resume las capas del sistema y la tecnología usada en cada una.")
    tabla(doc,
          ["Capa", "Tecnología", "Uso"],
          [
              ["Frontend", "HTML, CSS y JavaScript", "Interfaz de la landing y del panel"],
              ["Gráficas", "Chart.js (incluida en el proyecto)", "Curvas y tendencias del panel"],
              ["Aplicación móvil", "PWA con service worker y manifiesto", "Instalación en el celular, trabajo sin conexión y caché de archivos"],
              ["Acceso de usuarios", "Firebase Authentication", "Registro e inicio de sesión (correo y contraseña)"],
              ["Base de datos (nube)", "Cloud Firestore (plan Spark)", "Datos reales compartidos en la nube"],
              ["Caché sin conexión", "Persistencia local de Firestore", "Guarda los registros hechos sin señal y los envía al volver la conexión"],
              ["Reglas de datos", "`firestore.rules`", "Aíslan los datos de cada granja"],
              ["Capa de datos (nube)", "`app/firestore-data.js`", "Traduce las peticiones del panel a Firestore"],
              ["Servidor (API local)", "Python 3.12, FastAPI y Uvicorn", "Servicio en el puerto 8000"],
              ["Base de datos (local)", "PostgreSQL 18", "Almacenamiento en la versión local"],
              ["Conexión a la base", "psycopg 3", "Consultas desde el servidor"],
              ["Asistente IA", "Cloudflare Workers", "Puente seguro entre el panel y Groq"],
              ["Avisos al celular", "Web Push (VAPID) y Cloudflare KV", "Notificación diaria con el trabajo pendiente"],
              ["Modelo de lenguaje", "Groq: `openai/gpt-oss-120b` (reserva: `openai/gpt-oss-20b`)", "Interpretar los mensajes del asistente"],
              ["Etiquetas NFC", "Web NFC (NDEFReader) y NFC Tools", "Abrir la ficha de una poza al acercar el teléfono"],
              ["Publicación", "Firebase Hosting", "Landing y panel publicados"],
          ],
          [3.5, 5.9, 6.8])
    par(doc, "", despues=8)
    cuerpo(doc, "Se eligió JavaScript sin frameworks para mantener el panel liviano y fácil de abrir incluso desde equipos modestos. La API reutiliza la lógica del bot, de manera que las validaciones son exactamente las mismas sin importar el canal por el que se registre la información.")

    # ---- 4
    h1(doc, "4. Arquitectura y flujo de datos")
    cuerpo(doc, "Desde el navegador, la persona inicia sesión con Firebase Authentication. En la versión local, una vez autenticada, el panel consulta y envía datos a la API hecha con FastAPI, que valida todo y escribe en PostgreSQL. En el modo de datos reales el panel habla directamente con Cloud Firestore desde el navegador, a través del archivo `app/firestore-data.js`, que responde con las mismas estructuras de datos que la API.")

    h2(doc, "4.1 Versión publicada")
    cuerpo(doc, "Se publica en Firebase Hosting y ofrece dos accesos desde la landing: «Probar Demo» abre el panel con datos de ejemplo, y «Monitorear» abre el panel con datos reales. El modo se elige por la dirección (`app/?modo=real`), de modo que la demostración pública no cambia.")

    h2(doc, "4.2 Capa de datos en la nube")
    cuerpo(doc, "El archivo `app/firestore-data.js` traduce cada petición del panel a operaciones de Firestore: crea y actualiza las pozas, registra los movimientos y calcula los resúmenes. Cada documento guarda la granja a la que pertenece (`granja_id`), de manera que los datos de varias granjas no se mezclen.")

    h2(doc, "4.3 El Worker de IA")
    cuerpo(doc, "El asistente no se comunica directamente con el proveedor de inteligencia artificial. El panel envía el mensaje al Worker de Cloudflare (`https://cuymax-ia.cuymax.workers.dev/asistente`) junto con el token de la sesión en la cabecera `Authorization`. El Worker hace, en este orden:")
    numerada(doc, [
        "Comprueba que el origen de la petición esté en la lista de orígenes permitidos.",
        "Valida el token del usuario contra Firebase.",
        "Aplica un límite de 30 consultas cada 5 minutos por usuario.",
        "Envía el mensaje y el contexto de la granja al modelo de Groq.",
        "Devuelve la acción interpretada, lista para que el panel la confirme.",
    ])
    par(doc, "", despues=4)
    cuerpo(doc, "El modelo principal es `openai/gpt-oss-120b`. Si el proveedor responde que se agotó el cupo (error 429), el Worker reintenta con el modelo de reserva `openai/gpt-oss-20b`, cuyos límites son independientes.")
    cuerpo(doc, "La clave de Groq se guarda como secreto del Worker y nunca llega al navegador. La IA tampoco escribe: devuelve una propuesta y el panel la guarda solo cuando la persona la confirma.")

    h2(doc, "4.4 Service worker y caché")
    cuerpo(doc, "El panel incluye un service worker (`app/sw.js`) que se instala la primera vez que se abre la página y guarda una copia de los archivos necesarios para arrancar: el HTML del panel, sus hojas de estilo y sus guiones, las gráficas, el manifiesto, los íconos, el SDK de Firebase y las tipografías. Esa lista se declara en la constante `SHELL`.")
    cuerpo(doc, "Los archivos que no forman parte del arranque se guardan la primera vez que se piden: el service worker los copia a la caché mientras los entrega y, a partir de ahí, los sirve desde el teléfono. Así la imagen de fondo del panel no deja un hueco cuando no hay señal.")
    cuerpo(doc, "El SDK de Firebase y las tipografías se sirven desde el propio dominio (`app/vendor/`) y no desde los servidores de Google. Esa fue una decisión de diseño: mientras se cargaban desde fuera, sin internet el panel quedaba en blanco, porque el código que dibuja la pantalla nunca llegaba a ejecutarse.")
    cuerpo(doc, "La versión de la caché se controla con la constante `CACHE` de `app/sw.js` y con el parámetro `?v=` de cada archivo en `app/index.html`; ambos deben subir juntos en cada despliegue. Si no coinciden, el service worker guarda una dirección distinta de la que pide la página y el teléfono sigue mostrando la versión anterior. La versión actual es la 49.")
    cuerpo(doc, "Cuando se publica una versión nueva, el service worker se instala en segundo plano y toma el control. La pestaña que ya estaba abierta, en cambio, continúa con el código anterior hasta que se recarga: por eso el panel muestra el botón «Versión nueva · Actualizar» en la tarjeta de la izquierda, que recarga la página cuando la persona lo pulsa.")

    h2(doc, "4.5 Instalación como aplicación")
    cuerpo(doc, "El panel se puede instalar en el celular y en la computadora como una aplicación, sin pasar por una tienda. La ficha de instalación la describe `app/manifiesto.webmanifest`, que declara el nombre, el idioma (`es-PE`), el color del tema, el modo de visualización y los íconos.")
    cuerpo(doc, "El manifiesto usa `display_override` para pedir una ventana propia (`standalone`) y, si el sistema no la admite, cae en `minimal-ui`. Los íconos se publican en dos variantes: normales, de 192 y 512 píxeles, y «maskable», con el dibujo reducido y un margen de seguridad, porque Android recorta el ícono con la forma que tenga el lanzador (círculo, cuadrado redondeado o gota). Se incluye además un ícono de 180 píxeles para la pantalla de inicio de iPhone.")
    cuerpo(doc, "El manifiesto declara tres atajos que aparecen al mantener pulsado el ícono de la aplicación: Registrar movimiento, Avisos del día y Panel general. Cada atajo es una dirección con el parámetro `tab`; el panel lo lee al arrancar y abre esa sección.")
    cuerpo(doc, "En Android y en las computadoras, el navegador avisa con el evento `beforeinstallprompt` cuando la aplicación cumple los requisitos de instalación. El panel lo escucha y muestra el botón «Instalar app» en la tarjeta de la izquierda; al pulsarlo se abre el diálogo del sistema. En iPhone ese evento no existe, así que el botón se muestra siempre y explica la ruta manual: Compartir → Añadir a pantalla de inicio.")
    cuerpo(doc, "En el celular esa tarjeta está oculta, porque el menú sube a la parte superior para dejar sitio al contenido. Por eso, cuando alguien llega desde el botón de descarga del sitio web (`?instalar=1`), el panel muestra un aviso propio debajo de la barra superior, con el mismo botón conectado al mismo diálogo del sistema. En iPhone el aviso cambia el botón por los tres pasos de Compartir. Se cierra con una X, no vuelve a aparecer en esa sesión y no se muestra si la aplicación ya está instalada.")
    cuerpo(doc, "El botón se oculta cuando la aplicación ya está abierta como instalada (`display-mode: standalone`) o después de instalarla, para no ofrecer algo que ya está hecho.")
    figura(doc, "instalar-aviso-crop.png", "Aviso de instalación que aparece en el celular al llegar desde el botón de descarga.", 9.2)

    h2(doc, "4.6 Trabajo sin conexión")
    cuerpo(doc, "Además de abrir sin internet, el panel permite registrar sin conexión. Al arrancar, la capa de datos activa la persistencia local de Firestore (`enablePersistence`, con `synchronizeTabs`), que mantiene una copia de los documentos en el teléfono y encola las escrituras.")
    cuerpo(doc, "Con la señal cortada, los formularios siguen funcionando contra esa copia: el movimiento se guarda en el teléfono y queda pendiente. Cuando vuelve la conexión, Firestore envía la cola en orden y el panel la refleja. La opción `synchronizeTabs` hace que todas las pestañas abiertas compartan la misma caché, para que una no pise lo que escribió la otra.")
    cuerpo(doc, "El panel avisa del estado con una insignia ámbar «Sin conexión» en la barra superior, y con dos mensajes breves al cambiar de estado: uno al perder la conexión y otro al recuperarla. Si una consulta no se puede resolver con lo que hay guardado en el teléfono, el panel muestra el error en lugar de cifras incompletas.")
    cuerpo(doc, "El estado no se deduce solo de lo que dice el navegador. Cada lectura informa de si el resultado vino del servidor o de la copia guardada en el teléfono, y de ahí sale el aviso; si una consulta falla porque no se pudo alcanzar el servidor, también cuenta. Así se detecta el caso de un wifi sin internet, en el que el navegador sigue creyendo que hay conexión.")
    cuerpo(doc, "Lo que no funciona sin conexión es el asistente de IA, porque interpreta los mensajes en un servicio en línea. Tampoco se puede instalar la aplicación ni cambiar la contraseña sin red.")

    h2(doc, "4.7 Notificaciones al celular")
    cuerpo(doc, "Desde Ajustes se pueden activar las notificaciones. El navegador pide permiso, el panel se suscribe al servicio de push del sistema y guarda la suscripción en el Worker, junto con dos datos más: la hora del día en que se quiere recibir el aviso y un resumen del trabajo pendiente. El resumen lo escribe el propio panel cada vez que carga los avisos (partos próximos, destetes, pesajes pendientes y retiros), como mucho una vez cada seis horas.")
    cuerpo(doc, "El Worker tiene un trabajo programado que corre cada hora: revisa las suscripciones guardadas y avisa solo a quienes pidieron esa hora y tienen algo pendiente. Si no hay nada, no se manda nada; por eso el aviso, cuando llega, siempre tiene contenido.")
    cuerpo(doc, "El envío usa el estándar Web Push: el mensaje va firmado con la pareja de claves VAPID (la pública viaja en la configuración del panel; la privada es un secreto del Worker) y cifrado con las claves de cada suscripción, de modo que ni el servicio de push puede leer el texto. La suscripción se guarda sin datos de la granja, solo con el identificador de la cuenta, y se puede desactivar desde Ajustes en cualquier momento.")
    cuerpo(doc, "El botón «Enviar una prueba» manda un aviso inmediato, para comprobar que el celular está conectado. En iPhone hace falta tener la aplicación instalada en la pantalla de inicio (iOS 16.4 o superior); en Android basta el navegador.")

    h2(doc, "4.8 La descarga desde el sitio web")
    cuerpo(doc, "La página principal tiene una sección «Descarga la App» con dos tarjetas, una para Android y otra para iPhone. Las dos apuntan al mismo destino: `app/?modo=demo&instalar=1`. No hay ningún archivo que descargar; lo que hace ese enlace es abrir la demostración —para que la persona vea el panel antes de crear su cuenta— y pedirle al panel que muestre el aviso de instalación.")
    cuerpo(doc, "Los pasos escritos en cada tarjeta son distintos porque los sistemas también lo son: en Android basta confirmar el diálogo del navegador, mientras que en iPhone hay que usar el menú Compartir de Safari. En iPhone, además, la instalación es un requisito para recibir notificaciones (iOS 16.4 o superior).")
    cuerpo(doc, "Al abrir la aplicación instalada, el manifiesto indica la dirección `?modo=real`: el ícono no abre la demostración, sino el panel con la cuenta de la persona. Los datos de ejemplo no se copian a la instalación; la granja se crea vacía la primera vez que se entra, con el nombre «Mi granja», que luego se puede cambiar desde Ajustes.")
    figura(doc, "descarga-portada.png", "Sección de descarga de la página principal, con una tarjeta por sistema.", 15.4)

    # ---- 5
    h1(doc, "5. Estructura del proyecto")
    cuerpo(doc, "El código se organiza en carpetas por responsabilidad:")
    tabla(doc,
          ["Ruta", "Contenido"],
          [
              ["`index.html`, `landing.css`", "Landing pública"],
              ["`login.html`", "Pantalla de acceso (crear cuenta e iniciar sesión)"],
              ["`img/`", "Imágenes de la landing y capturas de pantalla"],
              ["`app/`", "Panel completo (HTML, CSS, JavaScript, gráficas y service worker)"],
              ["`app/app.js`", "Lógica del panel: pestañas, formularios, asistente flotante y etiquetas NFC"],
              ["`app/firestore-data.js`", "Capa de datos reales del modo en la nube"],
              ["`app/mock-data.js`", "Datos de ejemplo del modo demo"],
              ["`app/ia-asistente.js`", "Puente con el Worker de IA"],
              ["`app/manifiesto.webmanifest`", "Ficha de instalación: nombre, íconos, atajos y capturas"],
              ["`app/vendor/`", "SDK de Firebase y tipografías servidos desde el propio sitio (permiten abrir sin conexión)"],
              ["`app/icono-*.png`", "Íconos de la app instalada, incluidos los «maskable» de Android"],
              ["`app/capturas/`", "Capturas de pantalla que muestra la ficha de instalación"],
              ["`worker/`", "Worker de Cloudflare: conversa con Groq, guarda las suscripciones de notificaciones y envía los avisos al celular"],
              ["`server/`", "API en Python y lógica de negocio (`api.py`, `acciones.py`, `ia.py`)"],
              ["`iniciar.bat`", "Arranque local del sistema en Windows"],
              ["`firebase.json`, `.firebaserc`", "Configuración de Firebase Hosting"],
              ["`firebase-config.js`", "Configuración pública de Firebase y dirección del Worker"],
              ["`firestore.rules`", "Reglas de aislamiento por granja"],
              ["`docs/`", "Documentación y manuales (no se publica ni se versiona)"],
              ["`generar_docs.py`", "Genera los dos documentos de `docs/` a partir de su contenido"],
              ["`README.md`", "Guía rápida de instalación y despliegue"],
          ],
          [5.0, 11.2])

    # ---- 6
    h1(doc, "6. Base de datos")
    cuerpo(doc, "La versión local trabaja sobre PostgreSQL (base de nombre `cuyes`). Se consulta con SQL directo, sin ORM. Los resúmenes que necesita el panel están resueltos en vistas de la base y la generación de avisos en una función. El modo de datos reales trabaja sobre Cloud Firestore.")

    h2(doc, "6.1 PostgreSQL (versión local)")
    tabla(doc,
          ["Tabla", "Contenido"],
          [
              ["`granjas`, `galpones`, `pozas`", "Ubicación física de la granja"],
              ["`animales`", "Hembras y reproductores identificados por arete"],
              ["`empadres`", "Gestaciones en curso y terminadas"],
              ["`partos`", "Nacimientos registrados"],
              ["`lotes`", "Grupos de cuyes en producción"],
              ["`pesajes`", "Pesos promedio por lote y fecha"],
              ["`mortalidad`", "Bajas por lote, con causa opcional"],
              ["`consumo_alimento`", "Alimento entregado por lote (forraje o balanceado)"],
              ["`ventas` y `faenas`", "Salidas de cuyes de la granja"],
              ["`alertas`", "Avisos generados para el trabajo diario"],
              ["`usuarios`", "Cuentas del sistema, incluido el número de WhatsApp del bot"],
              ["`retiros_sanitarios`", "Medicamentos aplicados y fecha en que se puede volver a vender"],
          ],
          [5.6, 10.6])
    par(doc, "", despues=6)
    cuerpo(doc, "Vistas principales: `v_resumen_lotes` (resumen de cada lote), `v_partos_proximos`, `v_en_retiro` y `v_resumen_economico_lotes`. Función `generar_alertas()`, que crea los avisos del día.")

    h2(doc, "6.2 Cloud Firestore")
    cuerpo(doc, "Las colecciones son: `granjas` (nombre y precios), `lotes` (las pozas con sus contadores), `pozas`, `pesajes`, `mortalidad`, `consumo_alimento`, `partos`, `partos_proximos`, `destetes`, `ventas`, `faenas`, `retiros` y `avisos_atendidos`.")
    cuerpo(doc, "En la interfaz la unidad de trabajo se llama **poza**; en la base de datos la colección se llama `lotes`, por compatibilidad con la versión anterior del sistema.")

    h2(doc, "6.3 Aislamiento por granja")
    cuerpo(doc, "Cada cuenta de Firebase Authentication es una granja. Todos los documentos guardan el campo `granja_id` con el identificador de la cuenta dueña, y las reglas de `firestore.rules` exigen que coincida con la sesión:")
    vinetas(doc, [
        "Al leer, solo se devuelven documentos cuyo `granja_id` sea el de la cuenta.",
        "Al crear, el documento debe nacer con `granja_id` igual al de la cuenta.",
        "Al actualizar, no se puede cambiar de dueño.",
        "Al borrar, solo se puede borrar lo propio.",
    ])
    par(doc, "", despues=4)
    cuerpo(doc, "El resultado es que dos granjas pueden tener una poza con el mismo código (por ejemplo P-001) sin que sus datos se mezclen, y que nadie puede leer la información de otra cuenta aunque conozca el nombre de la colección o el identificador del documento.")

    # ---- 7
    h1(doc, "7. API del sistema")
    cuerpo(doc, "La API está hecha con FastAPI. Las consultas de lectura devuelven JSON y cada registro pasa por dos pasos: primero se valida y luego se escribe. Si algo no cuadra, responde con un mensaje claro para la persona (código 400).")
    cuerpo(doc, "Si en el archivo de configuración se define `API_TOKEN`, todas las rutas exigen la cabecera `X-API-Key`. Si no se define, la API queda abierta, pensada solo para desarrollo local.")
    tabla(doc,
          ["Método y ruta", "Para qué"],
          [
              ["`GET /salud`", "Verificar que el servidor responde"],
              ["`GET /api/partos-proximos`", "Hembras que paren en los próximos 10 días"],
              ["`GET /api/lotes`", "Resumen de todas las pozas"],
              ["`GET /api/lotes/{codigo}`", "Resumen de una poza"],
              ["`GET /api/lotes/{codigo}/pesajes`", "Historial de pesajes (curva de peso)"],
              ["`GET /api/resumen-economico`", "Economía por poza"],
              ["`GET /api/retiros`", "Pozas en retiro sanitario"],
              ["`GET /api/evolucion`", "Población e ingresos por semana"],
              ["`GET /api/nacimientos-salidas`", "Crías nacidas y ventas por mes"],
              ["`GET /api/alertas`", "Avisos de la granja"],
              ["`GET /api/pozas`", "Pozas disponibles"],
              ["`POST /api/pesajes`", "Registrar peso de una poza"],
              ["`POST /api/muertes`", "Registrar bajas"],
              ["`POST /api/alimento`", "Registrar alimento"],
              ["`POST /api/partos`", "Registrar parto"],
              ["`POST /api/ingresos`", "Sumar cuyes comprados a una poza"],
              ["`POST /api/lotes`", "Crear poza nueva"],
              ["`POST /api/alertas/{id}/atender`", "Marcar aviso como atendido"],
              ["`POST /api/alertas/generar`", "Generar los avisos del día"],
              ["`POST /api/interpretar`", "Interpretar texto libre con IA (bot)"],
              ["`POST /api/asistente`", "Interpretar un mensaje del asistente (consulta o propuesta)"],
              ["`POST /api/asistente/confirmar`", "Guardar un registro propuesto por el asistente"],
              ["`GET /api/registros`", "Últimos movimientos de la granja"],
              ["`DELETE /api/registros/{tipo}/{id}`", "Borrar un movimiento cargado por error"],
          ],
          [7.0, 9.2])
    par(doc, "", despues=6)
    cuerpo(doc, "En el modo de datos reales no interviene FastAPI: el panel envía las mismas peticiones (granja, partos-próximos, destetes, ventas, faenas, retiros, pesajes, muertes, alimento, lotes, alertas y registros) al archivo `app/firestore-data.js`, que las resuelve sobre Firestore devolviendo las mismas estructuras que la API local.")

    # ---- 8
    h1(doc, "8. Seguridad")
    vinetas(doc, [
        "El acceso al panel usa Firebase Authentication; cada usuario entra con su correo y contraseña.",
        "Las reglas de Firestore exigen sesión y que el campo `granja_id` coincida con la cuenta: sin sesión, la base responde con error 403 tanto al leer como al escribir. Se publican con `firebase deploy --only firestore:rules`.",
        "El Worker de IA valida el token de Firebase en cada petición y solo acepta los orígenes de la lista `ALLOWED_ORIGINS`.",
        "El Worker limita el uso a 30 consultas cada 5 minutos por usuario, para evitar abusos y cuidar la cuota del plan gratuito.",
        "La clave de Groq vive como secreto del Worker (`wrangler secret put GROQ_API_KEY`) y no está en el repositorio ni en el navegador.",
        "Las credenciales de la base de datos viven en `server/.env`, archivo que no se sube al repositorio. En su lugar se incluye `server/.env.example` como plantilla.",
        "`server/firebase-creds.json` (clave de la cuenta de servicio de Firebase) y `server/.env` no se versionan: ambos están en `.gitignore` y solo existen en la máquina que despliega.",
        "La carpeta `docs/` (documentación y manuales) no se publica en Firebase Hosting ni se versiona en el repositorio.",
        "La API local puede protegerse con una clave (`API_TOKEN`); sin ella, queda abierta solo para desarrollo local.",
        "Todas las validaciones están centralizadas en `acciones.py`, por lo que las reglas son idénticas para el bot, el panel, el asistente y cualquier otro canal.",
        "El asistente no escribe por su cuenta: prepara el registro, lo valida y espera la confirmación de la persona antes de guardar.",
        "La etiqueta NFC lleva el identificador de la granja; si alguien la acerca con otra cuenta, el panel avisa y no abre la poza.",
    ])

    # ---- 9
    h1(doc, "9. Etiquetas NFC")
    cuerpo(doc, "Cada poza puede llevar una etiqueta NFC adhesiva, del tamaño de una moneda, que abre su ficha al acercar el teléfono. No hace falta instalar ninguna aplicación: el teléfono abre el navegador con la dirección guardada en la etiqueta.")

    h2(doc, "9.1 Qué guarda la etiqueta")
    cuerpo(doc, "La etiqueta guarda una dirección web con tres datos:")
    par(doc, "`https://cuymax-by-dc.web.app/app/?modo=real&poza=P-001&g=<identificador de la granja>`",
        size=9, align=WD_ALIGN_PARAGRAPH.LEFT, despues=8)
    vinetas(doc, [
        "`modo=real`: abre el panel con datos reales, no la demostración.",
        "`poza=P-001`: indica qué poza se debe abrir.",
        "`g=<identificador>`: es el identificador de la granja dueña de la etiqueta.",
    ])
    par(doc, "", despues=4)
    cuerpo(doc, "Se guarda una dirección y no un código interno porque así cualquier teléfono puede abrirla, aunque no tenga la aplicación instalada ni haya iniciado sesión antes.")

    h2(doc, "9.2 Cómo se graba")
    vinetas(doc, [
        "Desde el panel, en la ficha de la poza, el bloque «Etiqueta NFC de esta poza» muestra la dirección y el botón «Grabar etiqueta». Ese botón funciona en Chrome para Android con NFC (Web NFC).",
        "En iPhone o en una computadora se usa la aplicación gratuita NFC Tools: «Escribir» → «URL» y se pega la dirección que muestra el panel.",
        "La etiqueta debe ser NDEF; los modelos NTAG213, NTAG215 y NTAG216 son los más comunes.",
    ])
    par(doc, "", despues=4)
    cuerpo(doc, "El bloque también ofrece «Copiar enlace», útil para compartir la ficha o para pegarla en NFC Tools.")

    h2(doc, "9.3 Control de granja ajena")
    cuerpo(doc, "Si una etiqueta de otra granja se acerca a un teléfono con una cuenta distinta, el panel no abre la poza: muestra el aviso «Esta etiqueta es de otra granja» con dos opciones, «Ahora no» y «Cambiar de cuenta». Así se evita registrar movimientos en la granja equivocada.")

    h2(doc, "9.4 Regrabar una etiqueta")
    cuerpo(doc, "Las etiquetas se pueden volver a grabar tantas veces como sea necesario. Si cambia el nombre o el identificador de la granja, conviene regrabarlas para que la dirección quede actualizada.")

    # ---- 10
    h1(doc, "10. Instalación y despliegue")

    h2(doc, "10.1 Instalación local")
    numerada(doc, [
        "Tener Python 3.12 o superior y PostgreSQL 18 con la base `cuyes` creada.",
        "Copiar `server/.env.example` a `server/.env` y completar las credenciales.",
        "Ejecutar `iniciar.bat`. El script verifica PostgreSQL y el puerto 8000, y abre el navegador cuando el servidor responde.",
    ])

    h2(doc, "10.2 Despliegue del sitio")
    numerada(doc, [
        "Subir el número de versión en `app/index.html` (parámetro `?v=`), en la lista `SHELL` y en la constante `CACHE` de `app/sw.js`.",
        "Ejecutar `firebase deploy --only hosting` desde una cuenta con acceso al proyecto `cuymax-by-dc`.",
        "Dirección publicada: `https://cuymax-by-dc.web.app`.",
    ])
    par(doc, "", despues=4)
    cuerpo(doc, "Cada despliegue deja una versión nueva de la caché. Los teléfonos que tengan el panel abierto verán el botón «Versión nueva · Actualizar» y, al pulsarlo, cargarán la versión recién publicada sin tener que borrar datos del navegador.")

    h2(doc, "10.3 Despliegue del Worker de IA")
    numerada(doc, [
        "Entrar a la carpeta `worker`.",
        "Guardar la clave de Groq como secreto: `npx wrangler secret put GROQ_API_KEY`.",
        "Guardar la clave privada VAPID (un objeto JSON con las claves de la curva P-256): `npx wrangler secret put VAPID_JWK`. La pública ya está en `wrangler.jsonc` y en `firebase-config.js`; las dos mitades deben ser del mismo par.",
        "Crear el almacenamiento de suscripciones si no existe: `npx wrangler kv namespace create AVISOS`, y copiar el identificador a `wrangler.jsonc`.",
        "Publicar: `npx wrangler deploy`. El aviso programado queda en `schedule: 0 * * * *` (corre cada hora).",
        "El Worker queda en `https://cuymax-ia.cuymax.workers.dev`; su dirección se configura en `CUYMAX_IA_URL`, dentro de `firebase-config.js`.",
    ])
    par(doc, "", despues=4)
    cuerpo(doc, "Los modelos, los orígenes permitidos y la clave pública VAPID se ajustan en `worker/wrangler.jsonc`. Los avisos programados se prueban sin esperar el cron: el botón «Enviar una prueba» de Ajustes manda uno al instante.")

    h2(doc, "10.4 Reglas de Firestore")
    cuerpo(doc, "Se publican con `firebase deploy --only firestore:rules`. Conviene hacerlo cada vez que se agregue una colección nueva.")

    # ---- 11
    h1(doc, "11. Estado actual y pendientes")
    cuerpo(doc, "Estado a la versión 59 del panel (31 de octubre de 2026).")
    cuerpo(doc, "Funcionando en esta versión:")
    vinetas(doc, [
        "Panel con cinco secciones y asistente flotante disponible en todas ellas.",
        "Registro de los diez movimientos de campo mediante un selector.",
        "Ficha de poza con curva de peso, economía y acciones rápidas de registro.",
        "Registro rápido flotante en el celular, que recuerda la última poza y el último movimiento usado para no repetir la búsqueda.",
        "Cuenta accesible desde el menú del celular: muestra la granja, el correo y el botón de cerrar sesión.",
        "Menú del celular en rejilla de tres por dos, para que las seis entradas quepan sin desplazamiento horizontal.",
        "Descarga desde el sitio web, con una tarjeta por sistema y un aviso de instalación dentro del panel cuando se llega desde ella.",
        "Asistente adaptado al teclado del celular: el panel se ajusta al alto visible y el teclado no se cierra al enviar un mensaje.",
        "Etiquetas NFC por poza, con control de granja ajena.",
        "Instalación como aplicación desde el propio navegador, con ícono propio, atajos de sección y ventana sin barra de direcciones.",
        "Trabajo sin conexión: el panel abre sin internet y los movimientos quedan guardados en el teléfono hasta que vuelve la señal.",
        "Aviso de versión nueva, para que un teléfono con el panel abierto no siga con el código anterior.",
        "Notificaciones al celular: aviso diario a la hora elegida, solo cuando hay trabajo pendiente, con botón de prueba desde Ajustes.",
        "Aislamiento de datos por granja: una cuenta es una granja y las reglas lo exigen.",
        "Asistente con IA en la nube (Worker + Groq), con validación de sesión y límite de uso.",
        "Modo demo sin sesión, para mostraciones y pruebas.",
        "Parte económica calculada con los precios de balanceado, forraje y precio por cuy que se cargan en Ajustes.",
        "Avisos con generación diaria y marcado de atendidos.",
        "Borrado de movimientos con confirmación, según el modo de trabajo.",
        "Versión local con PostgreSQL y API propia.",
    ])
    par(doc, "", despues=8)
    cuerpo(doc, "Pendientes propuestos:")
    vinetas(doc, [
        "Envío de avisos al celular por WhatsApp o Telegram, además de la notificación del navegador.",
        "Regrabar las etiquetas antiguas que no llevan el identificador de la granja.",
        "Cachear las lecturas de Firestore por pantalla para consumir menos cuota.",
        "Completar la gráfica de Evolución en el modo de datos reales (ingresos semanales a partir de las ventas).",
        "Restringir CORS y activar `API_TOKEN` en la API local para producción.",
        "Ampliar las pruebas con más datos reales de la granja.",
    ])

    doc.save(ruta)
    print("OK Documentación del Sistema ->", ruta)


# ----------------------------------------------------------- MANUAL DE USUARIO

def build_manual():
    doc, ruta = abrir_plantilla("Manual")
    FIG_N["n"] = 0
    portada(doc, "Manual de Usuario")
    salto(doc)

    contenido(doc, [
        "1. ¿Qué es CuyMax?",
        "2. Cómo entrar",
        "3. El menú y la pantalla principal",
        "4. El panel general",
        "5. La ficha de poza",
        "6. Registrar movimientos",
        "7. Avisos",
        "8. El asistente",
        "9. Etiquetas NFC de las pozas",
        "10. Ajustes",
        "11. Usar CuyMax en el celular",
        "12. Preguntas frecuentes",
        "13. Glosario",
    ])

    # ---- 1
    h1(doc, "1. ¿Qué es CuyMax?")
    cuerpo(doc, "CuyMax es un sistema para llevar el control de una granja de cuyes. Con él se registran los movimientos del día a día (pesos, muertes, alimento, partos y compras), se revisa el estado de cada poza y se reciben avisos de las tareas pendientes, como partos próximos o destetes.")
    cuerpo(doc, "Incluye además un asistente: le escribes lo que pasó con tus palabras (por ejemplo, «se murieron 2 cuyes en P-001 por diarrea») y prepara el registro para que lo confirmes; también responde preguntas sobre la granja.")
    cuerpo(doc, "Esta versión funciona en el navegador, tanto en computadora como en celular, de tres formas:")
    vinetas(doc, [
        "**Versión instalada** (computadora de la granja): trabaja con los datos reales e incluye el asistente completo.",
        "**Versión publicada con datos reales**: se entra con «Monitorear» y una cuenta. Los datos quedan en la nube y el asistente funciona.",
        "**Versión publicada en modo demo**: es una demostración con datos de ejemplo y el asistente aparece desactivado.",
    ])
    par(doc, "", despues=4)
    cuerpo(doc, "Además, el panel se puede instalar en el celular como una app y seguir usándolo sin conexión: los registros se guardan en el teléfono y se envían cuando vuelve la señal. El capítulo 11 explica cómo.")

    # ---- 2
    h1(doc, "2. Cómo entrar")
    numerada(doc, [
        "Abre tu navegador en `https://cuymax-by-dc.web.app`. En la página principal verás dos botones: «Probar Demo» entra a la demostración con datos de ejemplo y «Monitorear» entra al panel con datos reales guardados en la nube.",
        "Si es tu primera vez, elige la pestaña Crear cuenta y llena tus Nombres, Apellidos, el correo y una contraseña de al menos 6 caracteres. Luego haz clic en Crear cuenta.",
        "Si ya tienes cuenta, usa la pestaña Entrar con tu correo y contraseña.",
    ])
    par(doc, "", despues=4)
    cuerpo(doc, "**Nota:** «Probar Demo» es una demostración con datos de ejemplo y no afecta ninguna información real de la granja. «Monitorear» sí guarda información real: úsala cuando quieras registrar la granja de verdad.")
    cuerpo(doc, "En la computadora de la granja, en lugar del sitio publicado se abre CuyMax con el archivo `iniciar.bat`, que inicia el programa y abre el panel en `http://localhost:8000` con la información real.")
    cuerpo(doc, "Para salir, usa el botón **Cerrar sesión** en la tarjeta de la izquierda.")

    # ---- 3
    h1(doc, "3. El menú y la pantalla principal")
    cuerpo(doc, "Al entrar verás el menú de la izquierda con cinco secciones:")
    vinetas(doc, [
        "**Panel:** el resumen de la granja, con indicadores y gráficas.",
        "**Poza:** la ficha de cada poza, con su curva de peso, su economía y su etiqueta NFC.",
        "**Registrar:** donde se anotan los movimientos del día.",
        "**Avisos:** las tareas pendientes, como partos o destetes.",
        "**Últimos registros:** el historial de movimientos recientes, con la opción de borrar los que se hayan cargado por error.",
    ])
    par(doc, "", despues=4)
    cuerpo(doc, "En el celular el menú no va a la izquierda: se reparte en dos filas de tres pestañas en la parte superior, y aparece una sexta entrada, **Cuenta**, que reúne el nombre de la granja, el correo con el que entraste y el botón para cerrar sesión.")
    cuerpo(doc, "Arriba están el buscador (busca una poza o una hembra), el botón de tema claro/oscuro y la campana de avisos. En el Panel el botón se llama **+ Registro rápido** y en Registrar **+ Registrar movimiento**; ambos abren el mismo selector de movimientos.")
    cuerpo(doc, "Abajo a la izquierda está la tarjeta de la granja: muestra el nombre de la persona conectada, la etiqueta Modo demo (amarilla) o Datos reales (verde), y los botones **Ajustes**, **Cerrar sesión** y **Volver al sitio web**. Cuando el navegador permite instalar la app, aparece además el botón **Instalar app** (ver el capítulo 11). En el celular esta tarjeta no se ve: todo lo que contiene está en la pestaña **Cuenta**.")
    cuerpo(doc, "En la esquina inferior derecha, en todas las pantallas, están dos botones flotantes. El de arriba, cuadrado y con un signo **+**, es el **registro rápido**: abre el selector de movimientos desde cualquier pantalla, sin tener que ir antes a la sección Registrar. El de abajo, redondo, abre el **Asistente**.")
    figura(doc, "panel.png", "Pantalla principal del panel con los indicadores de la granja.", 15.0)

    # ---- 4
    h1(doc, "4. El panel general")
    cuerpo(doc, "Es lo primero que se ve al entrar. Arriba están los cuatro indicadores principales:")
    vinetas(doc, [
        "**Partos próximos:** hembras que darán crías en los siguientes 10 días.",
        "**Cuyes vivos:** total de animales vivos en la granja.",
        "**Pozas en retiro:** pozas que todavía no se pueden vender por retiro sanitario.",
        "**Margen total:** lo vendido menos los costos registrados, en soles.",
    ])
    par(doc, "", despues=4)
    cuerpo(doc, "Debajo están las gráficas de **Evolución de población e ingresos** y **Nacimientos y salidas**, y las listas de **Partos próximos** y **Pozas**, con el estado y la ocupación de cada una.")
    cuerpo(doc, "Los botones **Hoy**, **30 días** y **Año** cambian el periodo de las gráficas. El botón **Exportar reporte CSV** descarga los datos para abrirlos en una hoja de cálculo.")

    # ---- 5
    h1(doc, "5. La ficha de poza")
    cuerpo(doc, "En la sección Poza, elige una poza en la lista. La ficha muestra su estado (por ejemplo, engorde y abierto), las muertes, ventas y faenas, el alimento total y una barra con los cuyes vivos sobre el total.")
    cuerpo(doc, "Los cuatro indicadores de la ficha son: vivos, mortalidad (con aviso en rojo si es alta), último peso y alimento acumulado. Más abajo está la curva de peso (la línea punteada es el peso objetivo) y la economía de la poza: ingresos, costo total, margen y costo por cuy.")
    cuerpo(doc, "Encima de la curva hay cuatro botones de registro rápido: **Pesar**, **Alimento**, **Muerte** y **Venta**. Abren el formulario correspondiente con la poza ya elegida, para no tener que buscarla otra vez.")
    cuerpo(doc, "Al final de la ficha está el bloque de la **etiqueta NFC** de la poza y, más abajo, los datos para editar la poza y sus ubicaciones.")
    figura(doc, "poza.png", "Ficha de poza: indicadores, acciones rápidas y bloque de la etiqueta NFC.", 15.0)

    # ---- 6
    h1(doc, "6. Registrar movimientos")
    cuerpo(doc, "La sección Registrar tiene un botón, **+ Registrar movimiento**, que abre un selector con diez tarjetas: peso, muerte, alimento, parto, programar parto, destete, ingreso, venta, faena y retiro sanitario. Cada movimiento se guarda con la fecha del día.")
    figura(doc, "registrar.png", "Sección Registrar con los accesos directos a los movimientos más frecuentes.", 15.0)
    figura(doc, "registrar-selector.png", "Selector de movimientos: las diez tarjetas de registro.", 12.6)

    h2(doc, "6.1 Registrar un peso")
    numerada(doc, [
        "Elige la poza en la lista (te muestra cuántos vivos tiene).",
        "Escribe el peso promedio en gramos (por ejemplo, 720).",
        "El campo Muestra es opcional: si pesaste 10 cuyes, anota 10; si lo dejas vacío, el sistema también asume 10.",
        "Haz clic en Guardar peso. El sistema te muestra el peso anterior para comparar.",
    ])

    h2(doc, "6.2 Registrar una muerte")
    cuerpo(doc, "Elige la poza, escribe la cantidad y, si la sabes, la causa (por ejemplo, diarrea). El sistema no permite registrar más bajas que los cuyes vivos de la poza.")

    h2(doc, "6.3 Registrar alimento")
    cuerpo(doc, "Elige la poza, el tipo (forraje o balanceado) y los kilos entregados.")

    h2(doc, "6.4 Registrar un parto")
    cuerpo(doc, "Escribe el arete de la hembra o el código de la poza; con uno de los dos basta. Luego anota los nacidos vivos y, si hubo, los nacidos muertos. Si en la misma poza hay varias hembras en gestación, el sistema te pedirá precisar cuál parió.")

    h2(doc, "6.5 Programar un parto")
    cuerpo(doc, "Antes de registrar un parto se programa. Elige Programar parto, escribe el arete de la hembra, la ubicación (opcional) y la fecha estimada. La hembra aparece en la lista de partos próximos del panel y el sistema genera el aviso correspondiente.")

    h2(doc, "6.6 Registrar un destete")
    cuerpo(doc, "Cuando las crías cumplen entre 15 y 21 días, elige Destete, escribe el arete de la madre, cuántas crías se destetan y la poza destino. Si esa poza todavía no existe, se crea automáticamente con esas crías y en etapa recría. El aviso de destete desaparece de la lista de pendientes.")

    h2(doc, "6.7 Registrar un ingreso (compra de cuyes)")
    cuerpo(doc, "Sirve para cuyes que llegan comprados. Elige la poza y escribe cuántos cuyes llegaron; se suman al total.")

    h2(doc, "6.8 Registrar una venta")
    cuerpo(doc, "Elige la poza, la cantidad de cuyes y el precio por cuy. Si dejas el precio vacío, el sistema usa el que está cargado en Ajustes. Los cuyes vendidos se descuentan de los vivos y el ingreso aparece en el resumen económico.")

    h2(doc, "6.9 Registrar una faena")
    cuerpo(doc, "Elige la poza y la cantidad faenada. Los animales se descuentan de los vivos y aparecen en faenados dentro de la ficha de la poza.")

    h2(doc, "6.10 Registrar un retiro sanitario")
    cuerpo(doc, "Elige la poza, el producto aplicado y los días de retiro. La poza queda en la lista de retiro sanitario del panel y no se debe vender hasta cumplir los días; el sistema lo recuerda en Avisos.")

    h2(doc, "6.11 Borrar un registro equivocado")
    cuerpo(doc, "En la sección **Últimos registros** está el historial de movimientos (peso, muerte, alimento, parto, destete, venta, faena y retiro) con su fecha. Si anotaste algo por error, pulsa **Borrar** en esa fila y confirma el aviso: el registro se elimina y los indicadores se recalculan solos (si borras una muerte o una venta, los cuyes vivos vuelven a sumarse). La acción no se puede deshacer.")
    cuerpo(doc, "En el modo demo el historial no se muestra, porque los datos son de ejemplo.")

    h2(doc, "6.12 El registro rápido")
    cuerpo(doc, "El botón **+** de la esquina inferior derecha abre el mismo selector de movimientos desde cualquier pantalla. Es la forma más corta de anotar algo cuando estás revisando la ficha de una poza o mirando los avisos, porque no obliga a volver a la sección Registrar.")
    cuerpo(doc, "El selector recuerda lo que usaste la última vez. Al abrirlo, la poza en la que estabas trabajando ya viene elegida en todos los formularios, y la tarjeta del movimiento que usaste antes lleva una marca **Última vez**. Así, si estás pesando poza por poza, no tienes que buscar el mismo código diez veces.")
    figura(doc, "fab-registro.png", "El selector de movimientos que abre el botón de registro rápido.", 7.2)
    cuerpo(doc, "Esa memoria se guarda solo en tu teléfono o computadora; no se comparte con otras cuentas.")

    # ---- 7
    h1(doc, "7. Avisos")
    cuerpo(doc, "La sección Avisos muestra las tareas del día. El botón **Generar avisos de hoy** crea los avisos según los datos de la granja y el selector Todos / Pendientes filtra la lista.")
    cuerpo(doc, "Los avisos más comunes son:")
    vinetas(doc, [
        "**Parto próximo:** una hembra está por parir; revisa la poza.",
        "**Destete:** las crías cumplen la edad (entre 15 y 21 días) y toca separarlas.",
        "**Pesaje pendiente:** una poza lleva varios días sin pesarse.",
        "**Retiro sanitario:** una poza pronto podrá venderse; ya se puede programar la venta.",
    ])
    par(doc, "", despues=4)
    cuerpo(doc, "Cuando termines una tarea, haz clic en **Atender** para quitarla de pendientes. Los avisos atendidos quedan en la lista de abajo y se pueden devolver a pendientes. La campana de arriba muestra un punto rojo cuando hay avisos nuevos.")
    figura(doc, "avisos.png", "Sección Avisos con las tareas pendientes del día.", 15.0)

    # ---- 8
    h1(doc, "8. El asistente")
    cuerpo(doc, "El asistente es un chat que entiende pedidos escritos en lenguaje natural. Sirve para dos cosas: hacer consultas y anotar movimientos. Ya no ocupa una sección del menú: se abre como una ventana flotante desde cualquier pantalla, con el botón redondo de la esquina inferior derecha, y se cierra con la X o con la tecla Escape.")
    cuerpo(doc, "En la computadora también se abre con **Ctrl + K** (en Mac, **⌘ + K**).")
    cuerpo(doc, "En el celular el teclado se queda abierto mientras conversas: al enviar un mensaje el campo no pierde el foco, y cuando llega la respuesta el chat se desplaza solo para mostrarla completa, sin dejar un hueco debajo. Si cierras el teclado a propósito, no se vuelve a abrir solo.")
    cuerpo(doc, "Para usarlo, escribe el mensaje tal como se lo dirías a otra persona y haz clic en Enviar. La respuesta aparece en el mismo chat. Si no sabes cómo empezar, toca una de las sugerencias que aparecen debajo del mensaje de bienvenida.")
    figura(doc, "asistente.png", "El asistente como ventana flotante, disponible en cualquier sección.", 15.0)

    h2(doc, "8.1 Consultas")
    cuerpo(doc, "Puedes preguntar, por ejemplo:")
    vinetas(doc, [
        "¿Cómo va la poza P-001?",
        "¿Qué avisos tengo pendientes?",
        "¿Cómo van las pozas?",
    ])
    par(doc, "", despues=4)
    cuerpo(doc, "El asistente responde con la información real de la granja: vivos, mortalidad, alimento, último peso, avisos, entre otros datos.")

    h2(doc, "8.2 Registros")
    cuerpo(doc, "También puedes contarle lo que pasó, por ejemplo:")
    vinetas(doc, [
        "Se murieron 2 cuyes en la poza P-001 por diarrea.",
        "Peso promedio 720 gramos en la poza P-002.",
        "Entregué 15 kilos de forraje en la poza P-001.",
        "Parió la hembra H-012, 3 nacidos vivos.",
    ])
    par(doc, "", despues=4)
    cuerpo(doc, "El asistente no guarda solo: muestra una tarjeta con lo que entendió («Entendí: 2 muerte(s) en la poza P-001 (causa: diarrea). ¿Lo guardo?») y dos botones para confirmar o cancelar.")
    cuerpo(doc, "Revisa siempre el resumen antes de confirmar. Si el asistente no entendió, vuelve a escribirlo de otra forma, indicando la poza y la cantidad.")
    cuerpo(doc, "**Importante:** el asistente necesita conexión a internet y una sesión iniciada. En la demostración («Probar Demo») aparece desactivado, porque no hay una granja real que consultar; en ese caso registra con los formularios de la sección Registrar.")

    # ---- 9
    h1(doc, "9. Etiquetas NFC de las pozas")
    cuerpo(doc, "Cada poza puede llevar una etiqueta NFC, del tamaño de una moneda, pegada en el marco o en la pared. Al acercar el teléfono se abre directamente la ficha de esa poza, sin buscar en la lista ni escribir el código.")
    cuerpo(doc, "No hace falta instalar ninguna aplicación: el teléfono abre el navegador con la dirección guardada en la etiqueta.")

    h2(doc, "9.1 Dónde está el enlace de la poza")
    cuerpo(doc, "Entra a la ficha de la poza. Debajo de los botones de registro rápido está el bloque **Etiqueta NFC de esta poza**, con la dirección y dos botones: **Copiar enlace** y **Grabar etiqueta** (en iPhone o computadora el segundo dice **¿Cómo grabar?**).")
    figura(doc, "nfc-bloque.png", "Bloque de la etiqueta NFC en la ficha de la poza.", 9.2)

    h2(doc, "9.2 Grabar la etiqueta desde el celular")
    numerada(doc, [
        "Abre el panel en **Chrome para Android** y entra a la ficha de la poza.",
        "Toca **Grabar etiqueta**.",
        "Acerca la etiqueta a la parte de atrás del teléfono y mantenla pegada hasta que el mensaje diga «Etiqueta grabada».",
        "Pega la etiqueta en la poza y pruébala: al acercar el teléfono debe abrir la misma ficha.",
    ])

    h2(doc, "9.3 Grabar la etiqueta desde un iPhone o una computadora")
    numerada(doc, [
        "Toca **Copiar enlace** y envía la dirección a tu teléfono (por ejemplo, por WhatsApp).",
        "Instala la aplicación gratuita **NFC Tools**.",
        "Elige «Escribir», luego «Agregar un registro» → «URL» y pega la dirección.",
        "Toca «Escribir» y acerca la etiqueta al teléfono.",
    ])

    h2(doc, "9.4 Qué pasa si la etiqueta es de otra granja")
    cuerpo(doc, "La etiqueta guarda también a qué granja pertenece. Si alguien la acerca con otra cuenta, el panel no abre la poza y muestra el aviso «Esta etiqueta es de otra granja», con las opciones **Ahora no** y **Cambiar de cuenta**. Así se evita anotar movimientos en la granja equivocada.")

    h2(doc, "9.5 Regrabar una etiqueta")
    cuerpo(doc, "Las etiquetas se pueden volver a grabar las veces que haga falta, por ejemplo si cambiaste el nombre de la granja o si la etiqueta se pegó en otra poza. Repite los pasos de arriba sobre la etiqueta que quieras actualizar.")

    # ---- 10
    h1(doc, "10. Ajustes")
    cuerpo(doc, "El botón **Ajustes** (en la tarjeta de la izquierda) permite cambiar el nombre de la granja y los precios que usa la parte económica: precio del balanceado por kilo, del forraje por kilo y del cuy por unidad.")
    cuerpo(doc, "Cada cuenta es una granja: no hay que elegir un número de granja ni cambiarlo, porque los datos quedan asociados a tu cuenta. En la versión instalada, Ajustes muestra además el número de granja y la clave de la API local, que solo hacen falta cuando el servidor propio los exige.")
    cuerpo(doc, "En el celular, la tarjeta de la izquierda no existe: Ajustes se abre desde la pestaña **Cuenta**. Arriba de los campos aparecen el nombre de la granja, el correo con el que entraste y el botón **Cerrar sesión**, para no tener que buscar esas opciones en otra pantalla.")
    cuerpo(doc, "En la demostración los cambios no se guardan.")

    # ---- 11
    h1(doc, "11. Usar CuyMax en el celular")
    cuerpo(doc, "CuyMax se abre en el navegador del celular, pero se puede instalar como una aplicación: queda con su propio ícono en la pantalla de inicio, se abre a pantalla completa y funciona aunque no haya señal.")
    figura(doc, "movil.png", "CuyMax abierto en el celular.", 6.6)

    h2(doc, "11.1 Instalar la app en Android")
    numerada(doc, [
        "Abre `https://cuymax-by-dc.web.app` en Chrome y entra con tu cuenta.",
        "En la portada, baja hasta **Descarga la App** y toca **Instalar en Android**: se abre el panel y, arriba, aparece un aviso con el botón **Instalar**. Si no lo ves, abre el menú de Chrome (los tres puntos) y elige **Instalar aplicación** o **Agregar a pantalla de inicio**.",
        "Confirma **Instalar**. El ícono de CuyMax aparece en la pantalla de inicio.",
        "Ábrelo desde ese ícono: se verá a pantalla completa, sin la barra de direcciones del navegador.",
    ])
    figura(doc, "instalar-aviso-crop.png", "El aviso de instalación que aparece arriba del panel en el celular.", 9.2)
    cuerpo(doc, "El aviso se puede cerrar con la X. Mientras no instales la app, volverá a aparecer cada vez que entres desde el botón de descarga del sitio; cuando ya está instalada, no se muestra.")

    h2(doc, "11.2 Instalar la app en iPhone")
    numerada(doc, [
        "Abre el sitio en **Safari**.",
        "Toca el botón **Compartir** (el cuadrado con la flecha hacia arriba).",
        "Baja por la lista y elige **Añadir a pantalla de inicio**.",
        "Confirma con **Añadir**.",
    ])
    par(doc, "", despues=4)
    cuerpo(doc, "En iPhone el aviso de instalación no lleva botón: muestra directamente estos pasos, porque Apple no permite que la página abra el diálogo de instalación. Tiene que ser **Safari**; Chrome en iPhone no puede añadir páginas a la pantalla de inicio.")

    h2(doc, "11.3 Trabajar sin señal")
    cuerpo(doc, "Si te quedas sin datos o sin wifi, CuyMax sigue abierto y puedes seguir registrando pesos, muertes, alimento, partos, ventas y los demás movimientos. Cada registro se guarda primero en el teléfono.")
    cuerpo(doc, "Para saber que estás sin conexión, mira la barra superior: aparece una insignia ámbar que dice **Sin conexión**.")
    figura(doc, "offline.png", "La insignia «Sin conexión», en la barra superior.", 5.4)
    cuerpo(doc, "Cuando vuelve la señal, el panel lo avisa con el mensaje **Conexión recuperada** y sube solo los registros que quedaron pendientes. No hay que hacer nada más.")
    cuerpo(doc, "**Importante:** el asistente de IA no funciona sin internet, porque piensa en un servicio en línea. Los formularios de la sección Registrar sí funcionan.")

    h2(doc, "11.4 Cuando aparece «Versión nueva · Actualizar»")
    cuerpo(doc, "CuyMax se actualiza solo, pero la pestaña que tienes abierta sigue con la versión anterior hasta que se recarga. Cuando se publica una versión nueva, en la tarjeta de la izquierda aparece un botón que lo avisa.")
    figura(doc, "actualizar.png", "El aviso de versión nueva en la tarjeta de la izquierda.", 6.4)
    cuerpo(doc, "Púlsalo cuando puedas terminar lo que estás haciendo: la página se recarga con la versión nueva. No se pierde nada, porque lo que registraste ya está guardado.")

    h2(doc, "11.5 Atajos del ícono")
    cuerpo(doc, "En Android, si mantienes pulsado el ícono de CuyMax en la pantalla de inicio, aparecen tres atajos: **Registrar movimiento**, **Avisos del día** y **Panel general**. Sirven para entrar directo a esa sección sin pasar por el panel general.")

    h2(doc, "11.6 El menú en el celular")
    cuerpo(doc, "En el celular el menú se convierte en seis pestañas repartidas en dos filas de tres: Panel, Poza, Registrar, Avisos, Registros y Cuenta. Algunas etiquetas se acortan para que quepan («Últimos registros» pasa a «Registros»).")
    cuerpo(doc, "La pestaña **Cuenta** abre Ajustes con tus datos arriba: el nombre de la granja, el correo con el que entraste y el botón **Cerrar sesión**.")
    figura(doc, "cuenta-movil-crop.png", "La pestaña Cuenta en el celular, con los datos de la granja y el cierre de sesión.", 8.4)
    cuerpo(doc, "Abajo a la derecha siguen los dos botones flotantes: el **+** del registro rápido y el del asistente.")

    h2(doc, "11.7 Avisos al celular (notificaciones)")
    cuerpo(doc, "CuyMax puede avisarte cada día a la hora que elijas si hay trabajo pendiente en la granja: partos próximos, destetes, pesajes atrasados o retiros por vencer. El aviso llega aunque no tengas la aplicación abierta.")
    numerada(doc, [
        "Entra al panel y abre **Ajustes** (en la tarjeta de la izquierda).",
        "Toca **Activar notificaciones** y acepta el permiso que pide el navegador.",
        "Elige la **hora del aviso diario** (por ejemplo, 07:00).",
        "Toca **Enviar una prueba**: en unos segundos debe saltar la primera notificación.",
    ])
    par(doc, "", despues=4)
    cuerpo(doc, "El aviso llega solo si hay trabajo pendiente ese día; si la granja está al día, no se manda nada. Al tocar la notificación se abre el panel en la sección Avisos.")
    cuerpo(doc, "Si dejas de querer los avisos, vuelve a Ajustes y toca **Desactivar**. En iPhone hace falta tener CuyMax instalado en la pantalla de inicio (ver 11.2) y un sistema iOS 16.4 o superior.")

    # ---- 12
    h1(doc, "12. Preguntas frecuentes")
    faq = [
        ("¿Los datos que veo son reales?", "En «Probar Demo» son datos de ejemplo, para probar sin riesgo. En «Monitorear» y en la versión instalada se trabaja con información real."),
        ("¿Cómo sé en qué modo estoy?", "Por la etiqueta de la tarjeta de la izquierda: Modo demo (amarilla) significa datos de ejemplo y Datos reales (verde) significa que estás trabajando con la información guardada en la nube."),
        ("¿Necesito instalar algún programa?", "No. Se usa desde el navegador. Si quieres, puedes instalarlo en el celular como app, con su propio ícono (ver el capítulo 11)."),
        ("¿Puedo registrar si me quedo sin señal?", "Sí. El panel sigue abierto y cada movimiento se guarda en el teléfono; cuando vuelve la conexión se sube solo. Lo único que no funciona sin internet es el asistente de IA."),
        ("¿Se pierde lo que registré sin señal si cierro la app?", "No. Queda guardado en el teléfono y se envía cuando vuelve la conexión, aunque cierres la app o apagues el celular."),
        ("¿Puedo recibir un aviso sin abrir la app?", "Sí. En Ajustes activa las notificaciones y elige la hora: cada día, si hay trabajo pendiente (partos, destetes, pesajes o retiros), llega una notificación al celular. Puedes probarla con el botón Enviar una prueba."),
        ("¿Por qué no me llegó el aviso de hoy?", "Porque no había nada pendiente: el aviso solo se envía cuando hay partos próximos, destetes, pesajes atrasados o retiros por vencer. Revisa también que las notificaciones estén activadas en Ajustes y en el navegador."),
        ("¿Puedo equivocarme al registrar?", "Sí, y tienes cómo corregirlo: en la sección Últimos registros hay un botón Borrar en cada movimiento. La app pide confirmación antes de borrar y recalcula los indicadores; ten en cuenta que la acción no se puede deshacer."),
        ("¿Funciona con varias pozas?", "Sí. Puedes tener todas las pozas que necesites y elegir la poza en cada formulario."),
        ("¿El asistente guarda o borra datos solo?", "No. Solo propone registros; para que se guarden tienes que tocar Confirmar. Tampoco borra ni modifica registros existentes."),
        ("¿El asistente funciona sin internet?", "No, porque usa un servicio de inteligencia artificial en línea. Sin internet puedes seguir registrando con los formularios de la sección Registrar."),
        ("¿Pueden usarlo varias personas a la vez?", "Sí, si comparten la misma cuenta: todas ven la misma granja y los cambios aparecen al instante. Cada cuenta es una granja distinta, así que los datos de dos cuentas nunca se mezclan."),
        ("¿Se pierden los datos si cierro la página?", "No, cuando trabajas con datos reales: quedan guardados en la nube y los ves al volver a entrar. En la demostración sí, porque son datos de ejemplo."),
        ("¿Puedo usar la misma etiqueta en dos pozas?", "No conviene: cada etiqueta debe apuntar a una sola poza. Si necesitas otra, graba una nueva desde la ficha de la poza correspondiente."),
        ("¿Qué pasa si alguien de otra granja acerca mi etiqueta?", "El panel no abre la poza y muestra el aviso «Esta etiqueta es de otra granja». Así se evita que se registren movimientos en la granja equivocada."),
    ]
    for pregunta, respuesta in faq:
        p = par(doc, "**" + pregunta + "** " + respuesta, align=WD_ALIGN_PARAGRAPH.JUSTIFY, despues=10)

    # ---- 13
    h1(doc, "13. Glosario")
    tabla(doc,
          ["Palabra", "Significado"],
          [
              ["Arete", "Identificación de un animal (por ejemplo, H-003)."],
              ["Poza", "Espacio dentro del galpón donde viven los cuyes. En la base de datos se llama lote."],
              ["Galpón", "Construcción que agrupa varias pozas."],
              ["Lote", "Grupo de cuyes que se maneja junto. En la pantalla se muestra como poza."],
              ["Empadre", "Momento en que se junta la hembra con el macho; de ahí nace la gestación."],
              ["Destete", "Separación de las crías de la madre, entre los 15 y 21 días."],
              ["Retiro sanitario", "Tiempo en que no se debe vender ni consumir animales tratados con medicamento."],
              ["Asistente", "Chat que entiende frases comunes para consultar la granja o registrar movimientos."],
              ["IA", "Inteligencia artificial: el servicio que interpreta los mensajes del asistente."],
              ["NFC", "Tecnología inalámbrica de corto alcance que abre una dirección al acercar el teléfono a una etiqueta."],
              ["Etiqueta NFC", "Adhesivo del tamaño de una moneda que guarda la dirección de una poza."],
              ["Monitorear", "Modo del panel que trabaja con datos reales guardados en la nube."],
              ["App instalada", "CuyMax abierto desde su ícono en el celular, a pantalla completa y sin la barra del navegador."],
              ["Sin conexión", "Estado en que el celular no tiene datos ni wifi. El panel sigue funcionando y guarda lo que registres."],
              ["Notificación", "Aviso que salta en el celular a la hora elegida, con el trabajo pendiente de la granja."],
              ["Granja", "Unidad de trabajo con sus propios datos. Cada cuenta es una granja."],
          ],
          [4.4, 11.8])

    par(doc, "", despues=10)
    par(doc, "Manual correspondiente a la versión de octubre de 2026 de CuyMax. Si tienes dudas o encuentras algo raro, comunícalo al administrador del sistema.",
        size=9.5, color=GRIS, align=WD_ALIGN_PARAGRAPH.CENTER)

    doc.save(ruta)
    print("OK Manual de Usuario ->", ruta)


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "manual":
        build_manual()
    elif len(sys.argv) > 1 and sys.argv[1] == "sistema":
        build_sistema()
    else:
        build_sistema()
        build_manual()
