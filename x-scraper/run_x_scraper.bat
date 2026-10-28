@echo off
rem Scheduled entry point. Runs the scraper with the project's own virtualenv.
rem Setup (once): see README.md.
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo Virtual environment missing. Run the setup steps in README.md first.
  exit /b 2
)
".venv\Scripts\python.exe" x_scraper.py %*
exit /b %ERRORLEVEL%
