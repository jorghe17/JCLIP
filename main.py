import os
import json
import shutil
import sqlite3
import time
import uuid
import zipfile
import io
import requests
from datetime import datetime, timedelta
from typing import List, Optional
from collections import defaultdict
from fastapi import FastAPI, File, Form, UploadFile, HTTPException, Depends, Request, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import StreamingResponse, FileResponse
from pydantic import BaseModel
from contextlib import asynccontextmanager
from fastapi.security import OAuth2PasswordBearer
from PIL import Image, ImageEnhance, ImageDraw, ImageFont

# ==========================================
# 1. CONFIGURACIÓN DE ENTORNO Y SEGURIDAD
# ==========================================
from dotenv import load_dotenv
load_dotenv()

SECRET_KEY = os.getenv("SECRET_KEY", "JCLIP_SUPER_SECRET_KEY_PRODUCTION_READY_2026_XYZ_987654321")
ALGORITHM = os.getenv("ALGORITHM", "HS256")
ACCESS_TOKEN_EXPIRE_HOURS = int(os.getenv("ACCESS_TOKEN_EXPIRE_HOURS", 12))
MAX_LOGIN_ATTEMPTS = int(os.getenv("MAX_LOGIN_ATTEMPTS", 5))
LOGIN_BLOCK_MINUTES = int(os.getenv("LOGIN_BLOCK_MINUTES", 5))

# Armadura de Encriptado Nativo y JWT
try:
    import bcrypt
    import jwt
    SEGURIDAD_ACTIVA = True

    def get_password_hash(password: str) -> str:
        salt = bcrypt.gensalt()
        hashed = bcrypt.hashpw(password.encode('utf-8'), salt)
        return hashed.decode('utf-8')

    def verify_password(plain_password: str, hashed_password: str) -> bool:
        try:
            return bcrypt.checkpw(plain_password.encode('utf-8'), hashed_password.encode('utf-8'))
        except Exception:
            return plain_password == hashed_password

except ImportError:
    jwt = None
    SEGURIDAD_ACTIVA = False
    print("\n[ALERTA DE SEGURIDAD] Faltan librerías nativas (bcrypt, pyjwt).")
    print("Ejecuta 'pip install -r requirements.txt' para habilitar cifrado de nivel bancario.\n")
    def get_password_hash(password: str) -> str: return password
    def verify_password(plain_password: str, hashed_password: str) -> bool: return plain_password == hashed_password

# ==========================================
# 2. SCHEDULER BCV Y EXTRACCIÓN AUTOMÁTICA
# ==========================================
try:
    from apscheduler.schedulers.background import BackgroundScheduler
    RELOJ_ACTIVO = True
except ImportError:
    RELOJ_ACTIVO = False
    print("\n[INFO] Reloj de actualización automática BCV inactivo. Instala: pip install apscheduler\n")

def obtener_tasa_bcv_nube() -> float:
    """Extrae la tasa oficial del BCV con múltiples servidores de contingencia."""
    try:
        res = requests.get("https://ve.dolarapi.com/v1/dolares/oficial", timeout=7)
        if res.status_code == 200:
            return float(res.json()['promedio'])
    except Exception:
        pass
    try:
        res = requests.get("https://pydolarvenezuela-api.vercel.app/api/v1/dollar/page?page=bcv", timeout=7)
        if res.status_code == 200:
            return float(res.json()['monitors']['usd']['price'])
    except Exception:
        pass
    raise Exception("Los servidores de consulta BCV no están respondiendo en este momento.")

# ==========================================
# 3. CONTROL DE ACCESO, RATE LIMIT Y VALIDACIÓN
# ==========================================
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth")
oauth2_scheme_opt = OAuth2PasswordBearer(tokenUrl="/api/auth", auto_error=False)

FAILED_LOGINS = defaultdict(list)

def check_rate_limit(ip: str):
    now = time.time()
    FAILED_LOGINS[ip] = [t for t in FAILED_LOGINS[ip] if now - t < (LOGIN_BLOCK_MINUTES * 60)]
    if len(FAILED_LOGINS[ip]) >= MAX_LOGIN_ATTEMPTS:
        raise HTTPException(status_code=429, detail=f"Demasiados intentos de acceso fallidos. IP bloqueada por {LOGIN_BLOCK_MINUTES} minutos.")

def record_failed_login(ip: str):
    FAILED_LOGINS[ip].append(time.time())

def validate_image_upload(file: UploadFile):
    if not file or not file.filename:
        return None
    ext = file.filename.split(".")[-1].lower()
    if ext not in ["jpg", "jpeg", "png", "webp"]:
        raise HTTPException(400, "Formato no permitido. Solo se aceptan imágenes JPG, PNG o WEBP.")
    header = file.file.read(8)
    file.file.seek(0)
    if not (header.startswith(b'\xff\xd8') or header.startswith(b'\x89PNG') or header.startswith(b'RIFF')):
        raise HTTPException(400, "Archivo malicioso o corrupto detectado en la subida de imagen.")

def validate_font_upload(file: UploadFile):
    if not file or not file.filename:
        return None
    ext = file.filename.split(".")[-1].lower()
    if ext not in ["ttf", "otf", "woff", "woff2"]:
        raise HTTPException(400, "Formato no permitido. Solo se aceptan fuentes TTF, OTF, WOFF o WOFF2.")

# ==========================================
# 4. GESTIÓN DE BASE DE DATOS Y BITÁCORA
# ==========================================
DB_NAME = "jclip_v22.db"

