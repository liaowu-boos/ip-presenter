import asyncio
import json
import time

import pytest

from backend.qwen_realtime import Bridge, ProviderError, session_config


class Upstream:
    def __init__(self):
        self.queue = asyncio.Queue()
        self.sent = []
        self.items = 0

    async def send(self, raw):
        message = json.loads(raw)
        self.sent.append(message)
        if message['type'] == 'session.update':
            self.queue.put_nowait(json.dumps({'type': 'session.updated', 'session': message['session']}))
        if message['type'] == 'input_audio_buffer.commit':
            self.items += 1
            self.queue.put_nowait(json.dumps({'type': 'input_audio_buffer.committed', 'item_id': f'input-{self.items}'}))

    def __aiter__(self):
        return self

    async def __anext__(self):
        return await self.queue.get()


class Client:
    def __init__(self):
        self.sent = []

    async def send_json(self, message):
        self.sent.append(message)


async def settle():
    for _ in range(15):
        await asyncio.sleep(0)


async def cleanup(bridge, reader):
    await bridge.floor.close()
    reader.cancel()
    await asyncio.gather(reader, return_exceptions=True)


@pytest.mark.parametrize('with_event_id', [False, True])
def test_cancel_after_remote_finish_keeps_connection_and_allows_next_grant(with_event_id):
    async def run():
        upstream, client = Upstream(), Client()
        bridge = Bridge(upstream, client, 'project', manual=True)
        reader = asyncio.create_task(bridge.from_upstream())
        try:
            bridge.active = 'old'
            bridge.active_responses.add('old')
            bridge.idle.clear()
            await bridge.cancel()
            await bridge.cancel()  # frontend cancel + listen_start must not duplicate
            cancellations = [m for m in upstream.sent if m['type'] == 'response.cancel']
            assert len(cancellations) == 1
            failure = {'message': 'Conversation has none active response'}
            if with_event_id:
                failure['event_id'] = cancellations[0]['event_id']
            upstream.queue.put_nowait(json.dumps({'type': 'error', 'error': failure}))
            await settle()
            assert not reader.done() and bridge.idle.is_set()
            assert bridge.active is None and not bridge.active_responses
            assert client.sent[-1]['event']['type'] == 'playback.cancel.idle'
            await bridge.floor.start(1)
            bridge.floor.audio(12000)
            await bridge.floor.end(1)
            await settle()
            await bridge.floor.request(1, 'next')
            await settle()
            assert [m['type'] for m in upstream.sent].count('response.create') == 1
        finally:
            await cleanup(bridge, reader)
    asyncio.run(run())


def test_late_idle_cancel_receipt_cannot_clear_new_generation():
    async def run():
        bridge = Bridge(Upstream(), Client(), 'project')
        await bridge.create_response()
        await bridge.cancel()
        cancel_id = next(iter(bridge.cancel_events))
        bridge.active = 'new'
        bridge.active_responses.add('new')
        await bridge.create_response()
        assert bridge.settle_idle_cancel({'event_id': cancel_id, 'message': 'Conversation has none active response'})
        assert bridge.active == 'new' and bridge.active_responses == {'new'}
        assert bridge.response_requested and not bridge.idle.is_set()
    asyncio.run(run())


def test_only_recent_known_idle_cancellation_is_recoverable():
    async def run():
        bridge = Bridge(Upstream(), Client(), 'project')
        message = {'message': 'Conversation has none active response'}
        assert not bridge.settle_idle_cancel(message)
        bridge.active = 'old'
        await bridge.cancel()
        cancel_id = next(iter(bridge.cancel_events))
        assert not bridge.settle_idle_cancel({**message, 'event_id': 'unknown'})
        assert not bridge.settle_idle_cancel({'event_id': cancel_id, 'message': 'Unauthorized'})
        bridge.cancel_events[cancel_id]['at'] = time.monotonic() - 16
        assert not bridge.settle_idle_cancel(message)
    asyncio.run(run())


def test_real_provider_error_is_not_swallowed_even_if_linked_to_cancel():
    async def run():
        upstream, client = Upstream(), Client()
        bridge = Bridge(upstream, client, 'project')
        bridge.active = 'old'
        await bridge.cancel()
        upstream.queue.put_nowait(json.dumps({'type': 'error', 'error': {
            'event_id': next(iter(bridge.cancel_events)), 'code': 'InvalidApiKey', 'message': 'invalid credential'}}))
        with pytest.raises(ProviderError, match='身份验证'):
            await bridge.from_upstream()
    asyncio.run(run())


def test_manual_session_disables_provider_auto_answer_without_disabling_transcription():
    config = session_config('test', manual=True)
    assert config['turn_detection'] is None
    assert config['input_audio_transcription']['model'] == 'qwen3-asr-flash-realtime'


