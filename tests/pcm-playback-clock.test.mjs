import test from 'node:test';
import assert from 'node:assert/strict';
import {PcmPlaybackClock} from '../frontend/src/pcm-playback-clock.js';

function fixture(){
 const context={state:'running',currentTime:1},timers=new Map();let id=0;
 const clock=new PcmPlaybackClock(context,7,{schedule:fn=>{timers.set(++id,fn);return id;},unschedule:id=>timers.delete(id)});
 const advance=time=>{context.currentTime=time;for(const [id,fn] of [...timers]){timers.delete(id);fn();}};
 return {context,clock,timers,advance};
}
test('waiting for a picture tracks actual scheduled sound, including buffering, gaps and suspended playback',async()=>{
 const f=fixture();let ready=false;
 const waiting=f.clock.wait(3600).then(result=>{ready=true;return result;});
 f.advance(9);await Promise.resolve();assert.equal(ready,false,'received but unscheduled samples do not count');
 f.clock.add(0,2400,10);f.clock.add(2400,2400,11);
 f.advance(10.7);await Promise.resolve();assert.equal(ready,false);assert.equal(f.clock.position(),2400,'network gap must not advance sample offset');
 f.context.state='suspended';f.advance(11.08);await Promise.resolve();assert.equal(ready,false,'suspension never releases a picture');
 f.context.state='running';f.advance(11.05);const result=await waiting;
 assert.equal(result.sampleCount,3600);assert.equal(result.playedSamples,3600);assert.equal(result.playbackId,7);assert.equal(f.timers.size,0);
 f.clock.finish();
});
test('cancelling voice rejects pending picture cues and does not leave a polling timer',async()=>{
 const f=fixture();f.clock.add(0,24000,2);const result=f.clock.wait(10000).catch(e=>e);
 f.clock.finish(new DOMException('cancel','AbortError'));
 assert.equal((await result).name,'AbortError');assert.equal(f.timers.size,0);
 f.clock.ended(24000);await assert.rejects(f.clock.wait(10000),{name:'AbortError'});
});
test('completed source releases the exact last-sample cue and remains readable after normal EOF',async()=>{
 const f=fixture();f.clock.add(0,960,2);const waiting=f.clock.wait(960);
 f.clock.ended(960);f.clock.finish();assert.equal((await waiting).playedSamples,960);
 assert.equal((await f.clock.wait(960)).playedSamples,960);assert.equal(f.timers.size,0);
});
