import test from 'node:test';
import assert from 'node:assert/strict';
import {QwenSession,pcm16,validateTool} from '../frontend/src/qwen-session.js';
import {Runtime} from '../frontend/src/runtime.js';
import {SpeechPlayer} from '../frontend/src/audio.js';
import {freshView,clone} from '../frontend/src/core.js';

globalThis.window={};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const project=()=>({name:'测试',slides:[{id:'a',title:'甲',regions:[{id:'eye',name:'图表'}],script:'第一句。第二句。'},{id:'b',title:'乙',regions:[],script:''}],knowledge:[]});
function fixture(){
  let view=freshView('a'),hearing=false;const actions=[],frames=[],messages=[],sent=[],streams=[];
  const stage={freeze(){},snapshot:()=>clone(view),async restore(v){view=clone(v);},async apply(a,p,signal){if(signal.aborted)throw new DOMException('cancel','AbortError');actions.push(a);if(a.imageId)view.main.imageId=a.imageId;},setSpeech:f=>frames.push(f),setHearing:v=>hearing=v};
  const ui={update(){},waiting(){},toast(){},message(role,text){messages.push({role,text});return messages.length;},updateMessage(id,text){messages[id-1].text=text;},cancelRecorder(){}};
  const rt=new Runtime(project(),stage,ui),session=new QwenSession(rt);session.running=true;session.token=1;session.socket={readyState:1,send:data=>sent.push(JSON.parse(data)),close(){}};
  rt.onCancel=()=>session.interrupt();rt.voiceMode=true;rt.settings.mode='qwen';rt.settings.audio='qwen';rt.audio.realtimeSpeak=(text,options)=>session.narrate(text,options);rt.audio.unlock=async()=>{};
  rt.audio.openPcmStream=({onStart})=>{
    let resolve,reject;const done=new Promise((yes,no)=>{resolve=yes;reject=no;});done.catch(()=>{});
    const stream={done,playbackId:streams.length+1,push(){onStart();},waitForPlayback:async sampleCount=>({sampleCount,playedSamples:sampleCount}),finish(){stream.remoteDone=true;},cancel(){reject(new DOMException('cancel','AbortError'));},release:resolve};streams.push(stream);return stream;
  };
  const send=e=>session.event({type:'event',event:e});
  const created=(id,extra={})=>session.event({type:'event',event:{type:'response.created',response:{id}},...extra});
  const tool=async(id,name,args,call='c1')=>{send({type:'response.function_call_arguments.done',response_id:id,call_id:call,name,arguments:JSON.stringify(args)});await session.toolChain;};
  return {rt,session,actions,frames,messages,sent,streams,send,created,tool,hearing:()=>hearing};
}

test('realtime PCM keeps signed samples and clips outside microphone range',()=>{
  const bytes=pcm16(new Float32Array([-2,-1,0,1,2])),view=new DataView(bytes.buffer);
  assert.deepEqual(Array.from({length:5},(_,i)=>view.getInt16(i*2,true)),[-32768,-32768,0,32767,32767]);
});

test('stalled narration reports the timeout, closes input, keeps the sentence and rejects late audio',async()=>{
  const f=fixture(),errors=[];let stopped=false;
  f.session.narrationTimeoutMs=15;f.session.microphone={stop(){stopped=true;}};
  f.session.cb.onFailure=e=>errors.push(e.message);
  f.rt.main=true;f.rt.lectureUnitReady=true;f.rt.position={slide:0,sentence:1};
  const promise=f.session.narrate('第二句。',{signal:f.rt.epoch.controller.signal});
  const id=f.sent.at(-1).request_id;
  await assert.rejects(promise,/讲稿声音等待超时/);
  assert.equal(f.session.running,false);assert.equal(stopped,true);assert.equal(f.rt.bookmark.sentence,1);
  assert.equal(f.rt.bookmark.ready,true);assert.equal(errors.length,1);
  assert.ok(f.rt.log.some(line=>line.text.includes('等待超时')));
  f.created('late',{request_id:id});f.send({type:'response.audio.delta',response_id:'late',delta:'AAA='});
  assert.equal(f.streams.length,0);
});

test('model tools cannot run code, invent images, or smuggle unsupported fields',()=>{
  assert.throws(()=>validateTool('execute',{code:'bad'},project()));
  assert.throws(()=>validateTool('presentation',{actions:[{type:'show_image',imageId:'made-up'}]},project()));
  assert.throws(()=>validateTool('presentation',{actions:[{type:'show_image',imageId:'a',url:'https://bad.test'}]},project()));
  assert.throws(()=>validateTool('presentation',{actions:[{type:'adjust_view',factor:Infinity}]},project()));
  assert.throws(()=>validateTool('question',{operation:'select',id:1.1},project()));
});