def test_teacher_and_author_audio_remain_context_but_only_latest_grant_generates():
    async def run():
        upstream, client = Upstream(), Client()
        bridge = Bridge(upstream, client, 'project', manual=True)
        reader = asyncio.create_task(bridge.from_upstream())
        try:
            for turn in (1, 2, 3):
                await bridge.floor.start(turn)
                bridge.floor.audio(24000)
                await bridge.floor.end(turn)
                await settle()
            assert [m['type'] for m in upstream.sent].count('input_audio_buffer.commit') == 3
            assert not any(m['type'] == 'response.create' for m in upstream.sent)
            assert [t['status'] for t in bridge.floor.turns] == ['context', 'context', 'waiting']
            await bridge.floor.request(1, 'stale')
            assert bridge.floor.grant is None
            await bridge.floor.request(3, 'grant-3')
            await settle()
            assert [m['type'] for m in upstream.sent].count('response.create') == 1
            prompt = next(m['session']['instructions'] for m in reversed(upstream.sent) if m['type'] == 'session.update')
            assert '"selected_item_id": "input-3"' in prompt
            assert '"item_id": "input-1", "status": "context"' in prompt
            assert not any(m['type'] == 'conversation.item.delete' for m in upstream.sent)
        finally:
            await cleanup(bridge, reader)
    asyncio.run(run())


def test_press_while_teacher_speaks_waits_for_commit_ack_and_cannot_double_grant():
    async def run():
        upstream, client = Upstream(), Client()
        bridge = Bridge(upstream, client, 'project', manual=True)
        reader = asyncio.create_task(bridge.from_upstream())
        try:
            await bridge.floor.start(1)
            bridge.floor.audio(6000)
            await bridge.floor.request(1, 'first')
            await bridge.floor.request(1, 'duplicate')
            await settle()
            assert not any(m['type'] == 'response.create' for m in upstream.sent)
            assert bridge.floor.grant == 'first'
            await bridge.floor.end(1)
            await settle()
            assert [m['type'] for m in upstream.sent].count('response.create') == 1
        finally:
            await cleanup(bridge, reader)
    asyncio.run(run())


def test_cancel_during_context_update_never_releases_stale_answer():
    async def run():
        upstream, client = Upstream(), Client()
        bridge = Bridge(upstream, client, 'project', manual=True)
        entered, release = asyncio.Event(), asyncio.Event()
        async def delayed():
            entered.set()
            await release.wait()
        bridge.sync_playback = delayed
        await bridge.floor.start(1)
        bridge.floor.audio(24000)
        await bridge.floor.end(1)
        await bridge.floor.committed('input-1')
        await bridge.floor.request(1, 'old')
        await entered.wait()
        await bridge.floor.hold()
        release.set()
        await settle()
        assert bridge.floor.grant is None
        assert not any(m['type'] == 'response.create' for m in upstream.sent)
        await bridge.floor.close()
    asyncio.run(run())


def test_unrequested_provider_response_is_cancelled_and_never_gets_an_owner():
    async def run():
        upstream, client = Upstream(), Client()
        bridge = Bridge(upstream, client, 'project', manual=True)
        reader = asyncio.create_task(bridge.from_upstream())
        try:
            upstream.queue.put_nowait(json.dumps({'type': 'response.created', 'response': {'id': 'rogue'}}))
            await settle()
            packet = next(p for p in client.sent if p.get('event', {}).get('type') == 'response.created')
            assert packet['cancelled'] is True and packet['floor_grant'] is None
            assert upstream.sent[-1]['type'] == 'response.cancel'
        finally:
            await cleanup(bridge, reader)
    asyncio.run(run())


def test_answer_done_and_new_voice_revoke_permission_without_deleting_context():
    async def run():
        bridge = Bridge(Upstream(), Client(), 'project', manual=True)
        await bridge.floor.start(1)
        bridge.floor.audio(12000)
        # No commit ack yet: release can still safely consume this grant.
        await bridge.floor.end(1)
        await bridge.floor.request(1, 'grant')
        await bridge.floor.done('grant')
        assert bridge.floor.turn['status'] == 'answered' and bridge.floor.grant is None
        await bridge.floor.request(1, 'repeat')
        assert bridge.floor.grant is None
        await bridge.floor.start(2)
        await bridge.floor.request(2, 'second')
        await bridge.floor.end(2)
        assert bridge.floor.grant is None  # zero-length input cannot authorize a future turn
        assert len(bridge.floor.turns) == 2
        await bridge.floor.close()
    asyncio.run(run())


