import asyncio
import base64
import json
import stat

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from backend import app as module
from backend import qwen_realtime as qwen

KEY = 'test-only-never-a-real-key'
CONFIG = {'api_key': KEY, 'workspace': 'workspace-test123', 'region': 'beijing'}
CONTEXT = {'name': '测试项目', 'slides': [{'id': 'a', 'title': '表情', 'regions': []}],
           'knowledge': [], 'view': {'main': {'imageId': 'a'}}, 'history': []}
HEADERS = {'X-IP-Presenter': '1'}


class FakeUpstream:
    def __init__(self, error=None):
        self.queue = asyncio.Queue()
        self.queue.put_nowait(json.dumps({'type': 'session.created'}))
        self.sent = []
        self.closed = False
        self.error = error

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        self.closed = True

    async def recv(self):
        return await self.queue.get()

    def __aiter__(self):
        return self

    async def __anext__(self):
        return await self.recv()

    async def send(self, raw):
        data = json.loads(raw)
        self.sent.append(data)
        if data['type'] == 'session.update':
            result = {'type': 'error', 'error': self.error} if self.error else {'type': 'session.updated'}
            self.queue.put_nowait(json.dumps(result))
        if data['type'] == 'input_audio_buffer.append':
            for event in [{'type': 'response.created', 'response': {'id': 'r1'}},
                          {'type': 'response.audio.delta', 'response_id': 'r1', 'delta': data['audio']},
                          {'type': 'response.done', 'response': {'id': 'r1', 'status': 'completed'}}]:
                self.queue.put_nowait(json.dumps(event))


@pytest.fixture
def setup(tmp_path, monkeypatch):
    monkeypatch.setattr(qwen, 'CONFIG_PATH', tmp_path / '.runtime' / 'qwen.json')
    connections = []

    def connect(config):
        assert config['api_key'] == KEY
        socket = FakeUpstream()
        connections.append(socket)
        return socket

    monkeypatch.setattr(qwen, 'connect_upstream', connect)
    with TestClient(module.app) as client:
        yield client, connections


def test_config_only_persists_after_authenticated_session_update(setup):
    client, connections = setup
    response = client.post('/api/qwen/config', json=CONFIG, headers=HEADERS)
    assert response.status_code == 200 and response.json()['verified'] is True
    assert KEY not in response.text
    assert stat.S_IMODE(qwen.CONFIG_PATH.stat().st_mode) == 0o600
    assert qwen.load_config() == CONFIG
    assert connections[0].closed
    session = connections[0].sent[0]['session']
    assert session['voice'] == 'Tina'
    assert session['audio']['input']['format']['sample_rate'] == 24000
    assert session['turn_detection']['type'] == 'semantic_vad'
    assert session['tools'] and session['enable_search'] is False
    assert all(e['type'] != 'response.create' for e in connections[0].sent)


def test_blank_key_reuses_saved_secret_without_returning_it(setup):
    client, _ = setup
    qwen.save_config(CONFIG)
    response = client.post('/api/qwen/config', json={**CONFIG, 'api_key': ''}, headers=HEADERS)
    assert response.status_code == 200 and KEY not in response.text
    assert qwen.load_config()['api_key'] == KEY


def test_invalid_config_and_provider_errors_never_echo_secret(setup, monkeypatch):
    client, _ = setup
    response = client.post('/api/qwen/config', json={**CONFIG, 'api_key': {'secret': KEY}}, headers=HEADERS)
    assert response.status_code == 400 and KEY not in response.text
    monkeypatch.setattr(qwen, 'connect_upstream', lambda config: FakeUpstream({'code': 'InvalidApiKey', 'message': KEY}))
    response = client.post('/api/qwen/config', json=CONFIG, headers=HEADERS)
    assert response.status_code == 502 and KEY not in response.text
    assert not qwen.CONFIG_PATH.exists()


