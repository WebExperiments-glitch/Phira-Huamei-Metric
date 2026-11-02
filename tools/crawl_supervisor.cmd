@echo off
rem P.H.M. crawl supervisor
rem Keeps tools\crawl_records.py alive. Working dir is set by the shortcut (Start in),
rem so NO non-ASCII path appears in this file.
rem Exit code 7 from the crawler means "nothing left to do" -> stop supervising.

set PY=C:\Users\30500\.workbuddy\binaries\python\versions\3.13.12\python.exe

:loop
"%PY%" -u tools\crawl_records.py --workers 32
if errorlevel 7 goto done
rem crash or kill: wait a bit, then resume from checkpoint
timeout /t 60 /nobreak >nul
goto loop

:done
echo crawl finished
