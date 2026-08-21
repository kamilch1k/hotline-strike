@echo off
REM ---------------------------------------------------------------------------
REM  Hotline Strike - double-click to play.
REM
REM  Starts the vite dev server in this folder and opens the game in the default
REM  browser. Closing this window stops the server.
REM
REM  Uses the vite binary from node_modules directly rather than `npm run dev`:
REM  npm adds a second process between this window and the server, so closing
REM  the window would orphan vite and leave port 5173 held by nothing visible.
REM ---------------------------------------------------------------------------

cd /d "%~dp0"

if not exist "node_modules\vite\bin\vite.js" (
  echo.
  echo   Dependencies are not installed yet. Running npm install once...
  echo.
  call npm install || goto :failed
)

echo.
echo   Starting Hotline Strike...
echo   Chrome opens by itself in a few seconds. If it does not, open this:
echo.
echo       http://localhost:5173
echo.
echo   Leave this window open while you play; close it to stop the server.
echo.

REM Give vite a moment to bind the port before the browser asks for it.
REM
REM CHROME BY NAME, with the default browser as the fallback. `Start-Process`
REM on a bare URL opens whatever is registered for http, which is not
REM necessarily Chrome; naming it explicitly is the difference between "opens"
REM and "opens where you are testing".
REM
REM PowerShell rather than nested `start "" cmd /c "... & start ..."`: the cmd
REM form needs three levels of quote escaping and silently opens the wrong
REM thing when it gets them wrong. Vite itself runs in THIS window (not via
REM `start`), so Ctrl+C and closing the window both actually stop the server.
REM Chrome is registered under App Paths but is NOT on PATH on this machine, so
REM `Get-Command chrome.exe` fails while `Start-Process chrome.exe` would still
REM work. Rather than rely on that difference, ask the registry first, then the
REM two install locations, then give up and use the default browser.
start "" /b powershell -NoProfile -Command "Start-Sleep -Seconds 4; $u='http://localhost:5173'; $c=(Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe' -EA SilentlyContinue).'(default)'; if(-not $c){foreach($p in @(\"$env:ProgramFiles\Google\Chrome\Application\chrome.exe\",\"${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe\",\"$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe\")){if(Test-Path $p){$c=$p;break}}}; if($c){Start-Process $c $u}else{Start-Process $u}"

node "node_modules\vite\bin\vite.js" --port 5173 --strictPort
goto :eof

:failed
echo.
echo   npm install failed. Is Node.js installed?  https://nodejs.org
echo.
pause