@pytest.mark.parametrize('after_created', [False, True])
def test_flat_gateway_error_is_not_lost_as_a_connection_close(setup, monkeypatch, caplog, after_created):
    client, _ = setup

    class FlatErrorUpstream(FakeUpstream):
        def __init__(self):
            super().__init__()
            if not after_created:
                self.queue.get_nowait()
                self.queue.put_nowait(json.dumps({'code': 'InvalidApiKey', 'message': KEY}))

        async def send(self, raw):
            self.queue.put_nowait(json.dumps({'code': 'InvalidApiKey', 'message': KEY}))

    monkeypatch.setattr(qwen, 'connect_upstream', lambda config: FlatErrorUpstream())
    response = client.post('/api/qwen/config', json=CONFIG, headers=HEADERS)
    assert response.status_code == 502
    assert '身份验证' in response.json()['detail']
    assert KEY not in response.text and KEY not in caplog.text
    assert 'InvalidApiKey' in caplog.text
    assert not qwen.CONFIG_PATH.exists()


def test_diagnostics_redact_secrets_before_json_escaping():
    secret = 'test-"key\\value'
    error = qwen.ProviderError('safe', {'code': 'InvalidParameter', 'message': secret})
    error.__cause__ = ValueError(secret)
    record = json.loads(qwen.diagnostic(error, secret))
    assert record['message'] == '[密钥已隐藏]'
    assert record['cause'] == '[密钥已隐藏]'
    assert record['code'] == 'InvalidParameter'


def test_unpurchased_model_has_specific_guidance_without_echoing_provider_secrets():
    message = qwen.safe_error({'code': 'AccessDenied.Unpurchased', 'message': 'Access to model denied. ' + KEY})
    assert 'AccessDenied.Unpurchased' in message and qwen.MODEL in message
    assert '服务开通状态' in message and '身份验证' not in message and KEY not in message


def test_api_key_restriction_message_identifies_exact_model_and_permissions():
    message = qwen.safe_error({'code': 'AccessDenied', 'message': 'Access denied by API-Key restrictions.'})
    assert '访问限制' in message and qwen.MODEL in message
    assert 'IP 白名单' in message and '这不等于密钥输错' in message


def test_flat_gateway_error_during_voice_session_stops_with_safe_message(setup, monkeypatch):
    client, _ = setup
    qwen.save_config(CONFIG)

    class FlatStreamError(FakeUpstream):
        async def send(self, raw):
            if json.loads(raw)['type'] == 'input_audio_buffer.append':
                self.queue.put_nowait(json.dumps({'code': 'AccessDenied',
                    'message': 'Access denied by API-Key restrictions. ' + KEY}))
            else:
                await super().send(raw)

    monkeypatch.setattr(qwen, 'connect_upstream', lambda config: FlatStreamError())
    with client.websocket_connect('/api/qwen/realtime', headers={'origin': 'http://testserver'}) as ws:
        ws.send_json({'type': 'init', 'context': CONTEXT})
        assert ws.receive_json()['type'] == 'ready'
        ws.send_bytes(b'\x00\x00')
        received = ws.receive_json()
        assert received['type'] == 'error'
        assert '访问限制' in received['message'] and KEY not in json.dumps(received)


def test_failed_reconfiguration_keeps_previous_working_config(setup, monkeypatch):
    client, _ = setup
    qwen.save_config(CONFIG)
    monkeypatch.setattr(qwen, 'connect_upstream', lambda config: FakeUpstream({'code': 'ModelNotFound'}))
    response = client.post('/api/qwen/config', json={**CONFIG, 'workspace': 'other'}, headers=HEADERS)
    assert response.status_code == 502
    assert qwen.load_config() == CONFIG


@pytest.mark.parametrize('workspace', ['evil.example/path', '../secret', 'x@evil.test', 'a\nHost:evil', '-bad', ''])
def test_endpoint_cannot_be_redirected_to_an_arbitrary_host(workspace):
    with pytest.raises(ValueError):
        qwen.validate_config({**CONFIG, 'workspace': workspace})


def test_region_endpoints_and_no_key_in_url():
    assert qwen.endpoint(CONFIG) == 'wss://workspace-test123.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime?model=qwen3.5-omni-plus-realtime-2026-03-15'
    assert '.ap-southeast-1.' in qwen.endpoint({**CONFIG, 'region': 'singapore'})
    assert KEY not in qwen.endpoint(CONFIG)


