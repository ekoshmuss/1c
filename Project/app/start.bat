@echo off
rem Запуск веб-интерфейса остатков вручную (окно должно оставаться открытым)
cd /d "%~dp0"
node server.js
pause
