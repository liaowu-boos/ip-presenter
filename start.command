#!/bin/bash
set -e
cd "$(dirname "$0")"
if ! command -v python3 >/dev/null 2>&1; then
  echo '需要 Python 3.10 或更新版本。仅查看界面可直接打开“直接预览.html”。'
  read -r -p '按回车关闭…'
  exit 1
fi
python3 -c 'import sys; assert sys.version_info >= (3,10), "需要 Python 3.10+"'
if [ ! -d .venv ]; then python3 -m venv .venv; fi
if ! .venv/bin/python -c 'import fastapi, uvicorn, httpx, dotenv' >/dev/null 2>&1; then
  echo '首次运行：安装后端依赖（需要网络，不安装任何本地大模型）…'
  .venv/bin/python -m pip install -r requirements.txt
fi
if [ ! -f .env ]; then cp .env.example .env; fi
PORT="${IP_PRESENTER_PORT:-8765}"
.venv/bin/python -c "import socket; s=socket.socket(); s.bind(('127.0.0.1',$PORT)); s.close()" || { echo "端口 $PORT 已被占用。请关闭旧实例或更改 IP_PRESENTER_PORT。"; exit 1; }
echo "IP Presenter 启动于 http://127.0.0.1:$PORT"
echo '关闭此终端或按 Ctrl+C 可停止服务。当前未配置密钥时为规则演示。'
.venv/bin/python -m uvicorn backend.app:app --host 127.0.0.1 --port "$PORT" &
PID=$!
trap 'kill "$PID" 2>/dev/null || true' EXIT INT TERM
for i in $(seq 1 30); do
  if .venv/bin/python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:$PORT/api/health',timeout=1)" >/dev/null 2>&1; then
    if command -v open >/dev/null 2>&1; then open "http://127.0.0.1:$PORT"; fi
    break
  fi
  sleep 0.2
done
wait "$PID"