def get_db():
    conn = sqlite3.connect(DB_NAME, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON;")
    return conn

def log_accion(usuario: str, accion: str, detalles: str, ip: str = "Local"):
    """Registra una traza de auditoría en la tabla bitacora."""
    try:
        conn = get_db()
        fecha = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        conn.execute("INSERT INTO bitacora (fecha, usuario, accion, detalles) VALUES (?, ?, ?, ?)",
                     (fecha, usuario, accion, f"[{ip}] {detalles}"))
        conn.commit()
    except Exception as e:
        print("Error registrando en bitácora:", e)
    finally:
        conn.close()

def registrar_kardex(cursor, producto_id: int, producto_nombre: str, tipo: str, cantidad: float, stock_previo: float, stock_nuevo: float, costo_unitario: float, motivo: str, usuario: str):
    """Inserta un movimiento en el Kardex."""
    fecha = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    cursor.execute('''INSERT INTO kardex (fecha, producto_id, producto_nombre, tipo, cantidad, stock_previo, stock_nuevo, costo_unitario, motivo, usuario)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)''',
                   (fecha, producto_id, producto_nombre, tipo, cantidad, stock_previo, stock_nuevo, costo_unitario, motivo, usuario))

def init_db():
    conn = get_db()
    c = conn.cursor()
    c.execute("BEGIN TRANSACTION")
    try:
        c.execute('''CREATE TABLE IF NOT EXISTS usuarios (id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT, pin TEXT, rol TEXT, foto TEXT)''')
        c.execute('''CREATE TABLE IF NOT EXISTS productos (id INTEGER PRIMARY KEY AUTOINCREMENT, codigo TEXT, nombre TEXT, descripcion TEXT, categoria TEXT, proveedor TEXT, costo REAL, precio REAL, stock REAL, es_peso INTEGER, variantes TEXT, vencimiento TEXT, imagen_url TEXT, destacado INTEGER DEFAULT 0, stock_minimo REAL DEFAULT 5.0, es_combo INTEGER DEFAULT 0, combo_items TEXT DEFAULT '')''')
        c.execute('''CREATE TABLE IF NOT EXISTS clientes (cedula TEXT PRIMARY KEY, nombre TEXT, telefono TEXT, direccion TEXT, puntos REAL DEFAULT 0.0, foto TEXT, instagram TEXT DEFAULT '', notas TEXT DEFAULT '', referencia_direccion TEXT DEFAULT '')''')
        c.execute('''CREATE TABLE IF NOT EXISTS proveedores (id INTEGER PRIMARY KEY AUTOINCREMENT, empresa TEXT, vendedor TEXT, telefono TEXT)''')
        c.execute('''CREATE TABLE IF NOT EXISTS categorias (id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT)''')
        c.execute('''CREATE TABLE IF NOT EXISTS ventas (folio TEXT PRIMARY KEY, fecha TEXT, cajero TEXT, cliente_cedula TEXT, subtotal REAL, descuento REAL, iva REAL, puntos_canjeados REAL, total_usd REAL, metodos_pago TEXT, vuelto REAL, costo_envio REAL DEFAULT 0.0, tipo_entrega TEXT DEFAULT 'MOSTRADOR', motorizado TEXT DEFAULT '', comprobante_url TEXT DEFAULT '')''')
        c.execute('''CREATE TABLE IF NOT EXISTS ventas_items (id INTEGER PRIMARY KEY AUTOINCREMENT, venta_folio TEXT, producto_id INTEGER, nombre TEXT, cantidad REAL, precio REAL, subtotal REAL, costo_unitario REAL DEFAULT 0.0, FOREIGN KEY(venta_folio) REFERENCES ventas(folio))''')
        c.execute('''CREATE TABLE IF NOT EXISTS gastos (id INTEGER PRIMARY KEY AUTOINCREMENT, fecha TEXT, categoria TEXT, descripcion TEXT, monto REAL, cajero TEXT)''')
        c.execute('''CREATE TABLE IF NOT EXISTS devoluciones (id INTEGER PRIMARY KEY AUTOINCREMENT, fecha TEXT, venta_folio TEXT, monto_devuelto REAL, cajero TEXT)''')
        c.execute('''CREATE TABLE IF NOT EXISTS creditos (id INTEGER PRIMARY KEY AUTOINCREMENT, cliente_cedula TEXT, venta_folio TEXT, monto_deuda REAL, abonado REAL DEFAULT 0.0, total_original REAL DEFAULT 0.0, monto_inicial REAL DEFAULT 0.0, num_cuotas INTEGER DEFAULT 1, frecuencia TEXT DEFAULT 'MENSUAL', estado TEXT DEFAULT 'PENDIENTE', fecha TEXT, FOREIGN KEY(cliente_cedula) REFERENCES clientes(cedula))''')
        c.execute('''CREATE TABLE IF NOT EXISTS creditos_cuotas (id INTEGER PRIMARY KEY AUTOINCREMENT, credito_id INTEGER, numero_cuota INTEGER, monto_cuota REAL, fecha_vencimiento TEXT, estado TEXT DEFAULT 'PENDIENTE', fecha_pago TEXT, metodo_pago TEXT, FOREIGN KEY(credito_id) REFERENCES creditos(id))''')
        c.execute('''CREATE TABLE IF NOT EXISTS config (id INTEGER PRIMARY KEY, tasa REAL, telefono TEXT, pts REAL, color TEXT, logo_url TEXT, plantilla_url TEXT, removebg_key TEXT, nombre_sistema TEXT, fuente TEXT, fuente_url TEXT)''')
        c.execute('''CREATE TABLE IF NOT EXISTS bitacora (id INTEGER PRIMARY KEY AUTOINCREMENT, fecha TEXT, usuario TEXT, accion TEXT, detalles TEXT)''')
        c.execute('''CREATE TABLE IF NOT EXISTS arqueos (id INTEGER PRIMARY KEY AUTOINCREMENT, fecha TEXT, cajero TEXT, contado_usd REAL)''')
        
        # NUEVAS TABLAS DE APOYO
        c.execute('''CREATE TABLE IF NOT EXISTS kardex (id INTEGER PRIMARY KEY AUTOINCREMENT, fecha TEXT, producto_id INTEGER, producto_nombre TEXT, tipo TEXT, cantidad REAL, stock_previo REAL, stock_nuevo REAL, costo_unitario REAL, motivo TEXT, usuario TEXT)''')
        c.execute('''CREATE TABLE IF NOT EXISTS turnos_caja (id INTEGER PRIMARY KEY AUTOINCREMENT, cajero TEXT, fecha_apertura TEXT, monto_inicial_usd REAL, monto_inicial_bs REAL, fecha_cierre TEXT, esperado_usd REAL, esperado_bs REAL, contado_usd REAL, contado_bs REAL, diferencia_usd REAL, diferencia_bs REAL, estado TEXT DEFAULT 'ABIERTO', notas TEXT)''')
        c.execute('''CREATE TABLE IF NOT EXISTS pedidos_remotos (id INTEGER PRIMARY KEY AUTOINCREMENT, folio TEXT UNIQUE, fecha TEXT, cliente_cedula TEXT, cliente_nombre TEXT, cliente_telefono TEXT, canal TEXT DEFAULT 'WhatsApp', estado TEXT DEFAULT 'PENDIENTE', items TEXT, subtotal REAL, costo_envio REAL DEFAULT 0.0, total REAL, metodo_pago TEXT, ref_pago TEXT, comprobante_url TEXT, tipo_entrega TEXT DEFAULT 'PICKUP', motorizado TEXT, direccion_envio TEXT, notas TEXT)''')

        # Auto-migración de columnas adicionales
        columnas_migracion = [
            ("config", "plantilla_url", "TEXT"),
            ("config", "removebg_key", "TEXT"),
            ("config", "nombre_sistema", "TEXT"),
            ("config", "fuente", "TEXT"),
            ("config", "fuente_url", "TEXT"),
            ("productos", "destacado", "INTEGER DEFAULT 0"),
            ("productos", "stock_minimo", "REAL DEFAULT 5.0"),
            ("productos", "es_combo", "INTEGER DEFAULT 0"),
            ("productos", "combo_items", "TEXT DEFAULT ''"),
            ("clientes", "instagram", "TEXT DEFAULT ''"),
            ("clientes", "notas", "TEXT DEFAULT ''"),
            ("clientes", "referencia_direccion", "TEXT DEFAULT ''"),
            ("creditos", "total_original", "REAL DEFAULT 0.0"),
            ("creditos", "monto_inicial", "REAL DEFAULT 0.0"),
            ("creditos", "num_cuotas", "INTEGER DEFAULT 1"),
            ("creditos", "frecuencia", "TEXT DEFAULT 'MENSUAL'"),
            ("ventas", "costo_envio", "REAL DEFAULT 0.0"),
            ("ventas", "tipo_entrega", "TEXT DEFAULT 'MOSTRADOR'"),
            ("ventas", "motorizado", "TEXT DEFAULT ''"),
            ("ventas", "comprobante_url", "TEXT DEFAULT ''"),
            ("ventas_items", "costo_unitario", "REAL DEFAULT 0.0"),
        ]

        for tabla, columna, tipo in columnas_migracion:
            try: c.execute(f"ALTER TABLE {tabla} ADD COLUMN {columna} {tipo}")
            except: pass

        c.execute("UPDATE config SET nombre_sistema = 'JCLIP' WHERE nombre_sistema IS NULL")
        c.execute("UPDATE config SET fuente = '''Plus Jakarta Sans''' WHERE fuente IS NULL")

        c.execute("SELECT COUNT(*) FROM usuarios")
        if c.fetchone()[0] == 0:
            hashed_pin = get_password_hash("1234") if SEGURIDAD_ACTIVA else "1234"
            c.execute("INSERT INTO usuarios (nombre, pin, rol) VALUES (?, ?, ?)", ('Admin Principal', hashed_pin, 'superadmin'))
            
        c.execute("SELECT COUNT(*) FROM config")
        if c.fetchone()[0] == 0:
            c.execute("INSERT INTO config (id, tasa, telefono, pts, color, logo_url, plantilla_url, removebg_key, nombre_sistema, fuente, fuente_url) VALUES (1, 38.50, '000000000', 1.0, '#845EC2', '', '', '', 'JCLIP', '''Plus Jakarta Sans''', '')")
            
        c.execute("SELECT COUNT(*) FROM categorias")
        if c.fetchone()[0] == 0:
            for cat in ['Electrónica', 'Accesorios', 'Hogar', 'Oficina', 'Alimentos']:
                c.execute("INSERT INTO categorias (nombre) VALUES (?)", (cat,))
                
        # Creador automático de cliente de Ventas Rápidas
        c.execute("INSERT OR IGNORE INTO clientes (cedula, nombre, telefono, direccion, puntos, foto) VALUES ('0', 'Ventas Rápidas', '0000', 'Mostrador', 0.0, '')")
        
        c.execute("COMMIT")
    except Exception as e:
        c.execute("ROLLBACK")
        print("Error inicializando BD:", e)
    finally:
        conn.close()

os.makedirs("static/img", exist_ok=True)
os.makedirs("static/img/comprobantes", exist_ok=True)
os.makedirs("static/fonts", exist_ok=True)

# ==========================================
# 5. ESTUDIO FOTOGRÁFICO Y EDICIÓN IA
# ==========================================
def procesar_foto_producto(imagen_bytes: bytes, api_key: str, plantilla_path: str, nombre_prod: str, sku_prod: str) -> io.BytesIO:
    img_data = imagen_bytes
    if api_key and api_key.strip() != "":
        try:
            res = requests.post(
                'https://api.remove.bg/v1.0/removebg',
                files={'image_file': imagen_bytes},
                data={'size': 'auto'},
                headers={'X-Api-Key': api_key},
                timeout=15
            )
            if res.status_code == requests.codes.ok:
                img_data = res.content
        except Exception as e:
            print("Error con Remove.bg, usando imagen original:", e)

    producto_img = Image.open(io.BytesIO(img_data)).convert("RGBA")
    producto_img = ImageEnhance.Contrast(producto_img).enhance(1.15)
    producto_img = ImageEnhance.Color(producto_img).enhance(1.10)

    ancho_lienzo = 800
    alto_lienzo = 1000

    if plantilla_path and os.path.exists(plantilla_path.lstrip('/')):
        fondo = Image.open(plantilla_path.lstrip('/')).convert("RGBA")
        fondo = fondo.resize((ancho_lienzo, alto_lienzo)) 
        
        producto_img.thumbnail((700, 550), Image.Resampling.LANCZOS)
        
        x = (fondo.width - producto_img.width) // 2
        y = (fondo.height - producto_img.height) // 2 + 30 
        
        fondo.paste(producto_img, (x, y), producto_img)
        final_img = fondo.convert("RGB")
    else:
        final_img = Image.new("RGB", (ancho_lienzo, alto_lienzo), (15, 10, 30))
        producto_img.thumbnail((700, 550), Image.Resampling.LANCZOS)
        x = (ancho_lienzo - producto_img.width) // 2
        y = (alto_lienzo - producto_img.height) // 2 + 30
        final_img.paste(producto_img, (x, y), mask=producto_img.split()[3] if len(producto_img.split()) == 4 else None)

    draw = ImageDraw.Draw(final_img)
    
    try:
        font_titulo = ImageFont.truetype("arialbd.ttf", 52)
        font_sku = ImageFont.truetype("arial.ttf", 36)
    except IOError:
        try:
            font_titulo = ImageFont.truetype("seguiemj.ttf", 52) 
            font_sku = ImageFont.truetype("seguiemj.ttf", 36)
        except IOError:
            font_titulo = ImageFont.load_default()
            font_sku = ImageFont.load_default()

    texto_sku = f"SKU: {sku_prod}"
    
    def get_text_width(text, font):
        if hasattr(draw, 'textbbox'):
            return draw.textbbox((0, 0), text, font=font)[2]
        else:
            return draw.textsize(text, font=font)[0]

    w_titulo = get_text_width(nombre_prod, font_titulo)
    w_sku = get_text_width(texto_sku, font_sku)

    # Posicionamiento: Nombre arriba, SKU abajo
    x_titulo = (ancho_lienzo - w_titulo) / 2
    y_titulo = 160

    x_sku = (ancho_lienzo - w_sku) / 2
    y_sku = alto_lienzo - 80

    draw.text((x_titulo, y_titulo), nombre_prod, fill=(255, 255, 255), font=font_titulo, stroke_width=2, stroke_fill=(0, 0, 0))
    draw.text((x_sku, y_sku), texto_sku, fill=(100, 255, 255), font=font_sku, stroke_width=2, stroke_fill=(0, 0, 0))

    output = io.BytesIO()
    final_img.save(output, format="JPEG", quality=92)
    output.seek(0)
    return output

# ==========================================
# 6. CICLO DE VIDA Y APLICACIÓN FASTAPI
# ==========================================
@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    scheduler = None
    if RELOJ_ACTIVO:
        def actualizar_tasa_bcv_automatica():
            try:
                tasa_actual = obtener_tasa_bcv_nube()
                if tasa_actual and float(tasa_actual) > 0:
                    conn = get_db()
                    conn.execute("UPDATE config SET tasa = ? WHERE id = 1", (float(tasa_actual),))
                    conn.commit()
                    conn.close()
                    log_accion("Sistema", "Tasa BCV Automática", f"Tasa actualizada automáticamente a: Bs. {tasa_actual}")
            except Exception: pass
        scheduler = BackgroundScheduler()
        scheduler.add_job(actualizar_tasa_bcv_automatica, 'cron', hour=8, minute=0)
        scheduler.start()
    yield
    if scheduler: scheduler.shutdown()

app = FastAPI(title="JCLIP PRO ULTRA - ERP Enterprise", lifespan=lifespan)
app.mount("/static", StaticFiles(directory="static"), name="static")

# Middleware de Seguridad HTTP
@app.middleware("http")
async def add_security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "SAMEORIGIN"
    response.headers["X-XSS-Protection"] = "1; mode=block"
    return response

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], 
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ==========================================
# 7. RUTAS ESTÁTICAS Y VISTAS
# ==========================================
@app.get("/")
def serve_index(): return FileResponse("index.html")

