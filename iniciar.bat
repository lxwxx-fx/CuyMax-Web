@echo off
title CuyMax - servidor CUYMAX-WEB
cd /d "%~dp0"

REM 1. Entorno virtual (si existe)
if exist ".venv\Scripts\activate.bat" (
  echo Activando entorno virtual .venv...
  call ".venv\Scripts\activate.bat"
) else if exist "venv\Scripts\activate.bat" (
  echo Activando entorno virtual venv...
  call "venv\Scripts\activate.bat"
) else (
  echo Sin entorno virtual: se usa el Python del sistema.
)
echo.

REM 2. PostgreSQL encendido? (se detecta cualquier servicio cuyo nombre empiece por postgresql)
powershell -NoProfile -Command "if (-not (Get-Service -Name 'postgresql*' -ErrorAction SilentlyContinue | Where-Object { $_.Status -eq 'Running' })) { exit 1 }" >nul 2>&1
if errorlevel 1 (
  echo ============================================================
  echo  AVISO: PostgreSQL no esta encendido.
  echo  Enciendelo con:  net start postgresql-x64-18
  echo  (o activa el servicio desde Servicios de Windows)
  echo ============================================================
  pause
  exit /b 1
)
echo PostgreSQL encendido: OK.
echo.

REM 3. Puerto 8000 libre?
netstat -ano | find "LISTENING" | find ":8000 " >nul
if not errorlevel 1 (
  echo ============================================================
  echo  AVISO: el puerto 8000 ya esta ocupado.
  echo  Cierra la otra ventana del servidor o la del servidor
  echo  de archivos y vuelve a ejecutar esto.
  echo ============================================================
  pause
  exit /b 1
)
echo Puerto 8000 libre: OK.
echo.

REM 4. El navegador se abre solo cuando el servidor responda
echo Abriendo el navegador cuando el servidor este listo...
start "" /min powershell -NoProfile -Command "$i=0; while ($i -lt 30) { try { Invoke-RestMethod http://127.0.0.1:8000/salud -TimeoutSec 2 | Out-Null; Start-Process 'http://localhost:8000/'; break } catch { Start-Sleep -Seconds 2 }; $i++ }"
echo.

REM 5. Servidor al frente, esta ventana queda abierta con sus mensajes
cd /d "%~dp0server"
python -m uvicorn api:app --host 0.0.0.0 --port 8000
echo.
echo El servidor se detuvo. Pulsa una tecla para cerrar.
pause >nul