def test_tool_sibling_response_inherits_same_grant_but_none_after_revoke():
    async def run():
        upstream, client = Upstream(), Client()
        bridge = Bridge(upstream, client, 'project', manual=True)
        reader = asyncio.create_task(bridge.from_upstream())
        try:
            await bridge.floor.start(1)
            bridge.floor.grant = 'grant'
            bridge.floor.turn['status'] = 'answering'
            bridge.response_requested = True
            for name in ('speech', 'tool-sibling'):
                upstream.queue.put_nowait(json.dumps({'type': 'response.created', 'response': {'id': name}}))
                await settle()
            packets = [p for p in client.sent if p.get('event', {}).get('type') == 'response.created']
            assert [p['floor_grant'] for p in packets] == ['grant', 'grant']
            assert all(not p['cancelled'] for p in packets)
            bridge.floor.revoke()
            upstream.queue.put_nowait(json.dumps({'type': 'response.created', 'response': {'id': 'late'}}))
            await settle()
            assert client.sent[-1]['cancelled'] is True
        finally:
            await cleanup(bridge, reader)
    asyncio.run(run())


def test_long_question_grant_waits_for_final_chunk_ack_not_first_chunk():
    async def run():
        bridge = Bridge(Upstream(), Client(), 'project', manual=True)
        bridge.sync_playback = lambda: asyncio.sleep(0)
        await bridge.floor.start(1)
        await bridge.floor.request(1, 'grant')
        bridge.floor.audio(720000)
        await bridge.floor.chunk(1)
        bridge.floor.audio(24000)
        await bridge.floor.end(1)
        await bridge.floor.committed('chunk-1')
        await settle()
        assert not any(m['type'] == 'response.create' for m in bridge.upstream.sent)
        await bridge.floor.committed('chunk-2')
        await settle()
        assert [m['type'] for m in bridge.upstream.sent].count('response.create') == 1
        assert bridge.floor.turn['items'] == ['chunk-1', 'chunk-2']
        await bridge.floor.close()
    asyncio.run(run())


def test_tool_response_done_does_not_start_followup_while_sibling_speech_generates():
    async def run():
        upstream, client = Upstream(), Client()
        bridge = Bridge(upstream, client, 'project')
        reader = asyncio.create_task(bridge.from_upstream())
        try:
            for name in ('speech', 'tool'):
                upstream.queue.put_nowait(json.dumps({'type': 'response.created', 'response': {'id': name}}))
            await settle()
            bridge.active_responses.add('speech')
            bridge.response_has_payload.add('speech')
            bridge.continue_pending = True
            upstream.queue.put_nowait(json.dumps({'type': 'response.done', 'response': {'id': 'tool'}}))
            await settle()
            assert not bridge.idle.is_set()
            assert not any(m['type'] == 'response.create' for m in upstream.sent)
            upstream.queue.put_nowait(json.dumps({'type': 'response.done', 'response': {'id': 'speech'}}))
            await settle()
            assert [m['type'] for m in upstream.sent].count('response.create') == 1
        finally:
            reader.cancel()
            await asyncio.gather(reader, return_exceptions=True)
    asyncio.run(run())


def test_manual_tool_continuation_waits_for_audible_completion_not_just_server_done():
    async def run():
        bridge = Bridge(Upstream(), Client(), 'project', manual=True)
        await bridge.floor.start(1)
        bridge.floor.grant = 'grant'
        bridge.floor.turn['status'] = 'answering'
        bridge.playback.create('speech', None)
        bridge.playback.audio('speech', 24000)
        bridge.playback.generated('speech')
        bridge.continue_pending = True
        await bridge.continue_if_ready()
        assert bridge.continue_pending is True
        assert not any(m['type'] == 'response.create' for m in bridge.upstream.sent)
        bridge.playback.receipt({'response_id': 'speech', 'received_samples': 24000, 'played_samples': 24000}, 'completed')
        await bridge.continue_if_ready()
        assert [m['type'] for m in bridge.upstream.sent].count('response.create') == 1
        await bridge.floor.close()
    asyncio.run(run())


def test_unfinished_provisional_text_id_does_not_deadlock_real_audio_tool_id():
    async def run():
        upstream, client = Upstream(), Client()
        bridge = Bridge(upstream, client, 'project')
        reader = asyncio.create_task(bridge.from_upstream())
        try:
            for message in [
                {'type': 'response.created', 'response': {'id': 'provisional'}},
                {'type': 'response.audio_transcript.delta', 'response_id': 'provisional', 'delta': '好'},
                {'type': 'response.created', 'response': {'id': 'actual'}},
                {'type': 'response.function_call_arguments.delta', 'response_id': 'actual', 'delta': '{}'},
            ]:
                upstream.queue.put_nowait(json.dumps(message))
            await settle()
            bridge.continue_pending = True
            upstream.queue.put_nowait(json.dumps({'type': 'response.done', 'response': {'id': 'actual'}}))
            await settle()
            assert 'provisional' not in bridge.active_responses
            assert [m['type'] for m in upstream.sent].count('response.create') == 1
        finally:
            reader.cancel()
            await asyncio.gather(reader, return_exceptions=True)
    asyncio.run(run())
