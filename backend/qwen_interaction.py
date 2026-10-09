"""Persistent operator pause over provider VAD; no per-question grants."""


class AutoInteraction:
    def __init__(self, bridge):
        self.bridge = bridge
        self.paused = False
        self.revision = 0
        self.fresh_input = False
        self.speaking = False

    @property
    def can_answer(self):
        return not self.paused and self.fresh_input and not self.speaking

    async def set_paused(self, paused, revision):
        if type(paused) is not bool or type(revision) is not int or revision < 1:
            raise ValueError('Invalid interaction switch')
        if revision <= self.revision:
            return
        self.paused, self.revision = paused, revision
        # Resume opens the gate only for a subsequent speech_started. It must
        # not answer the author's previous words or the rest of a paused turn.
        self.fresh_input = False
        await self.bridge.cancel()
        await self.bridge.client.send_json({'type': 'interaction', 'paused': paused, 'revision': revision})

    def observe(self, kind):
        if kind == 'input_audio_buffer.speech_started':
            self.speaking = True
            self.fresh_input = not self.paused
            # Keep late output from the preceding utterance out of this one.
            self.bridge.cancelled.update(self.bridge.active_responses)
            for call in self.bridge.calls.values():
                call['cancelled'] = True
            self.bridge.continue_pending = False
        elif kind == 'input_audio_buffer.speech_stopped':
            self.speaking = False

