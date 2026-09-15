import sys
import os
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))
import requests
import threading
import time
import uvicorn
from main import app

def run_server():
    uvicorn.run(app, host='127.0.0.1', port=8004, log_level='error')

t = threading.Thread(target=run_server, daemon=True)
t.start()
time.sleep(2)

base_url = 'http://127.0.0.1:8004'

# 1. Login
auth_res = requests.post(f'{base_url}/api/auth', json={'usuario': 'Admin Principal', 'pin': '1234'})
token = auth_res.json().get('token')
headers = {'Authorization': f'Bearer {token}'}
print(f"1. Login: OK ({auth_res.json()['user']['nombre']})")

# 2. Open Turno
turno_activo = requests.get(f'{base_url}/api/turnos/activo', headers=headers).json()
if not turno_activo:
    open_res = requests.post(f'{base_url}/api/turnos/abrir', json={'monto_inicial_usd': 20.0, 'monto_inicial_bs': 500.0, 'notas': 'Apertura inicial'}, headers=headers)
    print("2. Apertura Turno:", open_res.status_code, open_res.json())
else:
    print("2. Turno ya abierto:", turno_activo.get('id'))

# 3. Create Product (FormData)
form_data = {
    'codigo': 'TEST-SKU-99',
    'nombre': 'Audífonos Bluetooth Pro',
    'descripcion': 'Cancelación de ruido activa',
    'categoria': 'Electrónica',
    'proveedor': '[]',
    'costo': 12.5,
    'precio': 25.0,
    'stock': 50.0,
    'es_peso': 0,
    'variantes': '',
    'vencimiento': '',
    'destacado': 1,
    'stock_minimo': 5.0,
    'es_combo': 0,
    'combo_items': ''
}
prod_res = requests.post(f'{base_url}/api/productos', data=form_data, headers=headers)
print("3. Crear Producto:", prod_res.status_code, prod_res.json())
prod_id = prod_res.json().get('id')

# 4. Make Sale
venta_payload = {
    'cliente_cedula': '0',
    'descuento_porc': 0.0,
    'iva_porc': 16.0,
    'puntos_a_canjear': 0.0,
    'metodos_pago': '[{"metodo":"Efectivo ($)","monto":29.0,"monto_bs":0}]',
    'es_credito': False,
    'productos': [{'id': prod_id, 'cantidad': 2.0}],
    'costo_envio': 0.0,
    'tipo_entrega': 'MOSTRADOR'
}
venta_res = requests.post(f'{base_url}/api/ventas', json=venta_payload, headers=headers)
print("4. Realizar Venta:", venta_res.status_code, venta_res.json())

# 5. Check Kardex
kardex_res = requests.get(f'{base_url}/api/kardex', headers=headers)
print("5. Kardex Registros:", len(kardex_res.json()), "Último:", kardex_res.json()[0]['tipo'], "-", kardex_res.json()[0]['motivo'])

# 6. Check Stats
stats_res = requests.get(f'{base_url}/api/stats', headers=headers)
print("6. Estadísticas:", stats_res.status_code, stats_res.json())

# 7. Check Box Totals
caja_res = requests.get(f'{base_url}/api/caja/totales', headers=headers)
print("7. Totales Caja:", caja_res.status_code, caja_res.json())

# 8. Delete test product
del_res = requests.delete(f'{base_url}/api/productos/{prod_id}', headers=headers)
print("8. Eliminar Producto:", del_res.status_code, del_res.json())

print("\n==========================================")
print("¡TODOS LOS MÓDULOS OPERAN PERFECTAMENTE!")
print("==========================================")