@app.get("/app.js")
def serve_js(): return FileResponse("app.js")

@app.get("/styles.css")
def serve_css(): return FileResponse("styles.css")

@app.get("/cliente")
def serve_cliente(): return FileResponse("cliente.html")

@app.get("/icono.png")
def serve_favicon(): 
    if os.path.exists("icono.png"):
        return FileResponse("icono.png")
    return {"status": "Icono predeterminado"}

# ==========================================
# 8. AUTENTICACIÓN JWT Y CONTROL DE ROLES
# ==========================================
def create_access_token(data: dict):
    if not SEGURIDAD_ACTIVA: raise HTTPException(500, "Librerías de seguridad inactivas")
    to_encode = data.copy()
    expire = datetime.utcnow() + timedelta(hours=ACCESS_TOKEN_EXPIRE_HOURS)
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)

def get_current_user(token: str = Depends(oauth2_scheme)):
    if not SEGURIDAD_ACTIVA: raise HTTPException(500, "Librerías de seguridad inactivas")
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        usuario: str = payload.get("sub")
        rol: str = payload.get("rol")
        if usuario is None or rol is None: raise HTTPException(status_code=401, detail="Token inválido")
        return {"nombre": usuario, "rol": rol}
    except jwt.PyJWTError:
        raise HTTPException(status_code=401, detail="Token expirado o inválido")

def require_admin(user: dict = Depends(get_current_user)):
    if user["rol"] not in ["admin", "superadmin"]: raise HTTPException(status_code=403, detail="Privilegios insuficientes")
    return user

def require_superadmin(user: dict = Depends(get_current_user)):
    if user["rol"] != "superadmin": raise HTTPException(status_code=403, detail="Privilegios exclusivos del dueño")
    return user

def require_supervisor(user: dict = Depends(get_current_user)):
    if user["rol"] not in ["supervisor", "admin", "superadmin"]: raise HTTPException(status_code=403, detail="Requiere rol supervisor o superior")
    return user

# Modelos Pydantic
class AuthRequest(BaseModel):
    usuario: str
    pin: str

class VentaItemInput(BaseModel):
    id: int
    cantidad: float
    variante_idx: Optional[int] = None

class VentaRequest(BaseModel):
    cliente_cedula: str
    descuento_porc: float
    iva_porc: float
    puntos_a_canjear: float
    metodos_pago: str
    es_credito: bool
    productos: List[VentaItemInput]
    costo_envio: Optional[float] = 0.0
    tipo_entrega: Optional[str] = "MOSTRADOR"
    motorizado: Optional[str] = ""
    comprobante_url: Optional[str] = ""
    inicial_credito: Optional[float] = 0.0
    num_cuotas: Optional[int] = 1
    frecuencia_cuotas: Optional[str] = "MENSUAL"

class ProveedorRequest(BaseModel):
    empresa: str
    vendedor: str
    telefono: str

class GastoRequest(BaseModel):
    categoria: str
    descripcion: str
    monto: float

class DevolucionRequest(BaseModel):
    folio: str
    monto: float
    devolver_stock: bool

class ArqueoRequest(BaseModel):
    contado_usd: float

class MermaRequest(BaseModel):
    producto_id: int
    cantidad: float
    motivo: str

class AjusteStockRequest(BaseModel):
    producto_id: int
    nuevo_stock: float
    motivo: str

class TurnoAbrirRequest(BaseModel):
    monto_inicial_usd: float
    monto_inicial_bs: float
    notas: Optional[str] = ""

class TurnoCerrarRequest(BaseModel):
    contado_usd: float
    contado_bs: float
    notas: Optional[str] = ""

class CuotaPagarRequest(BaseModel):
    monto: float
    metodo_pago: Optional[str] = "Efectivo ($)"

class PedidoRemotoRequest(BaseModel):
    cliente_cedula: str
    cliente_nombre: str
    cliente_telefono: str
    canal: str = "WhatsApp"
    items: str
    subtotal: float
    costo_envio: float = 0.0
    total: float
    metodo_pago: str = "Pago Móvil (Bs)"
    ref_pago: str = ""
    comprobante_url: str = ""
    tipo_entrega: str = "DELIVERY"
    motorizado: str = ""
    direccion_envio: str = ""
    notas: str = ""

class PedidoEstadoRequest(BaseModel):
    estado: str
    motorizado: Optional[str] = None

@app.post("/api/auth")
def login(req: AuthRequest, request: Request):
    client_ip = request.client.host if request.client else "Local"
    check_rate_limit(client_ip)

    if not SEGURIDAD_ACTIVA: raise HTTPException(500, "Instala bcrypt y pyjwt para iniciar sesión de forma segura")
    conn = get_db(); c = conn.cursor()
    c.execute("SELECT id, nombre, pin, rol, foto FROM usuarios WHERE nombre=?", (req.usuario,))
    user = c.fetchone(); conn.close()
    
    if not user or not verify_password(req.pin, user['pin']):
        record_failed_login(client_ip)
        log_accion("Sistema", "Acceso Fallido", f"Intento fallido con usuario '{req.usuario}'", client_ip)
        raise HTTPException(status_code=401, detail="Credenciales incorrectas")
    
    token = create_access_token(data={"sub": user['nombre'], "rol": user['rol']})
    log_accion(user['nombre'], "Inicio de Sesión", f"Rol: {user['rol']}", client_ip)
    return {"token": token, "user": {"nombre": user['nombre'], "rol": user['rol'], "foto": user['foto']}}

# ==========================================
# 9. BITÁCORA Y AUDITORÍA
# ==========================================
@app.get("/api/bitacora")
def get_bitacora(user: dict = Depends(require_admin)):
    conn = get_db(); c = conn.cursor()
    c.execute("SELECT * FROM bitacora ORDER BY id DESC LIMIT 200")
    logs = [dict(r) for r in c.fetchall()]; conn.close()
    return logs

# ==========================================
# 10. CONFIGURACIÓN Y TASA BCV
# ==========================================
@app.get("/api/config")
def get_config():
    conn = get_db(); c = conn.cursor()
    c.execute("SELECT tasa, telefono, pts, color, logo_url, plantilla_url, removebg_key, nombre_sistema, fuente, fuente_url FROM config WHERE id=1")
    row = c.fetchone(); conn.close()
    return dict(row) if row else {}

@app.post("/api/config")
def update_config(
    tasa: float = Form(...),
    color: str = Form("#845EC2"),
    removebg_key: str = Form(""),
    nombre_sistema: str = Form("JCLIP"),
    fuente: str = Form("'Plus Jakarta Sans'"),
    logo: UploadFile = File(None),
    plantilla: UploadFile = File(None),
    archivo_fuente: UploadFile = File(None),
    user: dict = Depends(require_superadmin)
):
    validate_image_upload(logo)
    validate_image_upload(plantilla)
    validate_font_upload(archivo_fuente)

    conn = get_db(); c = conn.cursor()
    query = "UPDATE config SET tasa = ?, color = ?, removebg_key = ?, nombre_sistema = ?, fuente = ?"
    params = [tasa, color, removebg_key, nombre_sistema, fuente]
    
    if logo and logo.filename:
        ext = logo.filename.split(".")[-1]; filename = f"logo_{int(time.time())}.{ext}"; path = f"static/img/{filename}"
        with open(path, "wb") as buffer: shutil.copyfileobj(logo.file, buffer)
        query += ", logo_url = ?"; params.append(f"/{path}")
        
    if plantilla and plantilla.filename:
        ext = plantilla.filename.split(".")[-1]; filename = f"plantilla_{int(time.time())}.{ext}"; path = f"static/img/{filename}"
        with open(path, "wb") as buffer: shutil.copyfileobj(plantilla.file, buffer)
        query += ", plantilla_url = ?"; params.append(f"/{path}")

    if archivo_fuente and archivo_fuente.filename:
        ext = archivo_fuente.filename.split(".")[-1]; filename = f"font_{int(time.time())}.{ext}"; path = f"static/fonts/{filename}"
        with open(path, "wb") as buffer: shutil.copyfileobj(archivo_fuente.file, buffer)
        query += ", fuente_url = ?"; params.append(f"/{path}")
        
    query += " WHERE id=1"
    c.execute(query, tuple(params)); conn.commit(); conn.close()
    log_accion(user['nombre'], "Actualización de Configuración", f"Tasa: {tasa}, Sistema: {nombre_sistema}, Color: {color}")
    return {"status": "ok"}