def test_config_is_private_and_removal_does_not_expose_it(setup):
    client, _ = setup
    qwen.save_config(CONFIG)
    response = client.get('/api/qwen/config')
    assert response.json()['configured'] is True and KEY not in response.text
    assert response.headers['cache-control'] == 'no-store'
    assert client.get('/.runtime/qwen.json').status_code == 404
    assert client.post('/api/qwen/forget', headers=HEADERS).json()['configured'] is False
    assert not qwen.CONFIG_PATH.exists()


def test_cross_origin_cannot_configure_or_open_audio_session(setup):
    client, connections = setup
    assert client.post('/api/qwen/config', json=CONFIG).status_code == 403
    assert client.post('/api/qwen/config', json=CONFIG, headers={**HEADERS, 'Origin': 'https://other.test'}).status_code == 403
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect('/api/qwen/realtime', headers={'origin': 'https://other.test'}):
            pass
    assert connections == []


def test_missing_key_fails_without_opening_mic_or_fake_answer(setup):
    client, connections = setup
    with client.websocket_connect('/api/qwen/realtime', headers={'origin': 'http://testserver'}) as ws:
        assert ws.receive_json()['type'] == 'error'
    assert connections == []


def test_realtime_gateway_handshake_audio_and_disconnect(setup):
    client, connections = setup
    qwen.save_config(CONFIG)
    with client.websocket_connect('/api/qwen/realtime', headers={'origin': 'http://testserver'}) as ws:
        ws.send_json({'type': 'init', 'context': CONTEXT})
        ready = ws.receive_json()
        assert ready['type'] == 'ready' and ready['sample_rate'] == 24000
        assert KEY not in json.dumps(ready)
        pcm = b'\0\0\x01\0' * 240
        ws.send_bytes(pcm)
        assert ws.receive_json()['event']['type'] == 'response.created'
        audio = ws.receive_json()['event']
        assert base64.b64decode(audio['delta']) == pcm
        assert ws.receive_json()['event']['type'] == 'response.done'
        ws.send_json({'type': 'stop'})
        with pytest.raises(WebSocketDisconnect):
            ws.receive_json()
    assert connections[0].closed
    assert len(list(qwen.CONFIG_PATH.parent.iterdir())) == 1  # no persisted audio


def test_unvalidated_context_cannot_reach_provider(setup):
    client, connections = setup
    qwen.save_config(CONFIG)
    with client.websocket_connect('/api/qwen/realtime', headers={'origin': 'http://testserver'}) as ws:
        ws.send_json({'type': 'init', 'context': {**CONTEXT, 'api_key': KEY}})
        result = ws.receive_json()
        assert result['type'] == 'error' and KEY not in json.dumps(result)
    assert not connections


class FakeClient:
    def __init__(self):
        self.queue = asyncio.Queue()
        self.sent = []

    async def receive(self):
        return await self.queue.get()

    async def send_json(self, data):
        self.sent.append(data)


def test_cancelled_tool_cannot_resume_old_response():
    async def run():
        upstream, client = FakeUpstream(), FakeClient()
        bridge = qwen.Bridge(upstream, client, 'prompt')
        bridge.active = 'old'
        bridge.calls['call1'] = {'cancelled': False}
        await bridge.cancel()
        bridge.active = None
        client.queue.put_nowait({'type': 'websocket.receive', 'text': json.dumps({'type': 'tool_result', 'call_id': 'call1', 'result': {'ok': True}})})
        client.queue.put_nowait({'type': 'websocket.disconnect'})
        await bridge.from_client()
        assert 'old' in bridge.cancelled
        result = [x for x in upstream.sent if x['type'] == 'conversation.item.create'][0]
        assert json.loads(result['item']['output'])['ok'] is False
        assert all(x['type'] != 'response.create' for x in upstream.sent)
    asyncio.run(run())


def test_tool_results_wait_for_response_end_before_continuation():
    async def run():
        upstream, client = FakeUpstream(), FakeClient()
        bridge = qwen.Bridge(upstream, client, 'prompt')
        bridge.active = 'r1'
        bridge.calls['call1'] = {'cancelled': False}
        client.queue.put_nowait({'type': 'websocket.receive', 'text': json.dumps({'type': 'tool_result', 'call_id': 'call1', 'result': {'ok': True}})})
        client.queue.put_nowait({'type': 'websocket.disconnect'})
        await bridge.from_client()
        assert bridge.continue_pending
        assert all(x['type'] != 'response.create' for x in upstream.sent)
        upstream.queue.put_nowait(json.dumps({'type': 'response.done', 'response': {'id': 'r1'}}))
        task = asyncio.create_task(bridge.from_upstream())
        for _ in range(10):
            await asyncio.sleep(0)
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        assert [x['type'] for x in upstream.sent].count('response.create') == 1
    asyncio.run(run())


