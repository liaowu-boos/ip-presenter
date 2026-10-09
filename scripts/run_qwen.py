"""Portable, loopback-only Qwen launcher. No local model or speech downloads."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
import webbrowser

ROOT = Path(__file__).resolve().parents[1]
REQUIREMENTS = ROOT / 'requirements.txt'
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def runtime_path():
    override = os.environ.get('IP_PRESENTER_RUNTIME_DIR')
    if override:
        return Path(override).expanduser()
    # Keep installed dependencies outside Documents/Desktop, which iCloud can evict.
    base = Path.home() / 'Library' / 'Application Support' / 'IPPresenter'
    version = f'py{sys.version_info.major}.{sys.version_info.minor}'
    digest = hashlib.sha256(REQUIREMENTS.read_bytes()).hexdigest()[:12]
    return base / 'runtime' / f'{version}-{digest}'


def ensure_runtime():
    runtime = runtime_path()
    python = runtime / 'bin' / 'python'
    if not python.exists():
        print('首次运行：准备千问语音运行环境…', flush=True)
        subprocess.run([sys.executable, '-m', 'venv', str(runtime)], check=True)
    check = '''import importlib.metadata as m, pathlib, sys
try:
    pairs = [line.split('==') for line in pathlib.Path(sys.argv[1]).read_text().splitlines() if line and not line.startswith('#')]
    assert all(m.version(name) == version for name, version in pairs)
    import fastapi, uvicorn, httpx, dotenv, opencc, websockets
except (ImportError, AssertionError, m.PackageNotFoundError):
    sys.exit(1)
'''
    if subprocess.run([str(python), '-c', check, str(REQUIREMENTS)], timeout=45).returncode:
        print('正在安装网页与千问连接组件，需要联网；不下载本机大模型。', flush=True)
        subprocess.run([str(python), '-m', 'pip', 'install', '--disable-pip-version-check',
                        '-r', str(REQUIREMENTS)], check=True)
    return python


def health(url):
    try:
        with OPENER.open(url + '/api/health', timeout=2) as response:
            data = json.load(response)
            return isinstance(data, dict) and data.get('version') == '0.6.0'
    except (OSError, ValueError, urllib.error.URLError):
        return False


def show(url, no_browser):
    url += '/?v=0.6.0'
    print(f'已就绪：{url}', flush=True)
    if not no_browser:
        chrome = Path('/Applications/Google Chrome.app')
        if sys.platform == 'darwin' and chrome.exists():
            subprocess.run(['open', '-a', str(chrome), url], check=False)
        else:
            webbrowser.open(url)


def main():
    parser = argparse.ArgumentParser(description='启动千问数字人，不加载本机备用模型。')
    parser.add_argument('--port', type=int, default=8765)
    parser.add_argument('--no-browser', action='store_true')
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535:
        raise ValueError('端口必须在 1024 到 65535 之间。')
    if sys.version_info < (3, 10):
        raise RuntimeError('需要 Python 3.10 或更新版本，请参照迁移说明安装。')
    url = f'http://127.0.0.1:{args.port}'
    if health(url):
        print('数字人网页已经在运行，正在打开。', flush=True)
        show(url, args.no_browser)
        return
    python = ensure_runtime()
    env = {**os.environ, 'IP_PRESENTER_LOCAL': '0', 'PYTHONUNBUFFERED': '1'}
    child = subprocess.Popen([str(python), '-m', 'uvicorn', 'backend.app:app',
                              '--host', '127.0.0.1', '--port', str(args.port)], cwd=ROOT, env=env)
    try:
        deadline = time.monotonic() + 60
        while not health(url):
            if child.poll() is not None:
                raise RuntimeError('网页服务未启动，请检查上方错误；若端口被占用，请关闭旧的启动窗口。')
            if time.monotonic() >= deadline:
                raise RuntimeError('启动超时。请确认项目已完整下载到这台电脑，再重试。')
            time.sleep(.3)
        show(url, args.no_browser)
        print('保持这个窗口打开。网页中点“配置千问”，保存后点“开启语音会话”。', flush=True)
        print('关闭本窗口或按 Ctrl+C 可停止服务。', flush=True)
        child.wait()
    finally:
        if child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()


if __name__ == '__main__':
    def interrupted(*_):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGHUP, interrupted)
    try:
        main()
    except KeyboardInterrupt:
        pass
    except (OSError, RuntimeError, ValueError, subprocess.SubprocessError) as error:
        print(f'启动未完成：{error}', file=sys.stderr, flush=True)
        sys.exit(1)