@app.post("/api/config/sync_bcv")
def sync_bcv_manual(user: dict = Depends(require_superadmin)):
    try:
        tasa_actual = obtener_tasa_bcv_nube()
        if tasa_actual and tasa_actual > 0:
            conn = get_db()
            conn.execute("UPDATE config SET tasa = ? WHERE id = 1", (tasa_actual,))
            conn.commit(); conn.close()
            log_accion(user['nombre'], "Sincronización BCV Manual", f"Nueva Tasa: Bs. {tasa_actual}")
            return {"status": "ok", "tasa": tasa_actual}
        raise Exception("Tasa BCV inválida extraída de la nube.")
    except Exception as e:
        raise HTTPException(400, str(e))

# ==========================================
# 11. CATEGORÍAS
# ==========================================
@app.get("/api/categorias")
def get_categorias():
    conn = get_db(); c = conn.cursor()
    c.execute("SELECT id, nombre FROM categorias ORDER BY nombre ASC")
    cats = [dict(r) for r in c.fetchall()]; conn.close()
    return cats

@app.post("/api/categorias")
def create_categoria(nombre: str = Form(...), user: dict = Depends(require_supervisor)):
    conn = get_db()
    conn.execute("INSERT INTO categorias (nombre) VALUES (?)", (nombre,))
    conn.commit(); conn.close()
    log_accion(user['nombre'], "Crear Categoría", f"Nombre: {nombre}")
    return {"status": "ok"}

# ==========================================
# 12. PRODUCTOS, INVENTARIO Y COMBOS
# ==========================================
@app.get("/api/productos")
def get_productos(token: str = Depends(oauth2_scheme_opt)):
    conn = get_db(); c = conn.cursor(); es_admin = False
    if token and SEGURIDAD_ACTIVA:
        try:
            payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
            if payload.get("rol") in ["superadmin", "admin", "supervisor"]: es_admin = True
        except: pass
    if es_admin:
        c.execute("SELECT * FROM productos ORDER BY id DESC")
    else:
        c.execute("SELECT id, codigo, nombre, descripcion, categoria, precio, stock, es_peso, variantes, vencimiento, imagen_url, destacado, stock_minimo, es_combo, combo_items FROM productos ORDER BY id DESC")
    prods = [dict(r) for r in c.fetchall()]; conn.close()
    return prods

@app.post("/api/productos")
def create_producto(
    codigo: str = Form(...),
    nombre: str = Form(...),
    descripcion: str = Form(""),
    categoria: str = Form("General"),
    proveedor: str = Form("[]"),
    costo: float = Form(0.0),
    precio: float = Form(0.0),
    stock: float = Form(0.0),
    es_peso: int = Form(0),
    variantes: str = Form(""),
    vencimiento: str = Form(""),
    destacado: int = Form(0),
    stock_minimo: float = Form(5.0),
    es_combo: int = Form(0),
    combo_items: str = Form(""),
    imagen: UploadFile = File(None),
    user: dict = Depends(require_supervisor)
):
    validate_image_upload(imagen)
    conn = get_db(); c = conn.cursor()
    img_url = None
    
    if imagen and imagen.filename:
        c.execute("SELECT plantilla_url, removebg_key FROM config WHERE id=1")
        cfg = c.fetchone()
        imagen_bytes = imagen.file.read()
        procesada = procesar_foto_producto(imagen_bytes, cfg['removebg_key'], cfg['plantilla_url'], nombre, codigo)
        filename = f"prod_{int(time.time())}.jpg"; path = f"static/img/{filename}"
        with open(path, "wb") as f: f.write(procesada.getbuffer())
        img_url = f"/{path}"
        
    c.execute('''INSERT INTO productos (codigo, nombre, descripcion, categoria, proveedor, costo, precio, stock, es_peso, variantes, vencimiento, imagen_url, destacado, stock_minimo, es_combo, combo_items) 
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)''',
              (codigo, nombre, descripcion, categoria, proveedor, costo, precio, stock, es_peso, variantes, vencimiento, img_url, destacado, stock_minimo, es_combo, combo_items))
    prod_id = c.lastrowid
    
    # Registro en Kardex de inventario inicial
    if stock > 0:
        registrar_kardex(c, prod_id, nombre, "COMPRA/INICIAL", stock, 0.0, stock, costo, "Creación de Producto - Stock Inicial", user['nombre'])
    
    conn.commit(); conn.close()
    log_accion(user['nombre'], "Crear Producto", f"SKU: {codigo}, Nombre: {nombre}, Precio: ${precio}")
    return {"status": "ok", "id": prod_id}

@app.put("/api/productos/{id}")
def update_producto(
    id: int,
    codigo: str = Form(...),
    nombre: str = Form(...),
    descripcion: str = Form(""),
    categoria: str = Form("General"),
    proveedor: str = Form("[]"),
    costo: float = Form(0.0),
    precio: float = Form(0.0),
    stock: float = Form(0.0),
    es_peso: int = Form(0),
    variantes: str = Form(""),
    vencimiento: str = Form(""),
    destacado: int = Form(0),
    stock_minimo: float = Form(5.0),
    es_combo: int = Form(0),
    combo_items: str = Form(""),
    imagen: UploadFile = File(None),
    user: dict = Depends(require_supervisor)
):
    validate_image_upload(imagen)
    conn = get_db(); c = conn.cursor()
    
    c.execute("SELECT stock, costo FROM productos WHERE id=?", (id,))
    previo = c.fetchone()
    stock_prev = previo['stock'] if previo else 0.0
    
    if imagen and imagen.filename:
        c.execute("SELECT plantilla_url, removebg_key FROM config WHERE id=1")
        cfg = c.fetchone()
        imagen_bytes = imagen.file.read()
        procesada = procesar_foto_producto(imagen_bytes, cfg['removebg_key'], cfg['plantilla_url'], nombre, codigo)
        filename = f"prod_{int(time.time())}.jpg"; path = f"static/img/{filename}"
        with open(path, "wb") as f: f.write(procesada.getbuffer())
        img_url = f"/{path}"
        c.execute('''UPDATE productos SET codigo=?, nombre=?, descripcion=?, categoria=?, proveedor=?, costo=?, precio=?, stock=?, es_peso=?, variantes=?, vencimiento=?, imagen_url=?, destacado=?, stock_minimo=?, es_combo=?, combo_items=? WHERE id=?''',
                  (codigo, nombre, descripcion, categoria, proveedor, costo, precio, stock, es_peso, variantes, vencimiento, img_url, destacado, stock_minimo, es_combo, combo_items, id))
    else:
        c.execute('''UPDATE productos SET codigo=?, nombre=?, descripcion=?, categoria=?, proveedor=?, costo=?, precio=?, stock=?, es_peso=?, variantes=?, vencimiento=?, destacado=?, stock_minimo=?, es_combo=?, combo_items=? WHERE id=?''',
                  (codigo, nombre, descripcion, categoria, proveedor, costo, precio, stock, es_peso, variantes, vencimiento, destacado, stock_minimo, es_combo, combo_items, id))
    
    if abs(stock - stock_prev) > 0.001:
        tipo_mov = "AJUSTE" if stock > stock_prev else "AJUSTE/BAJA"
        registrar_kardex(c, id, nombre, tipo_mov, abs(stock - stock_prev), stock_prev, stock, costo, "Ajuste manual desde edición", user['nombre'])

    conn.commit(); conn.close()
    log_accion(user['nombre'], "Editar Producto", f"ID: {id}, Nombre: {nombre}, Stock: {stock}, Precio: ${precio}")
    return {"status": "ok"}

@app.delete("/api/productos/{id}")
def delete_producto(id: int, user: dict = Depends(require_supervisor)):
    conn = get_db(); c = conn.cursor()
    c.execute("SELECT nombre, codigo FROM productos WHERE id=?", (id,))
    prod = c.fetchone()
    conn.execute("DELETE FROM productos WHERE id=?", (id,))
    conn.commit(); conn.close()
    log_accion(user['nombre'], "Eliminar Producto", f"ID: {id}, Nombre: {prod['nombre'] if prod else 'Desconocido'}")
    return {"status": "ok"}

# ==========================================
# 12.1 KARDEX, MERMAS Y AJUSTES
# ==========================================
@app.get("/api/kardex")
def get_kardex(producto_id: Optional[int] = None, limit: int = 200, user: dict = Depends(get_current_user)):
    conn = get_db(); c = conn.cursor()
    if producto_id:
        c.execute("SELECT * FROM kardex WHERE producto_id = ? ORDER BY id DESC LIMIT ?", (producto_id, limit))
    else:
        c.execute("SELECT * FROM kardex ORDER BY id DESC LIMIT ?", (limit,))
    rows = [dict(r) for r in c.fetchall()]; conn.close()
    return rows

@app.post("/api/mermas")
def registrar_merma(req: MermaRequest, user: dict = Depends(require_supervisor)):
    conn = get_db(); c = conn.cursor()
    try:
        c.execute("BEGIN TRANSACTION")
        c.execute("SELECT nombre, stock, costo FROM productos WHERE id=?", (req.producto_id,))
        prod = c.fetchone()
        if not prod: raise Exception("Producto no encontrado")
        if prod['stock'] < req.cantidad: raise Exception(f"Stock insuficiente para merma ({prod['stock']} disponible)")
        
        nuevo_stock = round(prod['stock'] - req.cantidad, 2)
        c.execute("UPDATE productos SET stock=? WHERE id=?", (nuevo_stock, req.producto_id))
        
        registrar_kardex(c, req.producto_id, prod['nombre'], "MERMA", req.cantidad, prod['stock'], nuevo_stock, prod['costo'], req.motivo, user['nombre'])
        
        c.execute("COMMIT")
        log_accion(user['nombre'], "Merma Registrada", f"Producto: {prod['nombre']}, Cant: {req.cantidad}, Motivo: {req.motivo}")
        return {"status": "ok", "nuevo_stock": nuevo_stock}
    except Exception as e:
        c.execute("ROLLBACK")
        raise HTTPException(400, str(e))
    finally:
        conn.close()

# ==========================================
# 13. CLIENTES, CRM E HISTORIAL 360
# ==========================================
@app.get("/api/clientes")
def get_clientes(user: dict = Depends(get_current_user)):
    conn = get_db(); c = conn.cursor()
    c.execute("SELECT * FROM clientes ORDER BY nombre ASC")
    clientes = [dict(r) for r in c.fetchall()]; conn.close()
    return clientes

