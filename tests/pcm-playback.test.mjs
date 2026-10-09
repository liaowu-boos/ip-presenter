import test from 'node:test';
import assert from 'node:assert/strict';
import {SpeechPlayer} from '../frontend/src/audio.js';

globalThis.window={speechSynthesis:{cancel(){}}};
function fixture(observer){
  const events=[],sources=[],buffers=[],warnings=[];
  const player=new SpeechPlayer(x=>warnings.push(x),()=>{},event=>{events.push(event);observer?.(event);});
  player.context={state:'running',currentTime:2,
    createBuffer(ch,length,rate){const b={duration:length/rate,copyToChannel(data){b.samples=data.slice();}};buffers.push(b);return b;},
    createBufferSource(){const source={connect(){},disconnect(){},start(when){source.when=when;},stop(){source.onended?.();}};sources.push(source);return source;}};
  player.output=()=>({});player.startMeter=()=>{};
  return {player,events,sources,buffers,warnings};
}
test('mouth input uses actual scheduled PCM, including split samples and network underrun gaps',async()=>{
  const f=fixture(e=>{if(e.type==='chunk')e.samples[0]=0;});
  const stream=f.player.openPcmStream();
  assert.equal(stream.playbackId,f.events[0].playbackId,'public stream identity matches actual PCM events');
  stream.push(Uint8Array.from([0,64,0]));stream.push(Uint8Array.from([32]));
  f.player.context.currentTime=3;stream.push(Uint8Array.from([0,16]));stream.finish();
  const chunks=f.events.filter(e=>e.type==='chunk');
  assert.deepEqual(chunks.map(x=>x.sampleOffset),[0,1,2]);
  assert.deepEqual(chunks.map(x=>x.startTime),f.sources.map(s=>s.when));
  assert.equal(chunks[2].startTime,3.02);
  assert.ok(chunks[2].startTime>chunks[1].endTime+.9);
  assert.equal(f.buffers[0].samples[0],.5,'renderer must not mutate actual audio');
  assert.equal(f.buffers[1].samples[0],.25);
  assert.equal(f.events.at(-1).type,'input-ended');
  assert.equal(f.events.at(-1).sampleCount,3);
  for(const source of f.sources)source.onended();
  await stream.done;assert.equal(f.events.at(-1).type,'ended');
});
test('barge-in invalidates the old mouth stream; late chunks cannot resume it',async()=>{
  const f=fixture(),old=f.player.openPcmStream();old.push(new Uint8Array(480));
  const id=f.events[0].playbackId;f.player.stop();
  assert.equal((await old.done.catch(e=>e)).name,'AbortError');
  assert.equal(f.events.at(-1).type,'cancel');
  const count=f.events.length;old.push(new Uint8Array(480));old.finish();assert.equal(f.events.length,count);
  const next=f.player.openPcmStream();assert.notEqual(f.events.at(-1).playbackId,id);
  next.push(new Uint8Array(480));next.finish();const before=f.events.length;
  next.push(new Uint8Array(480));assert.equal(f.events.length,before,'input-ended closes producer');
  f.sources.at(-1).onended();await next.done;
});
test('a failing mouth subscriber does not prevent scheduled voice playback',async()=>{
  const f=fixture(()=>{throw Error('model unavailable');}),stream=f.player.openPcmStream();
  stream.push(new Uint8Array(480));stream.finish();assert.equal(f.sources[0].when,2.05);
  f.sources[0].onended();await stream.done;assert.ok(f.warnings.every(w=>w.includes('model unavailable')));
});
test('buffered mouth preparation releases only ready samples on the real audio clock',async()=>{
  const f=fixture();let gate;let finished=false,completion;
  f.player.pcmPreparation=options=>{gate=options;return {push(copy){copy.fill(0);},finish(){finished=true;},cancel(reason){completion=reason;}};};
  const stream=f.player.openPcmStream();stream.push(Uint8Array.from([0,64,0,32,0,16]));stream.finish();
  assert.equal(f.sources.length,0);assert.ok(finished);assert.equal(f.events.at(-1).endTime,null);
  f.player.context.currentTime=4;gate.releaseThrough(2);
  assert.deepEqual([...f.buffers[0].samples],[.5,.25]);assert.equal(f.sources[0].when,4.02);
  f.sources[0].onended();let resolved=false;stream.done.then(()=>resolved=true);await Promise.resolve();assert.equal(resolved,false);
  gate.releaseThrough(3);assert.equal(f.events.filter(e=>e.type==='chunk').at(-1).sampleOffset,2);
  assert.deepEqual([...f.buffers[1].samples],[.125]);f.sources[1].onended();await stream.done;
  assert.deepEqual(completion,{completed:true});
});
test('cancel during mouth preparation cannot schedule late buffered sound',async()=>{
  const f=fixture();let gate;let cancelled=0,completion;
  f.player.pcmPreparation=options=>{gate=options;return {push(){},cancel(reason){cancelled++;completion=reason;}};};
  const old=f.player.openPcmStream();old.push(new Uint8Array(480));f.player.stop();
  gate.releaseThrough(240);assert.equal(f.sources.length,0);assert.equal(cancelled,1);
  assert.equal((await old.done.catch(e=>e)).name,'AbortError');
  assert.deepEqual(completion,{completed:false});
});
test('normal EOF preserves real PCM and labels a bounded silent visual closure tail',async()=>{
 const f=fixture();let gate,sourceCount;
 f.player.pcmPreparation=options=>{gate=options;return {push(){},finish({appendSilence}){appendSilence(5760);}};};
 const stream=f.player.openPcmStream();stream.push(Uint8Array.from([0,64,0,32]));stream.finish();stream.finish();
 const eof=f.events.at(-1);assert.equal(eof.sampleCount,2);assert.equal(eof.closureTailSamples,5760);assert.equal(eof.playbackSampleCount,5762);
 gate.releaseThrough(5762);assert.deepEqual([...f.buffers[0].samples],[.5,.25]);assert.ok(f.buffers[1].samples.every(x=>x===0));
 assert.deepEqual(f.events.filter(e=>e.type==='chunk').map(e=>e.purpose),['speech','closure']);
 let ended=false;stream.done.then(()=>ended=true);f.sources[0].onended();await Promise.resolve();assert.equal(ended,false);f.sources[1].onended();await stream.done;
});
test('barge-in during the silent closure tail cancels it immediately',async()=>{
 const f=fixture();let gate,reason;
 f.player.pcmPreparation=options=>{gate=options;return {push(){},finish({appendSilence}){appendSilence(5760);},cancel(r){reason=r;}};};
 const stream=f.player.openPcmStream();stream.push(new Uint8Array(480));stream.finish();gate.releaseThrough(6000);
 f.sources[0].onended();f.player.stop();assert.equal((await stream.done.catch(e=>e)).name,'AbortError');assert.equal(reason.completed,false);assert.equal(f.sources[1].onended instanceof Function,true);
 const count=f.sources.length;gate.releaseThrough(6000);assert.equal(f.sources.length,count);
});
test('a last-sample picture wait cannot prevent PCM EOF from releasing the final prepared audio',async()=>{
 const f=fixture();let gate,count=0;
 f.player.pcmPreparation=options=>{gate=options;return {push(samples){count+=samples.length;},finish(){gate.releaseThrough(count);}};};
 const stream=f.player.openPcmStream();stream.push(new Uint8Array(4800));
 let ready=false;const cue=stream.waitForPlayback(2400).then(x=>{ready=true;return x;});
 await Promise.resolve();assert.equal(ready,false);assert.equal(f.sources.length,0);
 stream.finish();assert.equal(f.sources.length,1);f.sources[0].onended();
 assert.equal((await cue).playedSamples,2400);await stream.done;
 await assert.rejects(stream.waitForPlayback(2401),/无效/);
});
test('playback receipt freezes actual source samples at interruption, excluding unscheduled PCM',async()=>{
 const f=fixture();let gate;
 f.player.pcmPreparation=options=>{gate=options;return {push(){},finish(){}};};
 const stream=f.player.openPcmStream();stream.push(new Uint8Array(96000));gate.releaseThrough(24000);
 f.player.context.currentTime=2.35;
 assert.equal(stream.playbackStatus().playedSamples,7200);
 f.player.stop();await assert.rejects(stream.done,{name:'AbortError'});
 const stopped=stream.playbackStatus();
 assert.deepEqual(stopped,{receivedSamples:48000,playedSamples:7200,completed:false,cancelled:true});
 f.player.context.currentTime=20;for(const source of f.sources)source.onended();
 assert.deepEqual(stream.playbackStatus(),stopped,'late end callbacks cannot mark queued audio as heard');
});
test('normal playback receipt excludes synthetic closure tail from provider audio',async()=>{
 const f=fixture();let gate;
 f.player.pcmPreparation=options=>{gate=options;return {push(){},finish({appendSilence}){appendSilence(5760);}};};
 const stream=f.player.openPcmStream();stream.push(new Uint8Array(4800));stream.finish();gate.releaseThrough(8160);
 for(const source of f.sources)source.onended();await stream.done;
 assert.deepEqual(stream.playbackStatus(),{receivedSamples:2400,playedSamples:2400,completed:true,cancelled:false});
});
