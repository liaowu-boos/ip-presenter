import test from 'node:test';
import assert from 'node:assert/strict';
import {VoiceSession} from '../frontend/src/voice-session.js';
const tick=()=>new Promise(r=>setTimeout(r,5));
function session(){
 const rt={voiceMode:false,cancel(){},note(){},ui:{toast(){}}};
 const s=new VoiceSession(rt);s.running=true;s.serial=1;s.pending=0;s.asrChain=Promise.resolve();s.controllers=new Set();s.texts=[];s.speaking=false;s.processing=false;s.needsRepeat=false;s.dialogue.enabled=true;
 s.schedule=()=>{};return s;
}
test('transcription jobs preserve arrival order while allowing continued capture',async()=>{
 const s=session(),old=globalThis.fetch;const releases=[];
 globalThis.fetch=()=>new Promise(r=>releases.push(r));
 try{s.transcribe(new Blob(['audio']),{},1);s.transcribe(new Blob(['audio']),{},1);await tick();assert.equal(releases.length,1);assert.equal(s.pending,2);
 releases[0](new Response(JSON.stringify({text:'第一问'})));await tick();assert.equal(releases.length,2);releases[1](new Response(JSON.stringify({text:'第二问'})));await s.asrChain;assert.deepEqual(s.texts,['第一问','第二问']);assert.equal(s.pending,0);
 }finally{s.stop();globalThis.fetch=old;}
});
test('stopped session drops late transcription and never restarts speech',async()=>{
 const s=session(),old=globalThis.fetch;let release;globalThis.fetch=()=>new Promise(r=>release=r);
 try{s.transcribe(new Blob(['audio']),{},1);await tick();s.stop();release(new Response(JSON.stringify({text:'过期'})));await s.asrChain;assert.deepEqual(s.texts,[]);assert.equal(s.running,false);assert.equal(s.pending,0);}finally{globalThis.fetch=old;}
});
test('flush waits for the next speaker and all pending recognition jobs',async()=>{
 const s=session();let calls=0;s.dialogue.acceptBatch=async()=>calls++;s.texts=['问题'];s.pending=1;await s.flush();assert.equal(calls,0);s.pending=0;s.speaking=true;await s.flush();assert.equal(calls,0);s.speaking=false;await s.flush();assert.equal(calls,1);s.stop();
});
test('interrupted semantic routing requeues the transcript instead of losing the question',async()=>{
 const s=session();s.texts=['未处理问题'];s.dialogue.acceptBatch=async()=>'retry';await s.flush();assert.deepEqual(s.texts,['未处理问题']);s.stop();
});
test('failed recognition asks for restatement rather than making up a question',async()=>{
 const s=session(),old=globalThis.fetch;let prompted=0;globalThis.fetch=async()=>new Response('{}',{status:502});s.dialogue.unclear=async()=>prompted++;
 try{s.transcribe(new Blob(['audio']),{},1);await s.asrChain;assert.equal(s.needsRepeat,true);await s.flush();assert.equal(prompted,1);assert.deepEqual(s.texts,[]);}finally{s.stop();globalThis.fetch=old;}
});
test('empty audio resumes listening without asking the user to repeat, vocabulary is forwarded',async()=>{
 const s=session(),old=globalThis.fetch;let resumed=0,request;s.rt.project={slides:[{regions:[{name:'示例图表'}]}]};s.dialogue.resumeInterrupted=async()=>resumed++;
 globalThis.fetch=async(url,options)=>{request=options;return new Response(JSON.stringify({text:'',empty:true}));};
 try{s.transcribe(new Blob(['audio']),{durationMs:800,silenceMs:700},1);await s.asrChain;await s.flush();
 assert.equal(s.needsRepeat,false);assert.equal(resumed,1);assert.equal(s.running,true);assert.deepEqual(s.texts,[]);
 assert.ok(JSON.parse(decodeURIComponent(request.headers['X-IP-ASR-Vocabulary'])).includes('示例图表'));
 }finally{s.stop();globalThis.fetch=old;}
});
