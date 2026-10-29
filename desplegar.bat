@echo off
REM CuyMax - publicar el sitio en Firebase Hosting.
REM Usa Node 22 portatil: el Firebase CLI falla con Node 25.
setlocal
set "NODE22=%LOCALAPPDATA%\node22\node.exe"
set "FB=%APPDATA%\npm\node_modules\firebase-tools\lib\bin\firebase.js"

if not exist "%NODE22%" (
  echo [ERROR] No encuentro Node 22 en %NODE22%
  echo         Descargalo de https://nodejs.org/dist/latest-v22.x/ y descomprimelo ahi.
  pause
  exit /b 1
)
if not exist "%FB%" (
  echo [ERROR] No encuentro firebase-tools. Instala con: npm install -g firebase-tools
  pause
  exit /b 1
)

echo Publicando reglas de Firestore y Firebase Hosting (cuymax-by-dc)...
REM functions/ requiere plan Blaze. Cuando este activo:
REM   "%NODE22%" "%FB%" deploy --only functions,firestore:rules,hosting
"%NODE22%" "%FB%" deploy --only firestore:rules,hosting %*
if errorlevel 1 (
  echo.
  echo No se pudo publicar. Si dice que no hay sesion: firebase login
) else (
  echo.
  echo Listo: https://cuymax-by-dc.web.app
)
pause
