#!/bin/bash
cd "$(dirname "$0")" || exit 1
# Finder has a limited PATH; consider Python.org, Homebrew and the user's PATH.
QWEN_PYTHON=""
for candidate in /usr/local/bin/python3 /opt/homebrew/bin/python3 "$(command -v python3 2>/dev/null)"; do
  if [ -x "$candidate" ] && "$candidate" -c 'import sys; sys.exit(sys.version_info < (3,10))' 2>/dev/null; then
    QWEN_PYTHON="$candidate"
    break
  fi
done
if [ -z "$QWEN_PYTHON" ]; then
  echo '这台 Mac 需要先安装 Python 3.10 或更新版本。'
  echo '请打开 https://www.python.org/downloads/macos/ 安装后，再双击本文件。'
  read -r -p '按回车关闭…'
  exit 1
fi
"$QWEN_PYTHON" -u scripts/run_qwen.py "$@"
QWEN_STATUS=$?
if [ "$QWEN_STATUS" -ne 0 ]; then
  read -r -p '启动未完成，请保留上方错误提示。按回车关闭…'
fi
exit "$QWEN_STATUS"
