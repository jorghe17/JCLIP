import re
import sqlite3
import requests
import threading
import time
import uvicorn
import sys
import os
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))
from main import app, get_db

with open('app.js', 'r', encoding='utf-8') as f:
    text = f.read()

calls = set(re.findall(r'fetchAPI\(\s*[`\'\"](/[^`\'\"?]+)', text))
print("--- Endpoints in app.js ---")
for c in sorted(calls):
    print(c)

print("\n--- Testing Backend Responses ---")
def run_server():
    uvicorn.run(app, host='127.0.0.1', port=8002, log_level='error')

t = threading.Thread(target=run_server, daemon=True)
t.start()
time.sleep(2)

base_url = 'http://127.0.0.1:8002'

auth_res = requests.post(f'{base_url}/api/auth', json={'usuario': 'Admin Principal', 'pin': '1234'})
token = auth_res.json().get('token')
headers = {'Authorization': f'Bearer {token}'}

print(f"Auth Token Acquired: {bool(token)}")

# Check core GET endpoints
get_endpoints = [
    '/',
    '/cliente',
    '/styles.css',
    '/app.js',
    '/api/config',
    '/api/categorias',
    '/api/productos',
    '/api/clientes',
    '/api/proveedores',
    '/api/usuarios',
    '/api/stats',
    '/api/stats/utilidad',
    '/api/caja/totales',
    '/api/creditos',
    '/api/pedidos',
    '/api/turnos/activo',
    '/api/kardex',
    '/api/bitacora',
    '/api/ventas/historial'
]

all_passed = True
for ep in get_endpoints:
    res = requests.get(f'{base_url}{ep}', headers=headers)
    status = res.status_code
    ok = (status == 200)
    if not ok:
        all_passed = False
    print(f"{ep:<25} -> {status} {'[OK]' if ok else '[FAILED]'}")

print(f"\nFinal Result: {'ALL TESTS PASSED' if all_passed else 'SOME TESTS FAILED'}")
