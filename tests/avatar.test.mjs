import test from 'node:test';
import assert from 'node:assert/strict';
import {MouthMotion,Avatar} from '../frontend/src/avatar.js';
import {SpeechPlayer} from '../frontend/src/audio.js';
import {validateProject} from '../frontend/src/core.js';
import {installDemoAvatar} from '../frontend/src/demo-avatar.js';

const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('mouth opens with output energy and closes during silence even if the stream remains active',()=>{
  const m=new MouthMotion();
  assert.equal(m.update({active:true,level:0},100),0);
  assert.equal(m.update({active:true,level:.03},200),1);
  assert.equal(m.update({active:true,level:.12},300),2);
  m.update({active:true,level:0},340);
  assert.equal(m.update({active:true,level:0},400),0);
  assert.equal(m.update({active:true,level:.003},600),0);
});

test('interruption closes the mouth immediately without waiting for the smoothing delay',()=>{
  const m=new MouthMotion();m.update({active:true,level:.15},100);
  assert.equal(m.mouth,2);
  assert.equal(m.update({active:false,level:.15},101),0);
  assert.equal(m.update({active:true,level:NaN},102),0);
});

test('voice end and takeover return the portrait from listening to idle',()=>{
  const el={innerHTML:'',dataset:{}};const old=globalThis.window;
  globalThis.window={matchMedia:()=>({matches:false})};
  try{
    const a=new Avatar(el);a.setStatus('thinking');a.setHearing(true);
    assert.equal(el.dataset.pose,'listening');a.setHearing(false);
    assert.equal(el.dataset.pose,'thinking');a.setStatus('takeover');
    assert.equal(el.dataset.pose,'idle');a.destroy();assert.equal(el.dataset.mouth,'0');
  }finally{globalThis.window=old;}
});

test('PCM metering reads the speaker signal, closes on suspended audio, and ignores a late timer after stop',t=>{
  const pending=new Map();let seq=0,level=.07;const frames=[];
  t.mock.method(globalThis,'setTimeout',fn=>{pending.set(++seq,fn);return seq;});
  t.mock.method(globalThis,'clearTimeout',id=>pending.delete(id));
  const old=globalThis.window;globalThis.window={};
  try{
    const p=new SpeechPlayer(()=>{},f=>frames.push(f));
    p.context={state:'running'};p.samples=new Float32Array(1024);
    p.analyser={getFloatTimeDomainData(samples){samples.fill(level);}};
    p.startMeter(p.serial);
    const run=()=>{const [id,fn]=pending.entries().next().value;pending.delete(id);fn();};
    run();assert.ok(Math.abs(frames.at(-1).level-.07)<.00001);assert.equal(frames.at(-1).mode,'pcm');
    level=0;run();assert.equal(frames.at(-1).level,0);
    level=.1;p.context.state='suspended';run();assert.equal(frames.at(-1).level,0);
    const stale=pending.values().next().value;p.stop();const length=frames.length;
    assert.deepEqual(frames.at(-1),{active:false,level:0});stale();
    assert.equal(frames.length,length);assert.equal(pending.size,0);
  }finally{globalThis.window=old;}
});

test('late completion of an aborted PCM stream cannot cancel the next answer',async t=>{
  const old=globalThis.window;globalThis.window={};let releaseRead;
  const reader={read:()=>new Promise(resolve=>releaseRead=resolve),cancel:async()=>{},releaseLock(){}};
  t.mock.method(globalThis,'fetch',async()=>({ok:true,headers:new Headers({'content-type':'audio/pcm'}),body:{getReader:()=>reader}}));
  const p=new SpeechPlayer();p.context={state:'running',currentTime:0};p.unlock=async()=>{};
  const controller=new AbortController();let stopped=0;
  try{
    const first=p.play('旧回答',{mode:'cloud',signal:controller.signal}).catch(e=>e);
    await tick();assert.equal(typeof releaseRead,'function');controller.abort();
    const next=++p.serial;p.sources.add({stop(){stopped++;}});
    releaseRead({done:true});const error=await first;
    assert.equal(error.name,'AbortError');assert.equal(p.serial,next);assert.equal(stopped,0);
  }finally{p.stop();globalThis.window=old;}
});

test('late system speech callbacks do not reset a newer answer or start old mouth motion',async t=>{
  const old={window:globalThis.window,speech:globalThis.speechSynthesis,utterance:globalThis.SpeechSynthesisUtterance};
  const utterances=[];let cancellations=0;const frames=[];
  const speech={getVoices:()=>[],cancel:()=>cancellations++,speak:u=>utterances.push(u)};
  globalThis.window={speechSynthesis:speech};globalThis.speechSynthesis=speech;globalThis.SpeechSynthesisUtterance=class{constructor(text){this.text=text;}};
  const p=new SpeechPlayer(()=>{},f=>frames.push(f)),a=new AbortController(),b=new AbortController();
  try{
    const first=p.play('旧',{mode:'system',signal:a.signal}).catch(e=>e);a.abort();await first;
    const second=p.play('新',{mode:'system',signal:b.signal}).catch(e=>e);
    const length=frames.length,cancels=cancellations;
    utterances[0].onstart();utterances[0].onpause();utterances[0].onend();
    assert.equal(frames.length,length);assert.equal(cancellations,cancels);
    b.abort();await second;
  }finally{p.stop();globalThis.window=old.window;globalThis.speechSynthesis=old.speech;globalThis.SpeechSynthesisUtterance=old.utterance;}
});

function project(){return {version:'0.1',name:'portable',avatar:'',character:{x:.83,y:.55,scale:1},background:{kind:'midnight',color:'#101513',image:''},slides:[{id:'one',src:'data:image/png;base64,AAAA',title:'test',script:'test',regions:[]}],knowledge:[]};}

test('export and import retain both the approved reference and independent animation atlas',()=>{
  const original=installDemoAvatar(project());const copy=validateProject(JSON.parse(JSON.stringify(original)));
  assert.equal(copy.avatarSelection,'demo-v1');assert.equal(copy.avatar,original.avatar);
  assert.equal(copy.avatarRig.atlas,original.avatarRig.atlas);
  assert.ok(copy.avatarRig.atlas.startsWith('data:image/png;base64,'));
  assert.notEqual(copy.avatar,copy.avatarRig.atlas);
});

test('an imported rig cannot fetch external pictures or detach from its source portrait',()=>{
  const p=project();p.avatar='data:image/png;base64,AAAA';p.avatarRig={id:'demo-v1',atlas:'https://example.com/avatar.png'};
  assert.throws(()=>validateProject(p),/动作素材/);
  p.avatarRig.atlas=p.avatar;p.avatar='';assert.throws(()=>validateProject(p),/动作素材/);
  delete p.avatarRig;assert.equal(validateProject(p),p);
});