@app.post("/api/clientes")
def create_cliente(
    cedula: str = Form(...),
    nombre: str = Form(...),
    telefono: str = Form(""),
    direccion: str = Form(""),
    instagram: str = Form(""),
    notas: str = Form(""),
    referencia_direccion: str = Form(""),
    foto: UploadFile = File(None),
    user: dict = Depends(get_current_user)
):
    validate_image_upload(foto)
    img_url = None
    if foto and foto.filename:
        ext = foto.filename.split(".")[-1]; filename = f"cli_{int(time.time())}.{ext}"; path = f"static/img/{filename}"
        with open(path, "wb") as buffer: shutil.copyfileobj(foto.file, buffer)
        img_url = f"/{path}"
    conn = get_db()
    conn.execute('''INSERT INTO clientes (cedula, nombre, telefono, direccion, puntos, foto, instagram, notas, referencia_direccion) 
                    VALUES (?, ?, ?, ?, COALESCE((SELECT puntos FROM clientes WHERE cedula=?), 0.0), COALESCE(?, (SELECT foto FROM clientes WHERE cedula=?)), ?, ?, ?)
                    ON CONFLICT(cedula) DO UPDATE SET 
                        nombre=excluded.nombre, 
                        telefono=excluded.telefono, 
                        direccion=excluded.direccion, 
                        foto=COALESCE(excluded.foto, clientes.foto),
                        instagram=excluded.instagram,
                        notas=excluded.notas,
                        referencia_direccion=excluded.referencia_direccion''',
                 (cedula, nombre, telefono, direccion, cedula, img_url, cedula, instagram, notas, referencia_direccion))
    conn.commit(); conn.close()
    log_accion(user['nombre'], "Guardar Cliente", f"Cédula: {cedula}, Nombre: {nombre}")
    return {"status": "ok"}

@app.get("/api/clientes/{cedula}/historial")
def get_cliente_historial(cedula: str, user: dict = Depends(get_current_user)):
    conn = get_db(); c = conn.cursor()
    c.execute("SELECT * FROM clientes WHERE cedula=?", (cedula,))
    cliente = c.fetchone()
    if not cliente:
        conn.close()
        raise HTTPException(404, "Cliente no encontrado")
    
    # Compras / Facturas
    c.execute("SELECT * FROM ventas WHERE cliente_cedula=? ORDER BY fecha DESC", (cedula,))
    ventas = [dict(v) for v in c.fetchall()]
    
    for v in ventas:
        c.execute("SELECT * FROM ventas_items WHERE venta_folio=?", (v['folio'],))
        v['items'] = [dict(i) for i in c.fetchall()]
        
    # Créditos y Cuotas
    c.execute("SELECT * FROM creditos WHERE cliente_cedula=? ORDER BY id DESC", (cedula,))
    creditos = [dict(cr) for cr in c.fetchall()]
    for cr in creditos:
        c.execute("SELECT * FROM creditos_cuotas WHERE credito_id=? ORDER BY numero_cuota ASC", (cr['id'],))
        cr['cuotas'] = [dict(cu) for cu in c.fetchall()]
        
    conn.close()
    return {
        "cliente": dict(cliente),
        "total_comprado_usd": sum(v['total_usd'] for v in ventas),
        "total_compras": len(ventas),
        "ventas": ventas,
        "creditos": creditos
    }

@app.delete("/api/clientes/{cedula}")
def delete_cliente(cedula: str, user: dict = Depends(require_supervisor)):
    if cedula == "0":
        raise HTTPException(400, "No se puede eliminar el cliente de Ventas Rápidas")
    conn = get_db()
    conn.execute("DELETE FROM clientes WHERE cedula=?", (cedula,))
    conn.commit(); conn.close()
    log_accion(user['nombre'], "Eliminar Cliente", f"Cédula: {cedula}")
    return {"status": "ok"}

# ==========================================
# 14. PERSONAL Y USUARIOS
# ==========================================
@app.get("/api/usuarios")
def get_usuarios(user: dict = Depends(require_admin)):
    conn = get_db(); c = conn.cursor()
    c.execute("SELECT id, nombre, rol, foto FROM usuarios")
    usuarios = [dict(r) for r in c.fetchall()]; conn.close()
    return usuarios

@app.post("/api/usuarios")
def create_usuario(
    nombre: str = Form(...),
    pin: str = Form(...),
    rol: str = Form(...),
    foto: UploadFile = File(None),
    user: dict = Depends(require_admin)
):
    validate_image_upload(foto)
    img_url = None
    if foto and foto.filename:
        ext = foto.filename.split(".")[-1]; filename = f"usr_{int(time.time())}.{ext}"; path = f"static/img/{filename}"
        with open(path, "wb") as buffer: shutil.copyfileobj(foto.file, buffer)
        img_url = f"/{path}"
    hashed_pin = get_password_hash(pin) if SEGURIDAD_ACTIVA else pin
    conn = get_db()
    conn.execute("INSERT INTO usuarios (nombre, pin, rol, foto) VALUES (?, ?, ?, ?)", (nombre, hashed_pin, rol, img_url))
    conn.commit(); conn.close()
    log_accion(user['nombre'], "Crear Usuario", f"Nombre: {nombre}, Rol: {rol}")
    return {"status": "ok"}

@app.put("/api/usuarios/{id}")
def update_usuario(
    id: int,
    nombre: str = Form(...),
    pin: str = Form(""),
    rol: str = Form(...),
    foto: UploadFile = File(None),
    user: dict = Depends(require_admin)
):
    conn = get_db(); c = conn.cursor()
    c.execute("SELECT rol FROM usuarios WHERE id=?", (id,))
    target = c.fetchone()
    if target and target['rol'] == 'superadmin' and user['rol'] != 'superadmin':
        raise HTTPException(403, "Seguridad: No tienes permiso para editar al Dueño del sistema.")
    validate_image_upload(foto)
    img_query = ""; params = [nombre, rol]
    if pin != "":
        img_query += ", pin=?"; params.append(get_password_hash(pin) if SEGURIDAD_ACTIVA else pin)
    if foto and foto.filename:
        ext = foto.filename.split(".")[-1]; filename = f"usr_{int(time.time())}.{ext}"; path = f"static/img/{filename}"
        with open(path, "wb") as buffer: shutil.copyfileobj(foto.file, buffer)
        img_query += ", foto=?"; params.append(f"/{path}")
    params.append(id)
    c.execute(f"UPDATE usuarios SET nombre=?, rol=? {img_query} WHERE id=?", tuple(params))
    conn.commit(); conn.close()
    log_accion(user['nombre'], "Editar Usuario", f"ID: {id}, Nombre: {nombre}, Rol: {rol}")
    return {"status": "ok"}

@app.delete("/api/usuarios/{id}")
def delete_usuario(id: int, user: dict = Depends(require_admin)):
    conn = get_db(); c = conn.cursor()
    c.execute("SELECT nombre, rol FROM usuarios WHERE id=?", (id,))
    target = c.fetchone()
    if target and target['rol'] == 'superadmin' and user['rol'] != 'superadmin':
        raise HTTPException(403, "Seguridad: No tienes permiso para eliminar al Dueño del sistema.")
    c.execute("DELETE FROM usuarios WHERE id=?", (id,))
    conn.commit(); conn.close()
    log_accion(user['nombre'], "Eliminar Usuario", f"ID: {id}, Nombre: {target['nombre'] if target else 'Desconocido'}")
    return {"status": "ok"}

# ==========================================
# 15. PROVEEDORES
# ==========================================
@app.get("/api/proveedores")
def get_proveedores(user: dict = Depends(get_current_user)):
    conn = get_db(); c = conn.cursor()
    c.execute("SELECT * FROM proveedores")
    provs = [dict(r) for r in c.fetchall()]; conn.close()
    return provs

@app.post("/api/proveedores")
def create_proveedor(req: ProveedorRequest, user: dict = Depends(require_supervisor)):
    conn = get_db()
    conn.execute("INSERT INTO proveedores (empresa, vendedor, telefono) VALUES (?, ?, ?)", (req.empresa, req.vendedor, req.telefono))
    conn.commit(); conn.close()
    log_accion(user['nombre'], "Crear Proveedor", f"Empresa: {req.empresa}, Vendedor: {req.vendedor}")
    return {"status": "ok"}

