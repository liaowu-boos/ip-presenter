import asyncio
import json

import pytest

from backend.qwen_playback import PlaybackLedger
from backend.qwen_realtime import Bridge
from test_qwen import FakeClient, FakeUpstream


def generated():
    ledger = PlaybackLedger()
    ledger.create('old', 'narration')
    ledger.text('old', '第一句。尚未听到的末句。')
    ledger.audio('old', 48000)
    ledger.generated('old')
    return ledger


def test_remote_generation_is_pending_until_actual_playback_receipt():
    ledger = generated()
    assert ledger.summary()[0]['status'] == 'pending'
    assert ledger.summary()[0]['played_samples'] is None
    ledger.receipt({'response_id': 'old', 'played_samples': 7200, 'received_samples': 48000}, 'interrupted')
    assert ledger.summary()[0]['status'] == 'interrupted'
    assert ledger.summary()[0]['played_samples'] == 7200
    assert '没有逐字对齐' in ledger.prompt('项目资料')
    assert '尚未听到的末句' not in ledger.prompt('项目资料')  # no generated transcript is inserted as heard
    with pytest.raises(ValueError, match='rewrite'):
        ledger.receipt({'response_id': 'old', 'played_samples': 48000, 'received_samples': 48000}, 'completed')


@pytest.mark.parametrize('receipt', [
    {'response_id': 'unknown', 'played_samples': 1, 'received_samples': 1},
    {'response_id': 'old', 'played_samples': -1, 'received_samples': 48000},
    {'response_id': 'old', 'played_samples': True, 'received_samples': 48000},
    {'response_id': 'old', 'played_samples': 100, 'received_samples': 48001},
    {'response_id': 'old', 'played_samples': 10, 'received_samples': 48000},
])
def test_invalid_or_partial_delivery_never_confirms_heard(receipt):
    ledger = generated()
    with pytest.raises(ValueError):
        ledger.receipt(receipt, 'completed')
    assert ledger.summary()[0]['status'] == 'pending'


def test_completion_is_exact_idempotent_and_cannot_be_downgraded():
    ledger = generated()
    receipt = {'response_id': 'old', 'played_samples': 48000, 'received_samples': 48000}
    assert ledger.receipt(receipt, 'completed')
    assert not ledger.receipt(receipt, 'completed')
    with pytest.raises(ValueError):
        ledger.receipt(receipt, 'interrupted')
    assert not ledger.interrupt('old')


def test_bounded_ledger_does_not_evict_unconfirmed_active_playback():
    ledger = PlaybackLedger()
    for i in range(32):
        ledger.create(str(i), None)
    with pytest.raises(ValueError):
        ledger.create('overflow', None)
    ledger.interrupt('8')
    ledger.create('next', None)
    assert len(ledger.responses) == 32 and '8' not in ledger.responses and '0' in ledger.responses
    assert len(ledger.summary()) == 8


def test_cancel_after_remote_done_updates_provider_with_actual_unheard_status():
    async def run():
        upstream, client = FakeUpstream(), FakeClient()
        bridge = Bridge(upstream, client, '项目资料与工具规则')
        bridge.playback = generated()
        # The server finished generation; the browser still had 1.7s unplayed.
        bridge.active = None
        reader = asyncio.create_task(bridge.from_upstream())
        try:
            await bridge.cancel([{'response_id': 'old', 'played_samples': 7200, 'received_samples': 48000}])
        finally:
            reader.cancel()
            await asyncio.gather(reader, return_exceptions=True)
        assert [p['type'] for p in upstream.sent] == ['session.update']
        prompt = upstream.sent[0]['session']['instructions']
        assert 'interrupted' in prompt and '7200' in prompt and '没有逐字对齐' in prompt
        ack = client.sent[-1]['event']
        assert ack['type'] == 'playback.context.updated'
        assert ack['provider_instructions_echo_matches'] is None
        assert ack['remote_history_deleted'] is False
        assert 'old' in bridge.cancelled
    asyncio.run(run())


