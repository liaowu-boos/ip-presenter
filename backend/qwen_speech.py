"""Short authored voice previews using the same Qwen model/voice as live dialogue."""
import asyncio
import base64
import json
import logging
from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field
from backend import qwen_realtime as qwen

router = APIRouter(prefix='/api/qwen')
lock = asyncio.Lock()

class Speech(BaseModel):
    text: str = Field(min_length=1, max_length=800)

async def synthesize(config, text):
    audio = bytearray()
    transcript = []
    async with asyncio.timeout(55):
        async with qwen.connect_upstream(config) as upstream:
            await qwen.configure(upstream, qwen.narration_prompt(text), tools=[])
            await upstream.send(json.dumps(qwen.event('response.create')))
            while True:
                packet = json.loads(await upstream.recv())
                failure = qwen.provider_error(packet)
                if failure is not None:
                    raise qwen.ProviderError(qwen.safe_error(failure), failure)
                kind = packet.get('type')
                if kind == 'response.audio.delta':
                    chunk = base64.b64decode(packet.get('delta', ''), validate=True)
                    if len(chunk) % 2 or len(audio) + len(chunk) > 48000 * 90:
                        raise ValueError('Invalid or oversized PCM')
                    audio.extend(chunk)
                if kind == 'response.audio_transcript.delta':
                    transcript.append(packet.get('delta', ''))
                if kind == 'response.done':
                    if packet.get('response', {}).get('status') in ('failed', 'cancelled', 'incomplete'):
                        raise ValueError('Incomplete voice response')
                    break
    if len(audio) < 4800:
        raise ValueError('Empty voice response')
    return bytes(audio), ''.join(transcript)

@router.post('/speech')
async def speech(body: Speech):
    config = qwen.load_config()
    if not config:
        raise HTTPException(503, '请先在工作台配置千问。')
    if lock.locked():
        raise HTTPException(429, '正在生成上一段千问语音，请稍后再试。')
    async with lock:
        try:
            audio, transcript = await synthesize(config, body.text)
        except Exception as error:
            logging.getLogger('uvicorn.error').warning('Qwen speech failed: %s', qwen.diagnostic(error, config['api_key']))
            raise HTTPException(502, str(error) if isinstance(error, qwen.ProviderError) else qwen.safe_error(error)) from None
    return Response(audio, media_type='audio/pcm', headers={
        'X-Audio-Format': 'pcm_s16le_24000_mono', 'X-Voice-Provider': 'qwen',
        'X-Voice-Model': qwen.MODEL, 'X-Voice-Name': qwen.VOICE,
        'X-Voice-Transcript': base64.b64encode(transcript.encode()).decode()})
