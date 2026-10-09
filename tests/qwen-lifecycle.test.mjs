import test from 'node:test';
import assert from 'node:assert/strict';
import {Runtime} from '../frontend/src/runtime.js';
import {QwenSession} from '../frontend/src/qwen-session.js';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
function fixture(t,{microphoneStarts=[]}={}){
  const oldWindow=globalThis.window,oldLocation=globalThis.location;
  globalThis.window={};globalThis.location={href:'http://localhost/'};
  const sockets=[],microphones=[],errors=[],levels=[],states=[];
  const stage={snapshot:()=>({main:{imageId:'a',scale:1,x:0,y:0},secondary:null}),freeze(){},async apply(){},setSpeech(){},setHearing(){}};
  const rt=new Runtime({name:'local test',slides:[{id:'a',title:'A',script:'',regions:[]}],knowledge:[]},stage,{update(){},waiting(){},toast:text=>errors.push(text)});
  rt.audio.unlock=async()=>{};
  class Socket {
    constructor(){this.readyState=0;this.bufferedAmount=0;this.sent=[];sockets.push(this);}
    send(data){this.sent.push(data);}
    ready(answerMode){this.readyState=1;this.onopen();this.onmessage({data:JSON.stringify({type:'ready',answer_mode:answerMode})});}
    close(){this.readyState=3;this.onclose?.();}
  }
  class Microphone {
    constructor(callbacks){this.cb=callbacks;this.index=microphones.length;this.stops=0;microphones.push(this);}
    async start(){await microphoneStarts[this.index]?.promise;}
    stop(){this.stops++;}
  }
  const session=new QwenSession(rt,{onState:s=>states.push(s),onLevel:n=>levels.push(n)},{Socket,Microphone});
  t.after(()=>{session.stop();globalThis.window=oldWindow;globalThis.location=oldLocation;});
  async function connect(options={}){const pending=session.start(options);await tick();sockets.at(-1).ready(options.answerMode);await tick();return {pending,socket:sockets.at(-1),microphone:microphones.at(-1)};}
  return {session,rt,stage,sockets,microphones,errors,levels,states,connect};
}

test('automatic pause preserves one microphone/socket and streams context without manual turn commands',async t=>{
  const f=fixture(t),current=await f.connect({answerMode:'auto-switch'});await current.pending;
  assert.equal(f.session.interactionReady,true);assert.equal(f.session.listening,null);
  const pcm=()=>current.microphone.cb.onPcm(new Float32Array([.1,-.1]),24000);
  pcm();f.session.toggleInteraction();pcm();f.session.toggleInteraction();pcm();
  assert.equal(f.sockets.length,1);assert.equal(current.microphone.stops,0);
  assert.equal(f.session.running,true);assert.equal(f.session.awaitingFreshInput,true);
  assert.equal(current.socket.sent.filter(value=>typeof value!=='string').length,3);
  const messages=current.socket.sent.filter(value=>typeof value==='string').map(value=>JSON.parse(value));
  assert.equal(messages[0].answer_mode,'auto-switch');
  assert.deepEqual(messages.filter(value=>value.type==='interaction_control').map(({paused,revision})=>({paused,revision})),[{paused:true,revision:1},{paused:false,revision:2}]);
  assert.equal(messages.some(value=>/^listen_|^answer_|^response\.create$/.test(value.type)),false);
});

test('late microphone failure from an ended session cannot close its replacement',async t=>{
  const oldMic=deferred(),f=fixture(t,{microphoneStarts:[oldMic]});
  const first=await f.connect(),firstResult=first.pending.catch(error=>error);
  f.session.stop();const second=await f.connect();await second.pending;
  oldMic.reject(Error('old permission result'));await firstResult;
  assert.equal(f.session.running,true);
  assert.equal(second.socket.readyState,1);
  assert.equal(second.microphone.stops,0);
  assert.deepEqual(f.errors,[]);
});