def test_narration_uses_documented_session_instruction_update_and_same_voice():
    async def run():
        upstream, client = FakeUpstream(), FakeClient()
        bridge = qwen.Bridge(upstream, client, 'base prompt')
        reader = asyncio.create_task(bridge.from_upstream())
        client.queue.put_nowait({'type': 'websocket.receive', 'text': json.dumps({'type': 'narrate', 'request_id': 'n1', 'text': '这是原稿。'})})
        client.queue.put_nowait({'type': 'websocket.disconnect'})
        await bridge.from_client()
        reader.cancel()
        await asyncio.gather(reader, return_exceptions=True)
        assert [e['type'] for e in upstream.sent] == ['session.update', 'response.create']
        assert '这是原稿。' in upstream.sent[0]['session']['instructions']
        assert 'base prompt' not in upstream.sent[0]['session']['instructions']
        assert 'voice' not in upstream.sent[0]['session']  # preserves the fixed session voice
        assert upstream.sent[0]['session']['tools'] == []  # no recursive lecture control
        assert 'response' not in upstream.sent[1]  # no unsupported OpenAI-style override
    asyncio.run(run())


@pytest.mark.parametrize('ending', ['cancel', 'narration_done'])
@pytest.mark.parametrize('gestures', [[], ['explain']])
def test_narration_restores_full_dialogue_prompt_on_end_or_interruption(ending, gestures):
    async def run():
        upstream, client = FakeUpstream(), FakeClient()
        tools = qwen.tools_for_context({'view': {'presentation': {'capabilities': {'gestures': gestures}}}})
        bridge = qwen.Bridge(upstream, client, '完整项目与对话约束', tools=tools)
        bridge.narration = 'n1'
        bridge.active = 'r1'
        reader = asyncio.create_task(bridge.from_upstream())
        client.queue.put_nowait({'type': 'websocket.receive', 'text': json.dumps({'type': ending, 'request_id': 'n1'})})
        client.queue.put_nowait({'type': 'websocket.disconnect'})
        await bridge.from_client()
        reader.cancel()
        await asyncio.gather(reader, return_exceptions=True)
        assert bridge.narration is None
        assert upstream.sent[-1]['session'] == {'instructions': '完整项目与对话约束', 'tools': tools}
        if ending == 'cancel':
            assert upstream.sent[0]['type'] == 'response.cancel'
            assert 'r1' in bridge.cancelled
    asyncio.run(run())


def test_gesture_tools_are_filtered_by_the_connected_renderer():
    for advertised in (None, {}, 'explain', ['point', 'dance']):
        context = {'view': {'presentation': {'capabilities': {'gestures': advertised}}}}
        assert qwen.tools_for_context(context) == qwen.TOOLS
    context = {'view': {'presentation': {'capabilities': {'gestures': ['smile', 'explain', 'execute']}}}}
    tools = qwen.tools_for_context(context)
    gesture = tools[-1]['function']
    assert gesture['name'] == 'performer_gesture'
    assert gesture['parameters']['properties']['kind']['enum'] == ['explain', 'smile']
    assert gesture['parameters']['additionalProperties'] is False
    bridge = qwen.Bridge(None, None, 'test', tools=tools)
    assert bridge.tools == tools
    assert len(qwen.TOOLS) == 4  # stable stage and isolated narration keep their old tools


def test_emotions_are_offered_only_when_renderer_advertises_them():
    for kind in ['laugh', 'shy', 'sad', 'angry']:
        tools = qwen.tools_for_context({'view': {'presentation': {'capabilities': {'gestures': [kind]}}}})
        gesture = next(t['function'] for t in tools if t['function']['name'] == 'performer_gesture')
        assert gesture['parameters']['properties']['kind']['enum'] == [kind]