# ==========================================
# 16. FACTURACIÓN, VENTAS Y COMBOS
# ==========================================
@app.post("/api/ventas")
def procesar_venta(req: VentaRequest, user: dict = Depends(get_current_user)):
    conn = get_db(); c = conn.cursor()
    try:
        c.execute("BEGIN TRANSACTION")
        folio = f"ORD-{datetime.now().strftime('%Y%m%d')}-{str(uuid.uuid4())[:6].upper()}"
        fecha = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        suma_productos = 0.0
        items_registrados = []

        for item in req.productos:
            c.execute("SELECT id, nombre, precio, stock, costo, es_combo, combo_items FROM productos WHERE id=?", (item.id,))
            prod_db = c.fetchone()
            if not prod_db:
                raise Exception(f"Producto ID {item.id} no existe")
            precio_unitario = prod_db['precio']
            nombre_item = prod_db['nombre']
            costo_unit = prod_db['costo']

            if prod_db['es_combo'] == 1 and prod_db['combo_items']:
                # ES UN COMBO: Descontar componentes hijos del inventario matriz
                try:
                    componentes = json.loads(prod_db['combo_items'])
                except Exception:
                    componentes = []
                
                for comp in componentes:
                    comp_id = int(comp.get("id"))
                    comp_qty = float(comp.get("cantidad", 1)) * item.cantidad
                    c.execute("SELECT nombre, stock, costo FROM productos WHERE id=?", (comp_id,))
                    comp_db = c.fetchone()
                    if not comp_db: raise Exception(f"Componente ID {comp_id} del combo no existe")
                    if comp_db['stock'] < comp_qty:
                        raise Exception(f"Stock insuficiente en componente '{comp_db['nombre']}' del combo '{nombre_item}'")
                    
                    nuevo_st = round(comp_db['stock'] - comp_qty, 2)
                    c.execute("UPDATE productos SET stock=? WHERE id=?", (nuevo_st, comp_id))
                    registrar_kardex(c, comp_id, comp_db['nombre'], "VENTA/COMBO", comp_qty, comp_db['stock'], nuevo_st, comp_db['costo'], f"Venta Combo {folio}", user['nombre'])
                
                # Descontar stock simbólico del combo si aplica
                c.execute("UPDATE productos SET stock = stock - ? WHERE id = ?", (item.cantidad, item.id))
                registrar_kardex(c, item.id, nombre_item, "VENTA", item.cantidad, prod_db['stock'], prod_db['stock'] - item.cantidad, costo_unit, f"Venta Folio {folio}", user['nombre'])

            else:
                # PRODUCTO ESTÁNDAR
                c.execute("UPDATE productos SET stock = stock - ? WHERE id = ? AND stock >= ?", (item.cantidad, item.id, item.cantidad))
                if c.rowcount == 0:
                    raise Exception(f"Stock insuficiente para: {nombre_item}")
                
                nuevo_st = round(prod_db['stock'] - item.cantidad, 2)
                registrar_kardex(c, item.id, nombre_item, "VENTA", item.cantidad, prod_db['stock'], nuevo_st, costo_unit, f"Venta Folio {folio}", user['nombre'])

            item_sub = round(precio_unitario * item.cantidad, 2)
            suma_productos += item_sub
            items_registrados.append((folio, item.id, nombre_item, item.cantidad, precio_unitario, item_sub, costo_unit))

        # Cálculo Inclusivo de Descuentos, Impuestos y Delivery
        suma_productos = round(suma_productos, 2)
        descuento = round(suma_productos * (req.descuento_porc / 100), 2)
        total_con_iva = round(suma_productos - descuento, 2)
        base_imp = round(total_con_iva / (1 + (req.iva_porc / 100)), 2)
        iva = round(total_con_iva - base_imp, 2)
        
        puntos_validados = 0.0
        if req.cliente_cedula != "0" and req.puntos_a_canjear > 0:
            c.execute("SELECT puntos FROM clientes WHERE cedula=?", (req.cliente_cedula,))
            cli_db = c.fetchone()
            if cli_db and cli_db['puntos'] >= req.puntos_a_canjear:
                puntos_validados = req.puntos_a_canjear
                c.execute("UPDATE clientes SET puntos = puntos - ? WHERE cedula=?", (puntos_validados, req.cliente_cedula))
            else:
                raise Exception("El cliente no tiene puntos suficientes para este canje")
                
        total_final = round(total_con_iva - puntos_validados + (req.costo_envio or 0.0), 2)

        c.execute('''INSERT INTO ventas (folio, fecha, cajero, cliente_cedula, subtotal, descuento, iva, puntos_canjeados, total_usd, metodos_pago, vuelto, costo_envio, tipo_entrega, motorizado, comprobante_url) 
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)''',
                  (folio, fecha, user['nombre'], req.cliente_cedula, suma_productos, descuento, iva, puntos_validados, total_final, req.metodos_pago, 0.0, req.costo_envio or 0.0, req.tipo_entrega or 'MOSTRADOR', req.motorizado or '', req.comprobante_url or ''))
        
        c.executemany('''INSERT INTO ventas_items (venta_folio, producto_id, nombre, cantidad, precio, subtotal, costo_unitario) VALUES (?, ?, ?, ?, ?, ?, ?)''', items_registrados)
        
        # Gestión de Créditos y Cuotas
        if req.cliente_cedula != "0":
            if req.es_credito:
                inicial = round(req.inicial_credito or 0.0, 2)
                saldo_deuda = round(total_final - inicial, 2)
                n_cuotas = max(1, req.num_cuotas or 1)
                frecuencia = req.frecuencia_cuotas or 'MENSUAL'
                
                c.execute('''INSERT INTO creditos (cliente_cedula, venta_folio, monto_deuda, abonado, total_original, monto_inicial, num_cuotas, frecuencia, estado, fecha) 
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)''', 
                          (req.cliente_cedula, folio, saldo_deuda, 0.0, total_final, inicial, n_cuotas, frecuencia, 'PENDIENTE' if saldo_deuda > 0 else 'PAGADO', fecha))
                credito_id = c.lastrowid
                
                # Generar Cronograma de Cuotas
                dias_frec = 7 if frecuencia == 'SEMANAL' else (15 if frecuencia == 'QUINCENAL' else 30)
                monto_por_cuota = round(saldo_deuda / n_cuotas, 2)
                for i in range(1, n_cuotas + 1):
                    vence = (datetime.now() + timedelta(days=dias_frec * i)).strftime("%Y-%m-%d")
                    # Ajuste de centavos en la última cuota
                    m_cuota = monto_por_cuota if i < n_cuotas else round(saldo_deuda - (monto_por_cuota * (n_cuotas - 1)), 2)
                    c.execute('''INSERT INTO creditos_cuotas (credito_id, numero_cuota, monto_cuota, fecha_vencimiento, estado) VALUES (?, ?, ?, ?, 'PENDIENTE')''',
                              (credito_id, i, m_cuota, vence))
            else:
                c.execute("UPDATE clientes SET puntos = puntos + ? WHERE cedula = ?", (round(total_final * 0.05, 2), req.cliente_cedula))
                
        c.execute("COMMIT")
        log_accion(user['nombre'], "Venta Procesada", f"Folio: {folio}, Total: ${total_final}, Cliente: {req.cliente_cedula}")
        return {"status": "ok", "folio": folio, "total": total_final}
    except Exception as e:
        c.execute("ROLLBACK")
        raise HTTPException(status_code=400, detail=str(e))
    finally:
        conn.close()

@app.get("/api/ventas/historial")
def historial_ventas(user: dict = Depends(get_current_user)):
    conn = get_db(); c = conn.cursor()
    c.execute("SELECT * FROM ventas ORDER BY fecha DESC LIMIT 500")
    ventas = [dict(r) for r in c.fetchall()]; conn.close()
    return ventas

# ==========================================
# 17. GASTOS Y DEVOLUCIONES
# ==========================================
@app.post("/api/gastos")
def registrar_gasto(req: GastoRequest, user: dict = Depends(require_supervisor)):
    fecha = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    conn = get_db()
    conn.execute("INSERT INTO gastos (fecha, categoria, descripcion, monto, cajero) VALUES (?, ?, ?, ?, ?)",
                 (fecha, req.categoria, req.descripcion, req.monto, user['nombre']))
    conn.commit(); conn.close()
    log_accion(user['nombre'], "Gasto Registrado", f"Monto: ${req.monto}, Categoria: {req.categoria}, Motivo: {req.descripcion}")
    return {"status": "ok"}

@app.post("/api/devolucion")
def procesar_devolucion(req: DevolucionRequest, user: dict = Depends(require_supervisor)):
    conn = get_db(); c = conn.cursor()
    try:
        c.execute("BEGIN TRANSACTION")
        c.execute("SELECT * FROM ventas WHERE folio=?", (req.folio,))
        venta = c.fetchone()
        if not venta: raise Exception("Folio de venta no encontrado")
        c.execute("SELECT SUM(monto_devuelto) FROM devoluciones WHERE venta_folio=?", (req.folio,))
        ya_devuelto = c.fetchone()[0] or 0.0
        if req.monto > round(venta['total_usd'] - ya_devuelto, 2):
            raise Exception("El monto de devolución supera el total restante de la factura")
        fecha = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        c.execute("INSERT INTO devoluciones (fecha, venta_folio, monto_devuelto, cajero) VALUES (?, ?, ?, ?)",
                  (fecha, req.folio, req.monto, user['nombre']))
        if req.devolver_stock:
            c.execute("SELECT producto_id, nombre, cantidad FROM ventas_items WHERE venta_folio=?", (req.folio,))
            for i in c.fetchall():
                c.execute("SELECT stock, costo FROM productos WHERE id=?", (i['producto_id'],))
                st_prod = c.fetchone()
                if st_prod:
                    nuevo_st = round(st_prod['stock'] + i['cantidad'], 2)
                    c.execute("UPDATE productos SET stock = ? WHERE id=?", (nuevo_st, i['producto_id']))
                    registrar_kardex(c, i['producto_id'], i['nombre'], "DEVOLUCION", i['cantidad'], st_prod['stock'], nuevo_st, st_prod['costo'], f"Devolución Folio {req.folio}", user['nombre'])
        c.execute("COMMIT")
        log_accion(user['nombre'], "Devolución Procesada", f"Folio: {req.folio}, Monto Reintegrado: ${req.monto}")
        return {"status": "ok"}
    except Exception as e:
        c.execute("ROLLBACK")
        raise HTTPException(status_code=400, detail=str(e))
    finally:
        conn.close()

# ==========================================
# 18. CRÉDITOS, FINANCIAMIENTO Y CUOTAS
# ==========================================
@app.get("/api/creditos")
def get_creditos(user: dict = Depends(get_current_user)):
    conn = get_db(); c = conn.cursor()
    c.execute('''SELECT c.id, c.cliente_cedula, cl.nombre as cliente_nombre, cl.telefono as cliente_telefono, c.venta_folio, c.monto_deuda, c.abonado, c.total_original, c.monto_inicial, c.num_cuotas, c.frecuencia, c.estado, c.fecha 
                 FROM creditos c JOIN clientes cl ON c.cliente_cedula = cl.cedula WHERE c.estado = 'PENDIENTE' ORDER BY c.id DESC''')
    creditos = [dict(r) for r in c.fetchall()]
    
    for cr in creditos:
        c.execute("SELECT * FROM creditos_cuotas WHERE credito_id=? ORDER BY numero_cuota ASC", (cr['id'],))
        cr['cuotas'] = [dict(cu) for cu in c.fetchall()]
        
    conn.close()
    return creditos

@app.get("/api/creditos/{id}/cuotas")
def get_cuotas_credito(id: int, user: dict = Depends(get_current_user)):
    conn = get_db(); c = conn.cursor()
    c.execute("SELECT * FROM creditos_cuotas WHERE credito_id=? ORDER BY numero_cuota ASC", (id,))
    cuotas = [dict(r) for r in c.fetchall()]; conn.close()
    return cuotas