test('late microphone success only releases its own capture, not the replacement',async t=>{
  const oldMic=deferred(),f=fixture(t,{microphoneStarts:[oldMic]});
  const first=await f.connect();f.session.stop();const second=await f.connect();await second.pending;
  oldMic.resolve();await first.pending;
  assert.equal(f.session.running,true);
  assert.equal(second.microphone.stops,0);
  assert.ok(first.microphone.stops>=1);
});

test('old socket and microphone callbacks cannot fail or update a new session',async t=>{
  const f=fixture(t),first=await f.connect();await first.pending;
  f.session.stop();const second=await f.connect();await second.pending;
  first.socket.onerror();first.microphone.cb.onError(Error('old capture ended'));first.microphone.cb.onLevel(.5);
  assert.equal(f.session.running,true);assert.equal(second.socket.readyState,1);
  assert.equal(second.microphone.stops,0);assert.deepEqual(f.errors,[]);assert.deepEqual(f.levels,[]);
  second.microphone.cb.onLevel(.2);assert.deepEqual(f.levels,[.2]);
});

test('reopening after speech_started clears the previous speaking gate',async t=>{
  const f=fixture(t),first=await f.connect();await first.pending;
  f.session.event({event:{type:'input_audio_buffer.speech_started'}});
  assert.equal(f.session.speechActive,true);f.session.stop();
  const second=await f.connect();await second.pending;
  assert.equal(f.session.speechActive,false);
  f.session.event({event:{type:'response.created',response:{id:'fresh-answer'}}});
  assert.equal(f.session.responses.get('fresh-answer').cancelled,false);
});

test('cancelled audio unlock cannot create a socket after a replacement connects',async t=>{
  const f=fixture(t),unlock=deferred();let calls=0;
  f.rt.audio.unlock=()=>++calls===1?unlock.promise:Promise.resolve();
  const first=f.session.start();f.session.stop();
  const second=await f.connect();await second.pending;
  unlock.resolve();await first;
  assert.equal(f.sockets.length,1);assert.equal(f.session.socket,second.socket);
  assert.equal(f.session.running,true);assert.equal(second.microphone.stops,0);
});

test('old picture work cannot block new tools or send results on the replacement socket',async t=>{
  const f=fixture(t),first=await f.connect();await first.pending;
  const picture=deferred();f.stage.apply=()=>picture.promise;
  f.session.event({event:{type:'response.created',response:{id:'old'}}});
  f.session.event({event:{type:'response.function_call_arguments.done',response_id:'old',call_id:'old-picture',name:'presentation',arguments:JSON.stringify({actions:[{type:'restore_view'}]})}});
  const oldWork=f.session.toolChain;await tick();
  f.session.stop();const second=await f.connect();await second.pending;
  f.session.event({event:{type:'response.created',response:{id:'new'}}});
  f.session.event({event:{type:'response.function_call_arguments.done',response_id:'new',call_id:'new-state',name:'presentation_state',arguments:'{}'}});
  await tick();
  const results=()=>second.socket.sent.map(value=>JSON.parse(value)).filter(value=>value.type==='tool_result');
  assert.equal(results().length,1);assert.equal(results()[0].call_id,'new-state');
  picture.resolve();await oldWork;
  assert.equal(results().length,1);assert.equal(f.session.running,true);
});

test('current microphone failure still stops and reports the active conversation',async t=>{
  const f=fixture(t),current=await f.connect();await current.pending;
  current.microphone.cb.onError(Error('active capture ended'));
  assert.equal(f.session.running,false);assert.equal(current.socket.readyState,3);
  assert.ok(current.microphone.stops>=1);assert.deepEqual(f.errors,['active capture ended']);
});

test('an unknown current response still receives a rejected tool result',async t=>{
  const f=fixture(t),current=await f.connect();await current.pending;
  f.session.event({event:{type:'response.function_call_arguments.done',response_id:'unknown',call_id:'unknown-tool',name:'presentation_state',arguments:'{}'}});
  await f.session.toolChain;
  const result=JSON.parse(current.socket.sent.at(-1));
  assert.equal(result.call_id,'unknown-tool');assert.equal(result.result.ok,false);assert.equal(result.continue,false);
  assert.equal(f.session.running,true);
});
