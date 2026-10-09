#!/bin/bash
set -e
cd "$(dirname "$0")"
if command -v open >/dev/null 2>&1; then open "直接预览.html"; else echo '请用浏览器打开同目录的“直接预览.html”。'; fi