test('speaking interruption keeps lecture bookmark and drops late sound and tools',async()=>{
  const f=fixture();f.rt.main=true;f.rt.position={slide:0,sentence:1};f.created('old');
  f.send({type:'input_audio_buffer.speech_started'});
  assert.equal(f.hearing(),true);assert.equal(f.rt.bookmark.sentence,1);assert.equal(f.rt.main,false);
  f.send({type:'response.audio.delta',response_id:'old',delta:'AAA='});
  await f.tool('old','presentation',{actions:[{type:'show_image',imageId:'b'}]});
  assert.equal(f.streams.length,0);assert.equal(f.actions.length,0);assert.equal(f.sent.at(-1).continue,false);
  f.session.stop();
});

test('valid picture tool moves slide without overwriting lecture bookmark or personality layout',async()=>{
  const f=fixture();f.rt.bookmark={slide:0,sentence:1,view:freshView('a')};const saved=clone(f.rt.bookmark);
  f.created('one');await f.tool('one','presentation',{actions:[{type:'focus_region',imageId:'a',regionId:'eye'}]});
  assert.equal(f.actions[0].regionId,'eye');assert.deepEqual(f.rt.bookmark,saved);assert.equal(f.sent.at(-1).result.ok,true);
  f.session.stop();
});

test('duplicate function event runs exactly one local action',async()=>{
  const f=fixture();f.created('r');await f.tool('r','presentation',{actions:[{type:'restore_view'}]});await f.tool('r','presentation',{actions:[{type:'restore_view'}]});
  assert.equal(f.actions.length,1);f.session.stop();
});

test('failed or unknown tool reports failure without changing the stage',async()=>{
  const f=fixture();f.created('r');await f.tool('r','presentation',{actions:[{type:'focus_region',imageId:'a',regionId:'fake'}]});
  assert.equal(f.actions.length,0);assert.equal(f.sent.at(-1).result.ok,false);f.session.stop();
});

test('second question remains queued and asks for order instead of replacing first',async()=>{
  const f=fixture();f.created('r1');await f.tool('r1','question',{operation:'new',text:'为什么选图表？'},'c1');
  f.send({type:'input_audio_buffer.speech_started'});f.send({type:'input_audio_buffer.speech_stopped'});f.created('r2');await f.tool('r2','question',{operation:'new',text:'颜色怎么选？'},'c2');
  assert.deepEqual(f.rt.questions.map(q=>q.status),['paused','queued']);assert.equal(f.rt.activeQuestionId,1);
  assert.equal(f.sent.at(-1).result.queued,true);assert.match(f.sent.at(-1).result.instruction,/询问/);
  await f.tool('r2','question',{operation:'select',id:2},'c3');assert.equal(f.rt.activeQuestionId,2);assert.equal(f.rt.questions[1].status,'answering');f.session.stop();
});

test('author takeover suppresses speech and image changes until explicit resume/select',async()=>{
  const f=fixture();f.rt.takeover();f.created('r');f.send({type:'response.audio.delta',response_id:'r',delta:'AAA='});
  await f.tool('r','presentation',{actions:[{type:'show_image',imageId:'b'}]});
  assert.equal(f.streams.length,0);assert.equal(f.actions.length,0);assert.equal(f.sent.at(-1).result.ok,false);
  await f.tool('r','question',{operation:'new',text:'请解释图表'},'new');assert.equal(f.rt.questions[0].status,'queued');f.session.stop();
});

test('partial captions use confirmed prefix plus current draft without duplicating it',()=>{
  const f=fixture(),heard=[];f.session.cb.onHeard=text=>heard.push(text);
  f.send({type:'conversation.item.input_audio_transcription.delta',text:'为什么',stash:'选择'});
  f.send({type:'conversation.item.input_audio_transcription.delta',text:'为什么选择',stash:'图表'});
  assert.equal(heard.at(-1),'为什么选择图表');assert.equal(f.actions.length,0);f.session.stop();
});