@app.post("/api/creditos/cuota/{cuota_id}/pagar")
def pagar_cuota_especifica(cuota_id: int, req: CuotaPagarRequest, user: dict = Depends(get_current_user)):
    conn = get_db(); c = conn.cursor()
    try:
        c.execute("BEGIN TRANSACTION")
        c.execute("SELECT credito_id, monto_cuota, estado FROM creditos_cuotas WHERE id=?", (cuota_id,))
        cuota = c.fetchone()
        if not cuota: raise Exception("Cuota no encontrada")
        if cuota['estado'] == 'PAGADO': raise Exception("Esta cuota ya está cancelada")
        
        fecha_pago = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        c.execute("UPDATE creditos_cuotas SET estado='PAGADO', fecha_pago=?, metodo_pago=? WHERE id=?", (fecha_pago, req.metodo_pago, cuota_id))
        
        # Actualizar acumulado en el crédito padre
        c.execute("SELECT monto_deuda, abonado FROM creditos WHERE id=?", (cuota['credito_id'],))
        cred = c.fetchone()
        nuevo_abonado = round(cred['abonado'] + req.monto, 2)
        estado_cred = 'PAGADO' if nuevo_abonado >= cred['monto_deuda'] else 'PENDIENTE'
        
        c.execute("UPDATE creditos SET abonado=?, estado=? WHERE id=?", (nuevo_abonado, estado_cred, cuota['credito_id']))
        c.execute("COMMIT")
        log_accion(user['nombre'], "Pago de Cuota", f"Cuota ID: {cuota_id}, Monto: ${req.monto}, Credito ID: {cuota['credito_id']}")
        return {"status": "ok", "nuevo_abonado": nuevo_abonado, "estado_credito": estado_cred}
    except Exception as e:
        c.execute("ROLLBACK")
        raise HTTPException(400, str(e))
    finally:
        conn.close()

@app.post("/api/creditos/abono/{id}")
def abonar_credito(id: int, monto: float = Form(...), user: dict = Depends(get_current_user)):
    conn = get_db(); c = conn.cursor()
    try:
        c.execute("BEGIN TRANSACTION")
        c.execute("SELECT monto_deuda, abonado, cliente_cedula FROM creditos WHERE id=?", (id,))
        credito = c.fetchone()
        if not credito: raise Exception("Crédito no encontrado")
        nuevo_abonado = round(credito['abonado'] + monto, 2)
        estado = 'PAGADO' if nuevo_abonado >= credito['monto_deuda'] else 'PENDIENTE'
        c.execute("UPDATE creditos SET abonado=?, estado=? WHERE id=?", (nuevo_abonado, estado, id))
        c.execute("COMMIT")
        log_accion(user['nombre'], "Abono a Crédito", f"Crédito ID: {id}, Monto: ${monto}, Cliente: {credito['cliente_cedula']}, Estado: {estado}")
        return {"status": "ok"}
    except Exception as e:
        c.execute("ROLLBACK")
        raise HTTPException(400, str(e))
    finally:
        conn.close()

# ==========================================
# 19. APERTURA Y CIERRE DE TURNOS DE CAJA
# ==========================================
@app.get("/api/turnos/activo")
def get_turno_activo(user: dict = Depends(get_current_user)):
    conn = get_db(); c = conn.cursor()
    c.execute("SELECT * FROM turnos_caja WHERE estado = 'ABIERTO' ORDER BY id DESC LIMIT 1")
    turno = c.fetchone(); conn.close()
    return dict(turno) if turno else None

@app.post("/api/turnos/abrir")
def abrir_turno_caja(req: TurnoAbrirRequest, user: dict = Depends(get_current_user)):
    conn = get_db(); c = conn.cursor()
    c.execute("SELECT id FROM turnos_caja WHERE estado = 'ABIERTO'")
    if c.fetchone():
        conn.close()
        raise HTTPException(400, "Ya existe un turno de caja abierto actualmente.")
    
    fecha = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    c.execute('''INSERT INTO turnos_caja (cajero, fecha_apertura, monto_inicial_usd, monto_inicial_bs, estado, notas)
                 VALUES (?, ?, ?, ?, 'ABIERTO', ?)''',
              (user['nombre'], fecha, req.monto_inicial_usd, req.monto_inicial_bs, req.notas or ''))
    turno_id = c.lastrowid
    conn.commit(); conn.close()
    log_accion(user['nombre'], "Apertura de Turno", f"Fondo: ${req.monto_inicial_usd} / Bs. {req.monto_inicial_bs}")
    return {"status": "ok", "turno_id": turno_id}

@app.post("/api/turnos/cerrar")
def cerrar_turno_caja(req: TurnoCerrarRequest, user: dict = Depends(require_supervisor)):
    conn = get_db(); c = conn.cursor()
    c.execute("SELECT * FROM turnos_caja WHERE estado = 'ABIERTO' ORDER BY id DESC LIMIT 1")
    turno = c.fetchone()
    if not turno:
        conn.close()
        raise HTTPException(400, "No hay ningún turno de caja abierto para cerrar.")
    
    fecha_cierre = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    inicio = turno['fecha_apertura']
    
    # Calcular ventas y egresos ocurridos durante el turno
    c.execute("SELECT SUM(total_usd) FROM ventas WHERE fecha >= ?", (inicio,))
    ventas_turno = c.fetchone()[0] or 0.0
    c.execute("SELECT SUM(monto) FROM gastos WHERE fecha >= ?", (inicio,))
    gastos_turno = c.fetchone()[0] or 0.0
    
    esperado_usd = round(turno['monto_inicial_usd'] + ventas_turno - gastos_turno, 2)
    diferencia_usd = round(req.contado_usd - esperado_usd, 2)
    
    c.execute('''UPDATE turnos_caja SET 
                    fecha_cierre=?, esperado_usd=?, esperado_bs=0.0, contado_usd=?, contado_bs=?, 
                    diferencia_usd=?, diferencia_bs=0.0, estado='CERRADO', notas=? 
                 WHERE id=?''',
              (fecha_cierre, esperado_usd, req.contado_usd, req.contado_bs, diferencia_usd, req.notas, turno['id']))
    
    # También registrar en arqueos
    c.execute("INSERT INTO arqueos (fecha, cajero, contado_usd) VALUES (?, ?, ?)", (fecha_cierre, user['nombre'], req.contado_usd))
    
    conn.commit(); conn.close()
    log_accion(user['nombre'], "Cierre de Turno", f"Esperado: ${esperado_usd}, Contado: ${req.contado_usd}, Dif: ${diferencia_usd}")
    return {
        "status": "ok", 
        "esperado_usd": esperado_usd, 
        "contado_usd": req.contado_usd, 
        "diferencia_usd": diferencia_usd
    }

# ==========================================
# 20. TABLERO KANBAN DE PEDIDOS REMOTOS Y DELIVERY
# ==========================================
@app.get("/api/pedidos")
def get_pedidos(estado: Optional[str] = None, user: dict = Depends(get_current_user)):
    conn = get_db(); c = conn.cursor()
    if estado:
        c.execute("SELECT * FROM pedidos_remotos WHERE estado=? ORDER BY id DESC", (estado,))
    else:
        c.execute("SELECT * FROM pedidos_remotos ORDER BY id DESC LIMIT 200")
    pedidos = [dict(r) for r in c.fetchall()]
    for p in pedidos:
        try: p['items_json'] = json.loads(p['items'])
        except: p['items_json'] = []
    conn.close()
    return pedidos

@app.post("/api/pedidos")
def create_pedido_remoto(req: PedidoRemotoRequest, user: dict = Depends(get_current_user)):
    conn = get_db(); c = conn.cursor()
    folio = f"PED-{datetime.now().strftime('%Y%m%d')}-{str(uuid.uuid4())[:5].upper()}"
    fecha = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    c.execute('''INSERT INTO pedidos_remotos (folio, fecha, cliente_cedula, cliente_nombre, cliente_telefono, canal, estado, items, subtotal, costo_envio, total, metodo_pago, ref_pago, comprobante_url, tipo_entrega, motorizado, direccion_envio, notas)
                 VALUES (?, ?, ?, ?, ?, ?, 'PENDIENTE', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)''',
              (folio, fecha, req.cliente_cedula, req.cliente_nombre, req.cliente_telefono, req.canal, req.items, req.subtotal, req.costo_envio, req.total, req.metodo_pago, req.ref_pago, req.comprobante_url, req.tipo_entrega, req.motorizado, req.direccion_envio, req.notas))
    pedido_id = c.lastrowid
    conn.commit(); conn.close()
    log_accion(user['nombre'], "Nuevo Pedido Remoto", f"Folio: {folio}, Canal: {req.canal}, Cliente: {req.cliente_nombre}")
    return {"status": "ok", "id": pedido_id, "folio": folio}

@app.put("/api/pedidos/{id}/estado")
def update_estado_pedido(id: int, req: PedidoEstadoRequest, user: dict = Depends(get_current_user)):
    conn = get_db(); c = conn.cursor()
    query = "UPDATE pedidos_remotos SET estado=?"
    params = [req.estado]
    if req.motorizado is not None:
        query += ", motorizado=?"
        params.append(req.motorizado)
    query += " WHERE id=?"
    params.append(id)
    c.execute(query, tuple(params))
    conn.commit(); conn.close()
    log_accion(user['nombre'], "Cambio Estado Pedido", f"ID: {id} -> {req.estado}")
    return {"status": "ok"}

