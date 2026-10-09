"""Persist explicit application-canvas recordings locally, never microphone input.

Content-addressed WebM files live outside the static frontend. No client path
or filename is accepted; successful responses follow hash verification and an
atomic publish. The app's existing local POST origin/header guard still applies.
"""
import hashlib
import os
from pathlib import Path
import re
import tempfile
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse

MAX_RECORDING_BYTES = 64 * 1024 * 1024
RECORDINGS = Path(__file__).resolve().parents[1] / 'outputs/performance-recordings'
router = APIRouter(prefix='/api/performance-recordings')


@router.post('')
async def save(request: Request):
    expected = request.headers.get('x-recording-sha256', '')
    if not re.fullmatch(r'[0-9a-f]{64}', expected):
        raise HTTPException(400, '录像校验值无效。')
    if request.headers.get('content-type', '').split(';')[0].strip() != 'video/webm':
        raise HTTPException(415, '只接收检查页生成的 WebM 录像。')
    RECORDINGS.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix='.pending-', dir=RECORDINGS)
    pending = Path(name); count = 0; digest = hashlib.sha256(); header = b''
    try:
        with os.fdopen(fd, 'wb') as output:
            async for chunk in request.stream():
                count += len(chunk)
                if count > MAX_RECORDING_BYTES:
                    raise HTTPException(413, '录像超过本机保存大小限制。')
                if len(header) < 4: header = (header + chunk)[:4]
                digest.update(chunk); output.write(chunk)
            if count < 16 or header != b'\x1a\x45\xdf\xa3':
                raise HTTPException(400, '录像文件不完整。')
            if digest.hexdigest() != expected:
                raise HTTPException(400, '录像传输校验不一致，未保存。')
            output.flush(); os.fsync(output.fileno())
        target = RECORDINGS / f'{expected}.webm'
        try:
            # Publish without overwriting any existing file. Identical retries
            # are idempotent; a corrupt pre-existing file is never trusted.
            os.link(pending, target)
        except FileExistsError:
            if target.is_symlink() or target.stat().st_size != count or hashlib.sha256(target.read_bytes()).hexdigest() != expected:
                raise HTTPException(409, '已有录像校验失败，未覆盖。')
        return {'url':f'/api/performance-recordings/{expected}.webm', 'sha256':expected, 'bytes':count}
    finally:
        pending.unlink(missing_ok=True)


@router.get('/{filename}')
async def download(filename: str):
    if not re.fullmatch(r'[0-9a-f]{64}\.webm', filename):
        raise HTTPException(404, '录像不存在。')
    path = RECORDINGS / filename
    if path.is_symlink() or not path.is_file():
        raise HTTPException(404, '录像不存在。')
    return FileResponse(path, media_type='video/webm', filename=f'presenter-{filename}')
