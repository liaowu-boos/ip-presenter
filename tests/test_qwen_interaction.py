import asyncio
import json

from backend.qwen_realtime import Bridge


class Upstream:
    def __init__(self):
        self.sent = []
        self.queue = asyncio.Queue()

    async def send(self, raw):
        msg = json.loads(raw)
        self.sent.append(msg)
        if msg['type'] == 'session.update':
            self.emit('session.updated', session=msg['session'])

    def emit(self, kind, **data):
        self.queue.put_nowait(json.dumps({'type': kind, **data}))

    def __aiter__(self):
        return self

    async def __anext__(self):
        return await self.queue.get()


class Client:
    def __init__(self):
        self.sent = []
        self.queue = asyncio.Queue()

    async def send_json(self, msg):
        self.sent.append(msg)

    async def receive(self):
        return await self.queue.get()


async def settle():
    for _ in range(20):
        await asyncio.sleep(0)


def test_native_vad_auto_reply_pause_during_question_resume_only_next_question():
    async def run():
        upstream, client = Upstream(), Client()
        bridge = Bridge(upstream, client, 'project', auto_switch=True)
        reader = asyncio.create_task(bridge.from_upstream())
        try:
            assert bridge.floor is None
            upstream.emit('input_audio_buffer.speech_started')
            upstream.emit('input_audio_buffer.speech_stopped')
            upstream.emit('response.created', response={'id': 'automatic'})
            await settle()
            first = client.sent[-1]
            assert first['cancelled'] is False and first['interaction_revision'] == 0
            assert not any(m['type'] == 'response.create' for m in upstream.sent)
            upstream.emit('response.done', response={'id': 'automatic'})
            upstream.emit('input_audio_buffer.speech_started')
            await settle()
            await bridge.interaction.set_paused(True, 1)
            upstream.emit('input_audio_buffer.speech_stopped')
            upstream.emit('response.created', response={'id': 'teacher-to-author'})
            upstream.emit('response.function_call_arguments.done', response_id='teacher-to-author', call_id='late-picture')
            upstream.emit('response.done', response={'id': 'teacher-to-author'})
            await settle()
            assert bridge.calls['late-picture']['cancelled'] is True
            assert all(p['cancelled'] for p in client.sent if p.get('event', {}).get('response_id') == 'teacher-to-author')
            # The author's own voice remains context, including transcription.
            upstream.emit('input_audio_buffer.speech_started')
            upstream.emit('conversation.item.input_audio_transcription.completed', transcript='这是作者说明。')
            await settle()
            await bridge.interaction.set_paused(False, 2)
            upstream.emit('input_audio_buffer.speech_stopped')
            upstream.emit('response.created', response={'id': 'old-author-tail'})
            upstream.emit('response.done', response={'id': 'old-author-tail'})
            await settle()
            tail = next(p for p in client.sent if p.get('event', {}).get('response', {}).get('id') == 'old-author-tail')
            assert tail['cancelled'] is True
            assert any(p.get('event', {}).get('transcript') == '这是作者说明。' for p in client.sent)
            upstream.emit('input_audio_buffer.speech_started')
            upstream.emit('input_audio_buffer.speech_stopped')
            upstream.emit('response.created', response={'id': 'fresh-question'})
            await settle()
            assert client.sent[-1]['cancelled'] is False
            assert client.sent[-1]['interaction_revision'] == 2
            assert not any(m['type'] in ('input_audio_buffer.clear', 'response.create') for m in upstream.sent)
        finally:
            reader.cancel()
            await asyncio.gather(reader, return_exceptions=True)
    asyncio.run(run())


def test_paused_input_stays_on_same_upstream_and_cannot_start_a_tool_continuation():
    async def run():
        upstream, client = Upstream(), Client()
        bridge = Bridge(upstream, client, 'project', auto_switch=True)
        await bridge.interaction.set_paused(True, 1)
        client.queue.put_nowait({'type': 'websocket.receive', 'bytes': b'\0\0' * 480})
        client.queue.put_nowait({'type': 'websocket.disconnect'})
        await bridge.from_client()
        assert upstream.sent[-1]['type'] == 'input_audio_buffer.append'
        bridge.continue_pending = True
        await bridge.continue_if_ready()
        assert not any(m['type'] == 'response.create' for m in upstream.sent)
        await bridge.interaction.set_paused(False, 2)
        await bridge.interaction.set_paused(True, 1)  # stale switch cannot undo resume
        assert not bridge.interaction.paused and bridge.interaction.revision == 2
        assert not bridge.interaction.can_answer
    asyncio.run(run())