test('answer is marked heard only after audio playback, not server generation completion',async()=>{
  const f=fixture();f.created('tool');await f.tool('tool','question',{operation:'new',text:'为什么？'});f.created('answer');
  f.send({type:'response.audio_transcript.delta',response_id:'answer',delta:'依据现有材料。'});
  f.send({type:'response.audio.delta',response_id:'answer',delta:'AAA='});
  f.send({type:'response.done',response:{id:'answer',status:'completed'}});await tick();
  assert.equal(f.rt.questions[0].status,'answering');assert.deepEqual(f.rt.questions[0].delivered,[]);
  f.streams[0].release();await tick();assert.equal(f.rt.questions[0].status,'done');assert.deepEqual(f.rt.questions[0].delivered,['依据现有材料。']);f.session.stop();
});
test('cancel after remote completion sends actual interrupted playback receipt only once',async()=>{
  const f=fixture();f.created('old');
  f.send({type:'response.audio.delta',response_id:'old',delta:btoa('\0'.repeat(200))});
  f.streams[0].playbackStatus=()=>({receivedSamples:100,playedSamples:20,cancelled:true});
  f.send({type:'response.done',response:{id:'old',status:'completed'}});await tick();
  assert.equal(f.sent.some(e=>e.type==='playback_done'),false);
  f.rt.cancel('listening');
  assert.deepEqual(f.sent.at(-1),{type:'cancel',playbacks:[{response_id:'old',received_samples:100,played_samples:20}]});
  f.rt.cancel('listening');assert.deepEqual(f.sent.at(-1).playbacks,[]);
  await tick();assert.equal(f.sent.some(e=>e.type==='playback_done'),false);f.session.stop();
});
test('only locally completed audio sends a complete playback receipt',async()=>{
  const f=fixture();f.created('answer');
  f.send({type:'response.audio.delta',response_id:'answer',delta:'AAA='});
  f.streams[0].playbackStatus=()=>({receivedSamples:1,playedSamples:1,completed:true});
  f.send({type:'response.done',response:{id:'answer',status:'completed'}});await tick();
  assert.equal(f.sent.some(e=>e.type==='playback_done'),false);
  f.streams[0].release();await tick();
  assert.deepEqual(f.sent.filter(e=>e.type==='playback_done'),[{type:'playback_done',response_id:'answer',received_samples:1,played_samples:1}]);
  f.session.stop();
});
test('interruption retires an isolated response even when its socket closes before response.done',async()=>{
  const f=fixture(),ends=[];f.session.cb.onResponseEnd=e=>ends.push(e);
  f.created('reading');f.send({type:'response.audio.delta',response_id:'reading',delta:'AAA='});
  f.rt.cancel('listening');
  assert.equal(f.session.responses.size,0);assert.equal(ends.length,1);assert.equal(ends[0].valid,false);
  f.send({type:'response.done',response:{id:'reading',status:'cancelled'}});await tick();
  assert.equal(ends.length,1);f.session.stop();
});
test('PPT animation does not delay PCM EOF, but response completion still waits for both',async()=>{
  const f=fixture();let releaseTool;const results=[];f.session.cb.onResponseEnd=r=>results.push(r);
  f.created('answer');f.send({type:'response.audio.delta',response_id:'answer',delta:'AAA='});
  f.session.responses.get('answer').tools.push(new Promise(resolve=>releaseTool=resolve));
  f.send({type:'response.done',response:{id:'answer',status:'completed'}});await tick();
  assert.equal(f.streams[0].remoteDone,true);assert.equal(results.length,0);
  f.streams[0].release();await tick();assert.equal(results.length,0);
  releaseTool();await tick();assert.equal(results.length,1);assert.equal(results[0].valid,true);f.session.stop();
});

test('picture tools capture preceding PCM samples at receipt and wait for playback rather than incoming bytes',async()=>{
 const f=fixture(),timing=[];let release,requested;
 f.session.cb.onPresentationCue=e=>timing.push(e);f.created('answer');
 // 3 bytes: one complete sample and a trailing byte, then a tool, then more audio.
 f.send({type:'response.audio.delta',response_id:'answer',delta:'AAAA'});
 f.streams[0].waitForPlayback=count=>{requested=count;return new Promise(resolve=>release=resolve);};
 const tool=f.tool('answer','presentation',{actions:[{type:'show_image',imageId:'b'}]});
 f.send({type:'response.audio.delta',response_id:'answer',delta:'AAAA'});await tick();
 assert.equal(requested,1);assert.equal(f.actions.length,0);assert.equal(timing[0].phase,'queued');
 f.send({type:'response.done',response:{id:'answer',status:'completed'}});await tick();
 assert.equal(f.streams[0].remoteDone,true,'remote EOF is not held behind the picture');
 release({sampleCount:1,playedSamples:1,playbackId:9});await tool;
 assert.equal(f.actions.length,1);assert.equal(timing.at(-1).phase,'completed');assert.equal(timing.at(-2).phase,'start');assert.equal(timing.at(-2).sampleCount,1);
 f.streams[0].release();await tick();f.session.stop();
});
test('interruption while a picture waits for audio cannot change the new turn',async()=>{
 const f=fixture();let release;f.created('answer');f.send({type:'response.audio.delta',response_id:'answer',delta:'AAA='});
 f.streams[0].waitForPlayback=()=>new Promise(resolve=>release=resolve);
 const tool=f.tool('answer','presentation',{actions:[{type:'show_image',imageId:'b'}]});await tick();
 f.send({type:'input_audio_buffer.speech_started'});release({sampleCount:1,playedSamples:1});await tool;
 assert.equal(f.actions.length,0);assert.equal(f.sent.at(-1).result.ok,false);assert.equal(f.sent.at(-1).continue,false);f.session.stop();
});

