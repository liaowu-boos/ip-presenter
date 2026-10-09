import test from 'node:test';
import assert from 'node:assert/strict';
import {ManualListening} from '../frontend/src/manual-listening.js';
import {installAnswerControls} from '../frontend/src/stage-answer-controls.js';

test('continuous room audio commits speech with preroll, but silence neither commits nor grants answers',()=>{
 const events=[];let samples=0;const capture=new ManualListening({onStart:id=>events.push(['start',id]),onEnd:id=>events.push(['end',id]),onPcm:p=>samples+=p.length});
 const push=(v,n)=>{for(let i=0;i<n;i++)capture.push(new Float32Array(480).fill(v));};
 push(0,300);assert.deepEqual(events,[]);assert.equal(samples,0);assert.ok(capture.preSamples<=9600);
 push(.1,15);push(0,65);assert.deepEqual(events,[['start',1],['end',1]]);assert.ok(samples>=24000);
 push(.1,20);push(0,65);assert.deepEqual(events.slice(2),[['start',2],['end',2]]);
 assert.throws(()=>capture.push(new Float32Array(480),16000),/24 kHz/);
});

test('space grants once per press, leaves editing alone, and works without adding audience UI',()=>{
 const old=globalThis.document,buttons=Object.fromEntries(['answer','hold','resume'].map(k=>['[data-'+k+']',{}]));let listener,toggles=0;
 globalThis.document={createElement:()=>({querySelector:key=>buttons[key],remove(){}}),addEventListener:(kind,fn)=>listener=fn,removeEventListener(){}};
 try{
  const session={running:true,manualAnswers:true,cb:{},answerOnce(){toggles++;}};
  installAnswerControls({controls:{append(){}},session,runtime:{}});
  const ev={code:'Space',preventDefault(){},stopImmediatePropagation(){},target:{closest:()=>null}};
  listener(ev);listener({...ev,repeat:true});assert.equal(toggles,1);
  listener({...ev,target:{closest:()=>({})}});assert.equal(toggles,1);
  listener({...ev,ctrlKey:true});assert.equal(toggles,1);
  listener({...ev,target:{closest:selector=>selector.includes('button')?{}:null}});assert.equal(toggles,2);
  session.running=false;listener(ev);assert.equal(toggles,2);
 }finally{globalThis.document=old;}
});

test('long question flushes transport chunks without ending the logical question or granting early',()=>{
 const events=[];const capture=new ManualListening({onStart:id=>events.push(['start',id]),onEnd:id=>events.push(['end',id]),onChunk:id=>events.push(['chunk',id]),onPcm(){}});
 for(let i=0;i<1600;i++)capture.push(new Float32Array(480).fill(.1));
 assert.deepEqual(events,[['start',1],['chunk',1]]);
 for(let i=0;i<65;i++)capture.push(new Float32Array(480));
 assert.deepEqual(events,[['start',1],['chunk',1],['end',1]]);
});

test('operator submits immediately without waiting for 1200ms silence and next speech still records',()=>{
 const events=[];let samples=0;
 const capture=new ManualListening({onStart:id=>events.push(['start',id]),onEnd:id=>events.push(['end',id]),onPcm:p=>samples+=p.length});
 for(let i=0;i<30;i++)capture.push(new Float32Array(480).fill(.1));
 assert.equal(capture.submitNow(),true);
 assert.deepEqual(events,[['start',1],['end',1]]);assert.equal(samples,14400);
 assert.equal(capture.submitNow(),false);
 for(let i=0;i<10;i++)capture.push(new Float32Array(480));
 for(let i=0;i<30;i++)capture.push(new Float32Array(480).fill(.1));
 assert.deepEqual(events.at(-1),['start',2]);
 capture.submitNow();assert.deepEqual(events.at(-1),['end',2]);
});
