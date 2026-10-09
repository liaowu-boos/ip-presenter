"""One operator grant, one answer. Listening never implicitly grants the floor."""
import asyncio
import json
from collections import deque


class ManualFloor:
    def __init__(self, bridge):
        self.bridge = bridge
        self.turn = None
        self.turns = []
        self.commits = deque()
        self.grant = None
        self.starting = None
        self.serial = 0

    async def notify(self, note=''):
        turn = self.turn or {}
        await self.bridge.client.send_json({'type': 'floor', 'turn_id': turn.get('id'),
            'status': turn.get('status', 'listening'), 'capturing': turn.get('capturing', False),
            'grant_id': self.grant, 'note': note})

    def revoke(self):
        self.serial += 1
        self.grant = None
        if self.turn and self.turn['status'] not in ('answered', 'context'):
            self.turn['status'] = 'context'

    async def start(self, turn_id):
        if type(turn_id) is not int or turn_id < 1 or self.turn and turn_id <= self.turn['id']:
            raise ValueError('Invalid listening turn')
        if self.turn and self.turn['capturing']:
            raise ValueError('Listening turn already active')
        await self.bridge.cancel()
        self.turn = {'id': turn_id, 'capturing': True, 'status': 'listening', 'samples': 0, 'item_id': None, 'items': [], 'pending': 0}
        self.turns.append(self.turn)
        self.turns = self.turns[-40:]
        await self.notify()

    def audio(self, samples):
        if not self.turn or not self.turn['capturing']:
            raise ValueError('Audio outside listening turn')
        self.turn['samples'] += samples
        if self.turn['samples'] > 24000 * 35:
            raise ValueError('Listening turn too long')

    async def end(self, turn_id):
        if not self.turn or turn_id != self.turn['id'] or not self.turn['capturing']:
            raise ValueError('Invalid listening end')
        self.turn['capturing'] = False
        if self.turn['samples'] < 2400:
            if not self.turn['items'] and not self.turn['pending']:
                self.revoke()
            await self.bridge.send('input_audio_buffer.clear')
        else:
            await self.commit()
        if self.turn['status'] == 'listening':
            self.turn['status'] = 'waiting'
        self.schedule()
        await self.notify()

    async def commit(self):
        if len(self.commits) >= 8:
            raise ValueError('Input commit acknowledgement stalled')
        self.commits.append(self.turn)
        self.turn['pending'] += 1
        self.turn['samples'] = 0
        await self.bridge.send('input_audio_buffer.commit')

    async def chunk(self, turn_id):
        if not self.turn or turn_id != self.turn['id'] or not self.turn['capturing'] or self.turn['samples'] < 2400:
            raise ValueError('Invalid continued speech chunk')
        # A 30-second transport chunk is not the end of a teacher's question.
        await self.commit()

    async def request(self, turn_id, grant_id):
        if not isinstance(grant_id, str) or not 1 <= len(grant_id) <= 100:
            raise ValueError('Invalid floor grant')
        if not self.turn or turn_id != self.turn['id'] or self.turn['status'] not in ('listening', 'waiting') or self.grant:
            await self.notify('这一段已结束或尚无新的提问，请继续倾听。')
            return
        self.grant = grant_id
        self.turn['status'] = 'armed'
        await self.notify()
        self.schedule()

    async def committed(self, item_id):
        if not self.commits:
            return
        turn = self.commits.popleft()
        if not isinstance(item_id, str) or not item_id:
            raise ValueError('Input commit missing item ID')
        turn['item_id'] = item_id
        turn['items'].append(item_id)
        turn['pending'] -= 1
        self.schedule()

    def schedule(self):
        if not self.grant or not self.turn or not self.turn['item_id'] or self.turn['capturing'] or self.turn['pending']:
            return
        if self.starting and not self.starting.done():
            return
        self.starting = asyncio.create_task(self.begin(self.serial, self.turn, self.grant))

    async def begin(self, serial, turn, grant):
        try:
            await asyncio.wait_for(self.bridge.idle.wait(), 12)
            if serial != self.serial or grant != self.grant or turn is not self.turn:
                return
            # Audio items remain in the same conversation, including the author's
            # answers. Only this input item is a request to the character.
            await self.bridge.sync_playback()
            if serial != self.serial or grant != self.grant or turn is not self.turn:
                return
            turn['status'] = 'answering'
            await self.notify()
            await self.bridge.create_response()
        except asyncio.CancelledError:
            raise
        except Exception:
            self.revoke()
            await self.notify('本轮未能开始回答，仍保持安静；请重新开启现场对话。')
        finally:
            self.starting = None
            if self.grant and self.turn and self.turn['status'] == 'armed':
                self.schedule()

    async def hold(self):
        await self.bridge.cancel()
        await self.notify()

    async def done(self, grant_id):
        if self.grant and grant_id == self.grant:
            self.turn['status'] = 'answered'
            self.revoke()
            await self.notify()

    def prompt(self):
        rows = [{key: t.get(key) for key in ('id', 'item_id', 'status')} for t in self.turns[-16:]]
        selected = self.turn['item_id'] if self.grant and self.turn else None
        return ('\n现场发言权由操作者按键决定，不能依据声音自行取得。所有收听录音均保留为对话上下文，'
                '没有被选中的录音仅作背景，可能包括老师与作者的交流；不是等待你逐条补答的问题队列。'
                '不得声称辨认出了说话者身份。只回答 selected_item_id 所对应录音中的当前提问，'
                '必要时结合前文理解指代和作者已说明的内容；不要重新回答先前未授权的提问或复述作者刚说完的回答。'
                '只在当前问题明确要求时再讨论之前话题。直接回答问题，调图前不要反复说同一句开场白；已显示的图片不必重复切换。答完即安静，不问还要先答哪道、不自行恢复主讲。'
                '没有选中项时保持安静。图片/表情工具只能为当前获准回答服务。\n'
                + json.dumps({'selected_item_id': selected, 'selected_item_ids': self.turn['items'] if selected else [], 'listened_turns': rows}, ensure_ascii=False))

    async def close(self):
        self.revoke()
        if self.starting:
            self.starting.cancel()
            await asyncio.gather(self.starting, return_exceptions=True)