for(const ending of ['completed','interrupted','eof','failed','timeout'])test(`optional material intent is released on ${ending} without an early picture`,async()=>{
 const f=fixture(),events=[];let play,failWait;
 f.rt.stage.preparePresentationIntent=i=>{events.push({phase:'queued',...i});let released=false;return reason=>{if(!released){released=true;events.push({phase:'released',reason});}};};
 f.created('answer');f.send({type:'response.audio.delta',response_id:'answer',delta:'AAA='});
 const stream=f.streams[0];stream.playbackId=17;
 stream.waitForPlayback=()=>new Promise((resolve,reject)=>{play=resolve;failWait=reject;});
 const tool=f.tool('answer','presentation',{actions:[{type:'show_image',imageId:'b'}]});await tick();
 assert.equal(events[0].playbackId,17);assert.equal(events[0].sampleCount,1);assert.equal(f.actions.length,0);
 if(ending==='interrupted')f.rt.cancel('listening');
 if(ending==='eof')stream.release();
 if(ending==='timeout')f.session.fail(Error('test timeout'));
 if(['eof','interrupted','timeout'].includes(ending))await tick();
 if(ending==='failed')failWait(Error('picture wait failed'));else play({playbackId:17,sampleCount:1,playedSamples:1});
 await tool;stream.release();await tick();
 assert.equal(events.filter(e=>e.phase==='released').length,1);
 if(['interrupted','timeout','failed'].includes(ending))assert.equal(f.actions.length,0);
 else assert.equal(f.actions.length,1);
 f.session.stop();
});
test('tool-only response preserves before-voice behavior without creating an unowned material hint',async()=>{
 const f=fixture();let hints=0;f.rt.stage.preparePresentationIntent=()=>hints++;
 f.created('silent');await f.tool('silent','presentation',{actions:[{type:'show_image',imageId:'b'}]});
 assert.equal(hints,0);assert.equal(f.actions.length,1);f.session.stop();
});

test('unheard tail of an interrupted answer does not become completed knowledge',async()=>{
  const f=fixture();f.created('tool');await f.tool('tool','question',{operation:'new',text:'为什么？'});f.created('answer');
  f.send({type:'response.audio_transcript.delta',response_id:'answer',delta:'尚未播完的内容。'});
  f.send({type:'response.audio.delta',response_id:'answer',delta:'AAA='});
  f.send({type:'input_audio_buffer.speech_started'});f.send({type:'response.done',response:{id:'answer',status:'cancelled'}});await tick();
  assert.equal(f.rt.questions[0].status,'paused');assert.deepEqual(f.rt.questions[0].delivered,[]);f.session.stop();
});

test('lecture command waits for the tool response to end and never opens a click confirmation',async()=>{
  const f=fixture();let started=0;f.rt.startLecture=async(from,resume,confirmed)=>{assert.equal(confirmed,true);started++;};
  f.created('r');await f.tool('r','lecture',{operation:'start'});assert.equal(started,0);assert.equal(f.sent.at(-1).continue,false);
  f.send({type:'response.done',response:{id:'r',status:'completed'}});await tick();assert.equal(started,1);f.session.stop();
});

test('narration advances only after audio playback and interruption preserves the current sentence',async()=>{
  const f=fixture();const lecture=f.rt.startLecture(0,null,true);await tick();
  const request=f.sent.find(x=>x.type==='narrate');assert.equal(request.text,'第一句。');
  f.created('narration',{request_id:request.request_id});f.send({type:'response.audio.delta',response_id:'narration',delta:'AAA='});
  f.send({type:'response.done',response:{id:'narration',status:'completed'}});await tick();assert.equal(f.rt.position.sentence,0);
  f.streams[0].release();await tick();assert.equal(f.rt.position.sentence,1);assert.equal(f.sent.filter(x=>x.type==='narrate').at(-1).text,'第二句。');
  f.send({type:'input_audio_buffer.speech_started'});await lecture;assert.equal(f.rt.bookmark.sentence,1);f.session.stop();
});

test('late narration response cannot play after its request was aborted',async()=>{
  const f=fixture(),controller=new AbortController();const pending=f.session.narrate('讲稿',{signal:controller.signal}).catch(e=>e);
  const id=f.sent.at(-1).request_id;controller.abort();assert.equal((await pending).name,'AbortError');
  f.created('late',{request_id:id});f.send({type:'response.audio.delta',response_id:'late',delta:'AAA='});assert.equal(f.streams.length,0);f.session.stop();
});

