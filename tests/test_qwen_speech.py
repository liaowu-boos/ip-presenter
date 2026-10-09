import asyncio
import base64
import json
from fastapi.testclient import TestClient
from backend import app, qwen_speech as speech

HEADERS = {'X-IP-Presenter': '1'}

class Socket:
    def __init__(self, packets):
        self.packets=iter(packets)
        self.closed=False
    async def __aenter__(self): return self
    async def __aexit__(self,*args): self.closed=True
    async def send(self, message): self.message=json.loads(message)
    async def recv(self): return json.dumps(next(self.packets))

def setup(monkeypatch, packets):
    socket=Socket(packets)
    async def configure(*args, **kwargs): assert kwargs['tools']==[]
    monkeypatch.setattr(speech.qwen,'connect_upstream',lambda _:socket)
    monkeypatch.setattr(speech.qwen,'configure',configure)
    monkeypatch.setattr(speech.qwen,'load_config',lambda:{'api_key':'never-log-this'})
    monkeypatch.setattr(speech,'lock',asyncio.Lock())
    return socket

def test_real_pcm_contract_and_transcript(monkeypatch):
    audio=b'\x10\x00'*2400
    socket=setup(monkeypatch,[{'type':'response.audio.delta','delta':base64.b64encode(audio).decode()}, {'type':'response.audio_transcript.delta','delta':'老师您好'}, {'type':'response.done','response':{'status':'completed'}}])
    with TestClient(app.app) as client:
        r=client.post('/api/qwen/speech',json={'text':'老师您好'},headers=HEADERS)
    assert r.status_code==200 and r.content==audio
    assert r.headers['x-voice-provider']=='qwen' and r.headers['x-voice-name']=='Tina'
    assert base64.b64decode(r.headers['x-voice-transcript']).decode()=='老师您好'
    assert socket.closed and socket.message['type']=='response.create'

def test_failed_response_never_returns_partial_audio_or_local_fallback(monkeypatch):
    socket=setup(monkeypatch,[{'type':'response.audio.delta','delta':base64.b64encode(b'xx'*2400).decode()}, {'type':'response.done','response':{'status':'failed'}}])
    with TestClient(app.app) as client:
        r=client.post('/api/qwen/speech',json={'text':'老师您好'},headers=HEADERS)
    assert r.status_code==502 and socket.closed
    assert 'never-log-this' not in r.text

def test_bounded_authored_request(monkeypatch):
    with TestClient(app.app) as client:
        assert client.post('/api/qwen/speech',json={'text':'hi'}).status_code==403
        assert client.post('/api/qwen/speech',json={'text':'a'*801},headers=HEADERS).status_code==422