def test_only_matching_complete_receipt_restores_narration_prompt():
    async def run():
        upstream, client = FakeUpstream(), FakeClient()
        bridge = Bridge(upstream, client, '项目资料')
        bridge.playback = generated(); bridge.narration = 'narration'
        reader = asyncio.create_task(bridge.from_upstream())
        client.queue.put_nowait({'type': 'websocket.receive', 'text': json.dumps({
            'type': 'playback_done', 'response_id': 'old', 'played_samples': 48000, 'received_samples': 48000})})
        client.queue.put_nowait({'type': 'websocket.disconnect'})
        try:
            await bridge.from_client()
        finally:
            reader.cancel(); await asyncio.gather(reader, return_exceptions=True)
        assert bridge.narration is None
        assert bridge.playback.summary()[0]['status'] == 'completed'
        assert len(upstream.sent) == 1 and upstream.sent[0]['session']['tools']
    asyncio.run(run())


def test_isolated_narration_never_changes_dialogue_role_or_inserts_unheard_text():
    async def run():
        class Reader(FakeUpstream):
            async def send(self, raw):
                packet = json.loads(raw)
                await super().send(raw)
                if packet['type'] == 'response.create':
                    for event in [
                        {'type': 'response.created', 'response': {'id': 'read-1'}},
                        {'type': 'response.audio_transcript.delta', 'response_id': 'read-1', 'delta': '没有播完的讲稿。'},
                        {'type': 'response.audio.delta', 'response_id': 'read-1', 'delta': 'AAA='},
                        {'type': 'response.done', 'response': {'id': 'read-1', 'status': 'completed'}},
                    ]:
                        self.queue.put_nowait(json.dumps(event))
        primary, child, client = FakeUpstream(), Reader(), FakeClient()
        bridge = Bridge(primary, client, '项目知识与问答规则', narration_factory=lambda: child)
        bridge.isolated_narration_request = 'n1'
        await bridge.narrate_isolated('没有播完的讲稿。', 'n1')
        assert child.closed and not primary.closed
        assert primary.sent == []
        assert child.sent[0]['session']['tools'] == []
        assert child.sent[0]['session']['voice'] == 'Tina'
        audio = next(p for p in client.sent if p['event']['type'] == 'response.audio.delta')
        assert audio['request_id'] == 'n1'
        assert bridge.narration is None and bridge.active is None
        reader = asyncio.create_task(bridge.from_upstream())
        try:
            await bridge.cancel([{'response_id': 'read-1', 'played_samples': 0, 'received_samples': 1}])
        finally:
            reader.cancel(); await asyncio.gather(reader, return_exceptions=True)
        assert [e['type'] for e in primary.sent] == ['session.update']
        assert '没有播完的讲稿' not in primary.sent[0]['session']['instructions']
        assert primary.sent[0]['session']['tools']
    asyncio.run(run())


def test_cancel_pending_narration_closes_only_its_socket_and_allows_primary_input():
    async def run():
        class Pending(FakeUpstream):
            async def send(self, raw):
                self.sent.append(json.loads(raw))  # no session.updated yet
        primary, child, client = FakeUpstream(), Pending(), FakeClient()
        bridge = Bridge(primary, client, '问答规则', narration_factory=lambda: child)
        bridge.isolated_narration_request = 'n1'
        task = bridge.narration_task = asyncio.create_task(bridge.narrate_isolated('原稿', 'n1'))
        for _ in range(4):
            await asyncio.sleep(0)
        await bridge.cancel()
        assert task.cancelled() and child.closed and not primary.closed
        assert not client.sent
        assert all(e['type'] != 'response.create' for e in child.sent)
        client.queue.put_nowait({'type': 'websocket.receive', 'bytes': b'\0\0'})
        client.queue.put_nowait({'type': 'websocket.disconnect'})
        await bridge.from_client()
        assert primary.sent[-1]['type'] == 'input_audio_buffer.append'
    asyncio.run(run())
