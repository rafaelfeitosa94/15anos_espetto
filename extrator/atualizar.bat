@echo off
REM Atualiza os dados do dashboard Copo 15 Anos e publica no GitHub/Vercel.
cd /d "%~dp0"
python atualizar_dados.py %*
