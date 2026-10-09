"""Project-scoped, offline providers. No cloud fallback and no stored microphone audio."""
from __future__ import annotations

import asyncio
from collections import OrderedDict
import io
import os
from pathlib import Path
import tempfile
import wave
import array
import math
import sys
import json
import re
from urllib.parse import unquote

import httpx
from opencc import OpenCC

OLLAMA_URL = 'http://127.0.0.1:11435'
WHISPER_URL = 'http://127.0.0.1:8178'
MODEL = 'qwen3:4b-instruct-2507-q4_K_M'
VOICE = 'Tingting'
_speech_cache: OrderedDict[str, bytes] = OrderedDict()
_speech_lock = asyncio.Lock()
_simplified = OpenCC('t2s')


def normalize_transcript(text: str) -> str:
    return _simplified.convert(text).strip()


def enabled() -> bool:
    return os.getenv('IP_PRESENTER_LOCAL') == '1'


def chat_payload(messages: list[dict], *, stream: bool, structured=False) -> dict:
    # Pin the Instruct checkpoint: the generic 4b tag currently points to a
    # thinking-only checkpoint that does not support disabling reasoning.
    payload = {'model': MODEL, 'messages': messages, 'stream': stream,
               'keep_alive': '30m', 'options': {'num_ctx': 16384, 'num_predict': 650, 'temperature': 0.2}}
    if structured:
        payload['format'] = structured if isinstance(structured, dict) else 'json'
    return payload


async def readiness() -> dict:
    async with httpx.AsyncClient(timeout=2, trust_env=False) as client:
        async def check_llm():
            try:
                r = await client.get(OLLAMA_URL + '/api/tags')
                return r.is_success and any(x.get('name') == MODEL for x in r.json().get('models', []))
            except (httpx.HTTPError, ValueError):
                return False
        async def check_asr():
            try:
                r = await client.get(WHISPER_URL + '/health')
                return r.is_success
            except httpx.HTTPError:
                return False
        llm, asr = await asyncio.gather(check_llm(), check_asr())
    return {'llm': llm, 'asr': asr, 'tts': Path('/usr/bin/say').is_file(),
            'runtime': 'local', 'model': MODEL, 'voice': VOICE,
            'audio_destination': '本机（不上传录音）',
            'description': '本机中文识别、本机问答、Mac 婷婷音色。首次回答前会预热模型。'}


async def synthesize(text: str) -> bytes:
    """Render a fixed macOS voice to 24 kHz PCM; temporary generated audio is deleted."""
    async with _speech_lock:
        if text in _speech_cache:
            _speech_cache.move_to_end(text)
            return _speech_cache[text]
        with tempfile.TemporaryDirectory(prefix='ip-presenter-tts-') as folder:
            target = str(Path(folder) / 'speech.wav')
            # stdin 文本不作为命令参数解释；不通过 shell，不播放到系统扬声器。
            process = await asyncio.create_subprocess_exec(
                '/usr/bin/say', '-v', VOICE, '-r', '205', '-o', target,
                '--file-format=WAVE', '--data-format=LEI16@24000', '-f', '-',
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.PIPE)
            try:
                _, stderr = await asyncio.wait_for(process.communicate(text.encode('utf-8')), timeout=20)
                if process.returncode:
                    raise RuntimeError('Mac 中文声音不可用，请检查系统是否安装了“婷婷”声音。')
                with wave.open(target, 'rb') as audio:
                    if (audio.getnchannels(), audio.getsampwidth(), audio.getframerate()) != (1, 2, 24000):
                        raise RuntimeError('Mac 声音输出格式不匹配。')
                    pcm = audio.readframes(audio.getnframes())
            finally:
                if process.returncode is None:
                    process.kill()
                    await process.wait()
        if not pcm:
            raise RuntimeError('Mac 没有生成声音。')
        _speech_cache[text] = pcm
        # 只缓存生成的短句，限制总内存；原始麦克风录音不进入缓存。
        while sum(map(len, _speech_cache.values())) > 16 * 1024 * 1024 or len(_speech_cache) > 40:
            _speech_cache.popitem(last=False)
        return pcm


def validate_wave(data: bytes) -> None:
    try:
        with wave.open(io.BytesIO(data), 'rb') as audio:
            duration = audio.getnframes() / audio.getframerate()
            if audio.getnchannels() != 1 or audio.getsampwidth() != 2 or not 0 < duration <= 46:
                raise ValueError('本机识别只接收不超过45秒的单声道 PCM 录音。')
    except (wave.Error, EOFError, ZeroDivisionError) as exc:
        raise ValueError('录音 WAV 文件无效。') from exc


def recognition_prompt(header: str = '') -> str:
    words = ['开始汇报','继续汇报','暂停','放大','缩小','下一页','上一页','数据图表','标题']
    if header:
        if len(header) > 12000:
            raise ValueError('识别词汇过长。')
        extra = json.loads(unquote(header))
        if not isinstance(extra, list) or len(extra) > 40:
            raise ValueError('识别词汇格式无效。')
        for word in extra:
            if not isinstance(word, str) or not re.fullmatch(r'[\w· -]{1,24}', word):
                raise ValueError('识别词汇只能包含简短名称。')
            if word not in words: words.append(word)
    return '，'.join(words) + '。'


def wave_has_signal(data: bytes) -> bool:
    """Exclude digital silence before vocabulary conditioning; never guess words from it."""
    with wave.open(io.BytesIO(data), 'rb') as audio:
        samples = array.array('h', audio.readframes(audio.getnframes()))
    if sys.byteorder != 'little': samples.byteswap()
    if not samples: return False
    mean = sum(samples) / len(samples)
    rms = math.sqrt(sum((sample-mean)**2 for sample in samples)/len(samples))/32768
    return rms >= .0001


def pcm_to_wave(pcm: bytes) -> bytes:
    buffer = io.BytesIO()
    with wave.open(buffer, 'wb') as audio:
        audio.setnchannels(1); audio.setsampwidth(2); audio.setframerate(24000); audio.writeframes(pcm)
    return buffer.getvalue()