@app.post("/api/pedidos/{id}/facturar")
def facturar_pedido_remoto(id: int, user: dict = Depends(get_current_user)):
    conn = get_db(); c = conn.cursor()
    try:
        c.execute("BEGIN TRANSACTION")
        c.execute("SELECT * FROM pedidos_remotos WHERE id=?", (id,))
        pedido = c.fetchone()
        if not pedido: raise Exception("Pedido no encontrado")
        
        items = json.loads(pedido['items'])
        venta_req_items = []
        for it in items:
            venta_req_items.append(VentaItemInput(id=it['id'], cantidad=float(it['cantidad']), variante_idx=it.get('variante_idx')))
        
        v_req = VentaRequest(
            cliente_cedula=pedido['cliente_cedula'] or '0',
            descuento_porc=0.0,
            iva_porc=16.0,
            puntos_a_canjear=0.0,
            metodos_pago=json.dumps([{"metodo": pedido['metodo_pago'], "monto": pedido['total'], "ref": pedido['ref_pago']}]),
            es_credito=False,
            productos=venta_req_items,
            costo_envio=pedido['costo_envio'],
            tipo_entrega=pedido['tipo_entrega'],
            motorizado=pedido['motorizado'],
            comprobante_url=pedido['comprobante_url']
        )
        
        # Descontar inventario y asentar venta
        folio_v = f"ORD-{datetime.now().strftime('%Y%m%d')}-{str(uuid.uuid4())[:6].upper()}"
        fecha_v = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        suma_prods = 0.0
        items_db = []

        for item in v_req.productos:
            c.execute("SELECT id, nombre, precio, stock, costo, es_combo, combo_items FROM productos WHERE id=?", (item.id,))
            p = c.fetchone()
            if not p: raise Exception(f"Producto {item.id} no existe")
            
            if p['es_combo'] == 1 and p['combo_items']:
                try: comps = json.loads(p['combo_items'])
                except: comps = []
                for comp in comps:
                    cid = int(comp['id'])
                    cqty = float(comp.get('cantidad', 1)) * item.cantidad
                    c.execute("SELECT nombre, stock, costo FROM productos WHERE id=?", (cid,))
                    cdb = c.fetchone()
                    if cdb['stock'] < cqty: raise Exception(f"Stock insuficiente en componente '{cdb['nombre']}'")
                    nst = round(cdb['stock'] - cqty, 2)
                    c.execute("UPDATE productos SET stock=? WHERE id=?", (nst, cid))
                    registrar_kardex(c, cid, cdb['nombre'], "VENTA/COMBO", cqty, cdb['stock'], nst, cdb['costo'], f"Pedido {pedido['folio']} Facturado", user['nombre'])
                c.execute("UPDATE productos SET stock = stock - ? WHERE id=?", (item.cantidad, item.id))
            else:
                c.execute("UPDATE productos SET stock = stock - ? WHERE id=? AND stock >= ?", (item.cantidad, item.id, item.cantidad))
                if c.rowcount == 0: raise Exception(f"Stock insuficiente para: {p['nombre']}")
                nst = round(p['stock'] - item.cantidad, 2)
                registrar_kardex(c, item.id, p['nombre'], "VENTA", item.cantidad, p['stock'], nst, p['costo'], f"Pedido {pedido['folio']} Facturado", user['nombre'])
            
            sub = round(p['precio'] * item.cantidad, 2)
            suma_prods += sub
            items_db.append((folio_v, item.id, p['nombre'], item.cantidad, p['precio'], sub, p['costo']))

        c.execute('''INSERT INTO ventas (folio, fecha, cajero, cliente_cedula, subtotal, descuento, iva, puntos_canjeados, total_usd, metodos_pago, vuelto, costo_envio, tipo_entrega, motorizado, comprobante_url)
                     VALUES (?, ?, ?, ?, ?, 0.0, 0.0, 0.0, ?, ?, 0.0, ?, ?, ?, ?)''',
                  (folio_v, fecha_v, user['nombre'], pedido['cliente_cedula'] or '0', suma_prods, pedido['total'], v_req.metodos_pago, pedido['costo_envio'], pedido['tipo_entrega'], pedido['motorizado'], pedido['comprobante_url']))
        c.executemany('''INSERT INTO ventas_items (venta_folio, producto_id, nombre, cantidad, precio, subtotal, costo_unitario) VALUES (?, ?, ?, ?, ?, ?, ?)''', items_db)
        
        # Marcar pedido remoto como ENTREGADO
        c.execute("UPDATE pedidos_remotos SET estado='ENTREGADO' WHERE id=?", (id,))
        c.execute("COMMIT")
        log_accion(user['nombre'], "Facturar Pedido", f"Pedido {pedido['folio']} -> Venta {folio_v}")
        return {"status": "ok", "venta_folio": folio_v}
    except Exception as e:
        c.execute("ROLLBACK")
        raise HTTPException(400, str(e))
    finally:
        conn.close()

@app.post("/api/pedidos/upload_comprobante")
def upload_comprobante(file: UploadFile = File(...), user: dict = Depends(get_current_user)):
    validate_image_upload(file)
    ext = file.filename.split(".")[-1]; filename = f"comp_{int(time.time())}.{ext}"; path = f"static/img/comprobantes/{filename}"
    with open(path, "wb") as buffer: shutil.copyfileobj(file.file, buffer)
    return {"url": f"/{path}"}

# ==========================================
# 21. ESTADÍSTICAS Y MARGEN BRUTO REAL
# ==========================================
@app.get("/api/stats")
def get_stats(user: dict = Depends(require_admin)):
    hoy = datetime.now().strftime("%Y-%m-%d")
    conn = get_db(); c = conn.cursor()
    c.execute("SELECT SUM(total_usd) FROM ventas WHERE fecha LIKE ?", (f"{hoy}%",))
    ventas = c.fetchone()[0] or 0.0
    c.execute("SELECT SUM(monto) FROM gastos WHERE fecha LIKE ?", (f"{hoy}%",))
    gastos = c.fetchone()[0] or 0.0
    conn.close()
    return {"ventas_hoy": ventas, "gastos_hoy": gastos, "ganancia_neta": round(ventas - gastos, 2)}

@app.get("/api/stats/utilidad")
def get_stats_utilidad(user: dict = Depends(require_admin)):
    """Calcula el Margen Bruto Real considerando el costo de mercancía vendida."""
    conn = get_db(); c = conn.cursor()
    hoy = datetime.now().strftime("%Y-%m-%d")
    
    # Ventas de hoy con desglose de costo
    c.execute('''SELECT SUM(vi.subtotal) as total_venta, SUM(vi.cantidad * vi.costo_unitario) as total_costo
                 FROM ventas_items vi JOIN ventas v ON vi.venta_folio = v.folio
                 WHERE v.fecha LIKE ?''', (f"{hoy}%",))
    row_hoy = c.fetchone()
    v_hoy = row_hoy['total_venta'] or 0.0
    c_hoy = row_hoy['total_costo'] or 0.0
    margen_hoy = round(v_hoy - c_hoy, 2)
    porc_hoy = round((margen_hoy / v_hoy * 100), 1) if v_hoy > 0 else 0.0

    # Margen Histórico por Categoría
    c.execute('''SELECT p.categoria, SUM(vi.subtotal) as ventas, SUM(vi.cantidad * vi.costo_unitario) as costos
                 FROM ventas_items vi JOIN productos p ON vi.producto_id = p.id
                 GROUP BY p.categoria''')
    cats_data = []
    for r in c.fetchall():
        ventas_cat = r['ventas'] or 0.0
        costos_cat = r['costos'] or 0.0
        util_cat = round(ventas_cat - costos_cat, 2)
        cats_data.append({
            "categoria": r['categoria'] or "General",
            "ventas": round(ventas_cat, 2),
            "costos": round(costos_cat, 2),
            "utilidad": util_cat,
            "margen_porc": round((util_cat / ventas_cat * 100), 1) if ventas_cat > 0 else 0.0
        })

    conn.close()
    return {
        "ventas_hoy": round(v_hoy, 2),
        "costos_hoy": round(c_hoy, 2),
        "utilidad_bruta_hoy": margen_hoy,
        "margen_porcentaje_hoy": porc_hoy,
        "categorias": cats_data
    }

@app.get("/api/caja/totales")
def totales_caja(user: dict = Depends(get_current_user)):
    conn = get_db(); c = conn.cursor()
    c.execute("SELECT SUM(total_usd) FROM ventas"); ventas = c.fetchone()[0] or 0.0
    c.execute("SELECT SUM(monto) FROM gastos"); gastos = c.fetchone()[0] or 0.0
    conn.close()
    return {"ingresos": ventas, "gastos": gastos}

@app.post("/api/arqueo")
def realizar_arqueo(req: ArqueoRequest, user: dict = Depends(require_admin)):
    hoy = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    conn = get_db()
    conn.execute("INSERT INTO arqueos (fecha, cajero, contado_usd) VALUES (?, ?, ?)", (hoy, user['nombre'], req.contado_usd))
    conn.commit(); conn.close()
    log_accion(user['nombre'], "Cierre y Arqueo de Caja", f"Total Contado en Caja: ${req.contado_usd}")
    return {"status": "ok"}

# ==========================================
# 22. RESPALDOS EN ZIP (EXPORTAR / IMPORTAR)
# ==========================================
@app.get("/api/backup/export")
def export_backup(user: dict = Depends(require_superadmin)):
    memory_file = io.BytesIO()
    with zipfile.ZipFile(memory_file, 'w', zipfile.ZIP_DEFLATED) as zf:
        if os.path.exists(DB_NAME):
            zf.write(DB_NAME)
        if os.path.exists("static"):
            for root, dirs, files in os.walk("static"):
                for file in files:
                    zf.write(os.path.join(root, file))
    memory_file.seek(0)
    log_accion(user['nombre'], "Descarga de Backup", "Exportación completa en formato ZIP")
    return StreamingResponse(
        memory_file,
        media_type="application/zip",
        headers={"Content-Disposition": f"attachment; filename=jclip_backup_{datetime.now().strftime('%Y%m%d_%H%M%S')}.zip"}
    )

@app.post("/api/backup/import")
def import_backup(archivo: UploadFile = File(...), user: dict = Depends(require_superadmin)):
    if not archivo.filename.endswith('.zip'):
        raise HTTPException(400, "El archivo debe tener extensión .zip")
    try:
        with open("temp_restore.zip", "wb") as buffer:
            shutil.copyfileobj(archivo.file, buffer)
        with zipfile.ZipFile("temp_restore.zip", 'r') as zf:
            zf.extractall(".")
        os.remove("temp_restore.zip")
        log_accion(user['nombre'], "Restauración de Backup", "Restauración exitosa desde archivo ZIP")
        return {"status": "ok", "mensaje": "Restauración completada con éxito."}
    except Exception as e:
        raise HTTPException(500, f"Falla en la restauración: {str(e)}")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