test('stopped cloud session closes microphone, player, and listening pose',()=>{
  const f=fixture();let stopped=0;f.session.microphone={stop:()=>stopped++};f.rt.hearing(true);f.session.stop();
  assert.equal(stopped,1);assert.equal(f.hearing(),false);assert.equal(f.rt.onCancel,null);assert.equal(f.rt.audio.realtimeSpeak,null);assert.equal(f.session.running,false);
});

test('actual PCM stream remains active through queued playback and stops mouth immediately',async()=>{
  const frames=[],sources=[];const player=new SpeechPlayer(()=>{},frame=>frames.push(frame));
  player.context={state:'running',currentTime:0,createBuffer(ch,length,rate){return{duration:length/rate,copyToChannel(){}};},
    createBufferSource(){const s={connect(){},disconnect(){},start(){},stop(){s.onended?.();}};sources.push(s);return s;}};
  player.output=()=>({});player.startMeter=()=>frames.push({active:true,level:.1});
  const stream=player.openPcmStream();stream.push(new Uint8Array(480));stream.finish();let completed=false;stream.done.then(()=>completed=true);
  await tick();assert.equal(completed,false);assert.equal(frames.at(-1).active,true);
  sources[0].onended();await stream.done;assert.equal(frames.at(-1).active,false);
  const next=player.openPcmStream();next.push(new Uint8Array(480));player.stop();assert.equal((await next.done.catch(e=>e)).name,'AbortError');assert.equal(frames.at(-1).active,false);
});

test('fast generated minute of speech stays playable and immediately cancellable with a bounded queue',async()=>{
 const sources=[],player=new SpeechPlayer();
 player.context={state:'running',currentTime:0,createBuffer(ch,length,rate){return {duration:length/rate,copyToChannel(){}};},
  createBufferSource(){const s={stopped:false,connect(){},disconnect(){},start(){},stop(){s.stopped=true;s.onended?.();}};sources.push(s);return s;}};
 player.output=()=>({});player.startMeter=()=>{};
 const stream=player.openPcmStream();for(let i=0;i<60;i++)stream.push(new Uint8Array(48000));
 assert.equal(stream.playbackStatus().cancelled,false);assert.equal(stream.playbackStatus().receivedSamples,24000*60);
 player.stop();await assert.rejects(stream.done,{name:'AbortError'});assert.ok(sources.every(s=>s.stopped));
 const bounded=player.openPcmStream();for(let i=0;i<121;i++)bounded.push(new Uint8Array(48000));
 await assert.rejects(bounded.done,/缓存上限/);assert.ok(bounded.playbackStatus().receivedSamples<=24000*120);
 player.stop();
});


test('a late response created while the user is speaking is cancelled before playback',()=>{
  const f=fixture();f.send({type:'input_audio_buffer.speech_started'});f.created('delayed');
  f.send({type:'response.audio.delta',response_id:'delayed',delta:'AAA='});
  assert.equal(f.streams.length,0);assert.equal(f.sent.at(-1).type,'cancel');f.session.stop();
});

test('completed audio returns to connected listening only after playback; explicit pause still pauses',async()=>{
 const f=fixture();f.created('answer');f.send({type:'response.audio.delta',response_id:'answer',delta:'AAA='});assert.equal(f.rt.status,'speaking');
 f.send({type:'response.done',response:{id:'answer',status:'completed'}});await tick();assert.equal(f.rt.status,'speaking');
 f.streams[0].release();await tick();assert.equal(f.rt.status,'listening');f.rt.cancel('paused');assert.equal(f.rt.status,'paused');f.session.stop();
});

function gestureFixture(){
  const f=fixture(),gestures=[],phases=[];
  f.rt.stage.capabilities={gestures:['explain','smile']};
  f.rt.stage.speechGesture=(kind,options)=>{gestures.push({kind,...options});return {clip:kind,audioTime:1};};
  f.session.cb.onGestureCue=e=>phases.push(e);
  const audio=id=>{f.send({type:'response.audio.delta',response_id:id,delta:'AAAAAA=='});f.streams.at(-1).playbackId=f.streams.length;};
  return {...f,gestures,phases,audio};
}

test('gesture schema and renderer capability reject unsupported operations',async()=>{
  for(const args of [{kind:'point'},{kind:'smile',script:'bad'},{}])assert.throws(()=>validateTool('performer_gesture',args,project()));
  const f=fixture();f.created('r');await f.tool('r','performer_gesture',{kind:'explain'});
  assert.equal(f.sent.at(-1).result.ok,false);assert.equal(f.session.pendingGesture,undefined);f.session.stop();
});

