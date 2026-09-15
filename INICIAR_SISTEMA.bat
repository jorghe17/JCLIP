@echo off
title JCLIP PRO ULTRA - Servidor ERP & POS
color 0b
echo ===================================================
echo           INICIANDO SISTEMA JCLIP PRO ULTRA
echo ===================================================
echo.
echo Verificando entorno de Python y dependencias...
python -m py_compile main.py >nul 2>&1
if %errorlevel% neq 0 (
    echo [ALERTA] Instalando librerias necesarias...
    pip install -r requirements.txt
)

echo.
echo ===================================================
echo Servidor iniciado con exito!
echo.
echo [1] Panel Principal:   http://localhost:8000
echo [2] 2da Pantalla:      http://localhost:8000/cliente
echo [3] API Docs:          http://localhost:8000/docs
echo.
echo Usuario: Admin Principal ^| PIN: 1234
echo ===================================================
echo.
start http://localhost:8000
python main.py
pause