test('spoken gesture waits for the PCM boundary captured before later packets',async()=>{
  const f=gestureFixture();f.created('r');f.audio('r');let reach,asked;
  f.streams[0].waitForPlayback=n=>{asked=n;return new Promise(r=>reach=r);};
  const task=f.tool('r','performer_gesture',{kind:'explain'});await tick();f.audio('r');
  assert.equal(asked,2);assert.equal(f.gestures.length,0);
  reach({playedSamples:2,sampleCount:2});await task;
  assert.equal(f.gestures.length,1);assert.equal(f.gestures[0].playbackId,1);
  assert.equal(f.sent.at(-1).result.status,'scheduled');assert.equal(f.phases.at(-1).phase,'scheduled');
  await f.tool('r','performer_gesture',{kind:'smile'},'c2');assert.equal(f.sent.at(-1).result.ok,false);
  await f.tool('r','performer_gesture',{kind:'explain'});assert.equal(f.gestures.length,1);f.session.stop();
});

test('tool-only gesture is acknowledged as queued and consumed by next spoken response',async()=>{
  const f=gestureFixture();f.created('tool');await f.tool('tool','performer_gesture',{kind:'smile'});
  assert.equal(f.sent.at(-1).result.status,'queued-for-speech');assert.equal(f.gestures.length,0);
  f.send({type:'response.done',response:{id:'tool',status:'completed'}});await tick();
  assert.equal(f.session.responses.has('tool'),false);
  f.created('answer');f.audio('answer');await tick();
  assert.equal(f.gestures.length,1);assert.equal(f.phases.at(-1).originResponseId,'tool');
  assert.equal(f.phases.at(-1).responseId,'answer');assert.equal(f.phases.at(-1).sampleCount,1);
  assert.equal(f.session.pendingGesture,null);f.audio('answer');await tick();assert.equal(f.gestures.length,1);f.session.stop();
});

test('manual answer with inherited local gesture releases its grant after audible completion',async()=>{
 const f=gestureFixture();Object.assign(f.session,{manualAnswers:true,floorTurn:1,floorStatus:'waiting'});
 f.session.answerOnce();const grant=f.session.floorPermit,owner={floor_turn:1,floor_grant:grant};
 f.created('tool',owner);await f.tool('tool','performer_gesture',{kind:'smile'});
 f.send({type:'response.done',response:{id:'tool',status:'completed'}});await tick();
 f.created('answer',owner);f.audio('answer');await tick();assert.equal(f.gestures.length,1);
 f.send({type:'response.done',response:{id:'answer',status:'completed'}});await tick();
 assert.equal(f.session.floorPermit,grant);f.streams[0].release();await tick();
 assert.equal(f.session.floorPermit,null);assert.equal(f.session.floorStatus,'answered');assert.equal(f.session.running,true);
 assert.equal(f.sent.at(-1).type,'answer_done');f.session.stop();
});

test('tool before audio in the same response consumes only after actual playback starts',async()=>{
  const f=gestureFixture();f.created('r');await f.tool('r','performer_gesture',{kind:'explain'});
  let start,resolve;f.rt.audio.openPcmStream=({onStart})=>{start=onStart;return {playbackId:41,push(){},done:new Promise(r=>resolve=r),cancel(){resolve()},waitForPlayback:async n=>({playedSamples:n})};};
  f.send({type:'response.audio.delta',response_id:'r',delta:'AAAAAA=='});assert.equal(f.gestures.length,0);
  start();await tick();assert.equal(f.gestures[0].playbackId,41);assert.equal(f.session.pendingGesture,null);f.session.stop();
});

test('interruption cancels pending and in-flight gesture waits without next-answer leakage',async()=>{
  for(const hasAudio of [false,true]){
    const f=gestureFixture();f.created('old');let reach;
    if(hasAudio){f.audio('old');f.streams[0].waitForPlayback=()=>new Promise(r=>reach=r);}
    const task=f.tool('old','performer_gesture',{kind:'explain'});await tick();f.rt.cancel('listening');
    reach?.({playedSamples:2});await task;
    f.created('new');f.audio('new');await tick();assert.equal(f.gestures.length,0);assert.equal(f.session.pendingGesture,null);f.session.stop();
  }
});

test('unused gesture expires after its first successor, narration, or changed question',async()=>{
  for(const mode of ['no-audio','narration','question']){
    const f=gestureFixture();f.created('tool');await f.tool('tool','performer_gesture',{kind:'explain'});
    if(mode==='question')f.rt.questions.push({id:12,status:'answering'}),f.rt.activeQuestionId=12;
    f.created('next',mode==='narration'?{request_id:'unowned'}:{});
    if(mode==='no-audio'){f.send({type:'response.done',response:{id:'next',status:'completed'}});await tick();}
    f.created('later');f.audio('later');await tick();assert.equal(f.gestures.length,0);assert.equal(f.session.pendingGesture,null);f.session.stop();
  }
});

test('renderer refusal, takeover, and an expired stream never report gesture success',async()=>{
  for(const mode of ['refused','takeover','replaced']){
    const f=gestureFixture();f.created('r');f.audio('r');let reach;
    f.streams[0].waitForPlayback=()=>new Promise(r=>reach=r);
    const task=f.tool('r','performer_gesture',{kind:'explain'});await tick();
    if(mode==='refused')f.rt.stage.speechGesture=()=>null;
    if(mode==='takeover')f.rt.humanControl=true;
    if(mode==='replaced')f.session.responses.get('r').stream={cancel(){}};
    reach({playedSamples:2});await task;assert.equal(f.sent.at(-1).result.ok,false);assert.equal(f.gestures.length,0);f.session.stop();
  }
});

test('a gesture claimed by the next response cannot be stolen by late origin audio',async()=>{
  const f=gestureFixture();f.created('origin');await f.tool('origin','performer_gesture',{kind:'explain'});
  f.created('next');f.audio('origin');await tick();assert.equal(f.gestures.length,0);assert.equal(f.session.pendingGesture.targetId,'next');
  f.audio('next');await tick();assert.equal(f.gestures.length,1);assert.equal(f.phases.at(-1).responseId,'next');f.session.stop();
});

test('missing PCM owner identity cannot bypass the performer ownership check',async()=>{
  const f=gestureFixture();f.created('r');f.audio('r');delete f.streams[0].playbackId;
  await f.tool('r','performer_gesture',{kind:'explain'});assert.equal(f.sent.at(-1).result.ok,false);assert.equal(f.gestures.length,0);f.session.stop();
});

for(const kind of ['laugh','shy','sad','angry'])test(`${kind} tool follows owned audio and rejects unsupported renderer`,async()=>{
 const unsupported=gestureFixture();unsupported.created('r');await unsupported.tool('r','performer_gesture',{kind});
 assert.equal(unsupported.sent.at(-1).result.ok,false);assert.equal(unsupported.gestures.length,0);unsupported.session.stop();
 const f=gestureFixture();f.rt.stage.capabilities.gestures=[kind];f.created('r');f.audio('r');let reach;
 f.streams[0].waitForPlayback=n=>new Promise(r=>{reach=()=>r({playedSamples:n,sampleCount:n});});
 const pending=f.tool('r','performer_gesture',{kind});await tick();assert.equal(f.gestures.length,0);reach();await pending;
 assert.equal(f.gestures[0].kind,kind);assert.equal(f.gestures[0].playbackId,1);
 f.rt.cancel('listening');await f.tool('r','performer_gesture',{kind},'late');assert.equal(f.gestures.length,1);f.session.stop();
});

test('manual floor refuses unsolicited PCM and tools even when upstream ignores manual mode',async()=>{
 const f=fixture();f.session.manualAnswers=true;f.session.floorTurn=1;f.session.floorPermit=null;f.rt.humanControl=true;
 f.created('unsolicited');f.send({type:'response.audio.delta',response_id:'unsolicited',delta:'AAA='});
 await f.tool('unsolicited','presentation',{actions:[{type:'show_image',imageId:'b'}]});
 assert.equal(f.streams.length,0);assert.equal(f.actions.length,0);assert.equal(f.sent.at(-1).continue,false);f.session.stop();
});

test('one manual grant answers only its owned turn and returns to listening after actual playback',async()=>{
 const f=fixture();Object.assign(f.session,{manualAnswers:true,floorTurn:3,floorStatus:'waiting'});f.rt.humanControl=true;
 assert.equal(f.session.answerOnce(),true);const grant=f.session.floorPermit;assert.equal(f.sent.at(-1).type,'answer_grant');
 f.created('old',{floor_turn:2,floor_grant:'old'});f.send({type:'response.audio.delta',response_id:'old',delta:'AAA='});assert.equal(f.streams.length,0);
 f.created('owned',{floor_turn:3,floor_grant:grant});f.send({type:'response.audio.delta',response_id:'owned',delta:'AAA='});
 f.send({type:'response.done',response:{id:'owned',status:'completed'}});await tick();assert.equal(f.session.floorPermit,grant);
 f.streams[0].release();await tick();assert.equal(f.session.floorPermit,null);assert.equal(f.session.floorStatus,'answered');assert.equal(f.rt.humanControl,true);
 assert.equal(f.sent.at(-1).type,'answer_done');assert.equal(f.session.answerOnce(),false);f.session.stop();
});

test('manual key grants and commits the captured question synchronously rather than waiting for silence',()=>{
 const f=fixture();Object.assign(f.session,{manualAnswers:true,floorTurn:1,floorStatus:'listening',speechActive:true});
 f.session.listening={submitNow(){f.session.speechActive=false;f.session.send({type:'listen_end',turn_id:1});}};
 assert.equal(f.session.answerOnce(),true);
 assert.deepEqual(f.sent.map(e=>e.type),['answer_grant','listen_end']);
 assert.equal(f.session.speechActive,false);assert.ok(f.session.floorPermit);
 f.session.answerOnce();assert.equal(f.session.floorPermit,null);assert.equal(f.sent.at(-1).type,'answer_hold');
 f.session.stop();
});

test('automatic pause stops playing immediately, keeps session, ignores stale replies and resumes only new input',async()=>{
 const f=fixture();Object.assign(f.session,{switchAnswers:true,interactionReady:true,interactionPaused:false,interactionRevision:0,awaitingFreshInput:false});
 f.created('talking',{interaction_revision:0});f.send({type:'response.audio.delta',response_id:'talking',delta:'AAA='});
 assert.equal(f.streams.length,1);f.session.toggleInteraction();
 assert.equal(f.session.interactionPaused,true);assert.equal(f.session.running,true);assert.equal(f.rt.humanControl,true);
 assert.deepEqual(f.sent.at(-1),{type:'interaction_control',paused:true,revision:1});
 f.created('late',{interaction_revision:0});f.send({type:'response.audio.delta',response_id:'late',delta:'AAA='});
 await f.tool('late','presentation',{actions:[{type:'show_image',imageId:'b'}]});
 assert.equal(f.streams.length,1);assert.equal(f.actions.length,0);
 f.session.toggleInteraction();assert.equal(f.session.awaitingFreshInput,true);
 f.created('paused-tail',{interaction_revision:2});f.send({type:'response.audio.delta',response_id:'paused-tail',delta:'AAA='});assert.equal(f.streams.length,1);
 f.session.interactionEvent({paused:true,revision:1});assert.equal(f.session.interactionPaused,false);
 f.send({type:'input_audio_buffer.speech_started'});f.send({type:'input_audio_buffer.speech_stopped'});
 f.created('next',{interaction_revision:2});f.send({type:'response.audio.delta',response_id:'next',delta:'AAA='});assert.equal(f.streams.length,2);
 assert.equal(f.sent.some(e=>['answer_grant','listen_start','listen_end'].includes(e.type)),false);
 f.send({type:'response.done',response:{id:'next',status:'completed'}});await tick();f.streams.at(-1).release();await tick();
 assert.equal(f.session.running,true);assert.equal(f.session.interactionPaused,false);f.session.stop();
});

test('pausing midway through a question stays quiet on its end and cannot enqueue or self-resume',async()=>{
 const f=fixture();Object.assign(f.session,{switchAnswers:true,interactionReady:true,interactionPaused:false,interactionRevision:0,awaitingFreshInput:true});
 f.send({type:'input_audio_buffer.speech_started'});f.session.toggleInteraction();f.send({type:'input_audio_buffer.speech_stopped'});
 f.created('paused-question',{interaction_revision:1});f.send({type:'response.audio.delta',response_id:'paused-question',delta:'AAA='});assert.equal(f.streams.length,0);
 await f.tool('paused-question','lecture',{operation:'resume'});assert.equal(f.sent.at(-1).result.ok,false);
 assert.equal(f.session.running,true);assert.equal(f.session.interactionPaused,true);f.session.stop();
});

test('manual hold cancels playback and late grant acknowledgement cannot reopen it',async()=>{
 const f=fixture();Object.assign(f.session,{manualAnswers:true,floorTurn:1,floorStatus:'waiting'});f.session.answerOnce();const grant=f.session.floorPermit;
 f.created('answer',{floor_turn:1,floor_grant:grant});f.send({type:'response.audio.delta',response_id:'answer',delta:'AAA='});
 f.session.holdAnswer();f.session.floorEvent({turn_id:1,grant_id:grant,status:'answering'});
 assert.equal(f.session.floorPermit,null);assert.equal(f.rt.humanControl,true);
 f.created('late',{floor_turn:1,floor_grant:grant});f.send({type:'response.audio.delta',response_id:'late',delta:'AAA='});assert.equal(f.streams.length,1);
 assert.equal(f.sent.some(e=>e.type==='answer_hold'),true);f.session.stop();
});

test('authorized model still cannot enqueue old questions or resume lecture in manual mode',async()=>{
 const f=fixture();Object.assign(f.session,{manualAnswers:true,floorTurn:1,floorStatus:'waiting'});f.session.answerOnce();
 f.created('one',{floor_turn:1,floor_grant:f.session.floorPermit});
 await f.tool('one','question',{operation:'new',text:'先前作者已答的问题'},'q');assert.equal(f.rt.questions.length,0);
 await f.tool('one','lecture',{operation:'resume'},'l');assert.equal(f.rt.main,false);assert.equal(f.sent.at(-1).continue,false);f.session.stop();
});
