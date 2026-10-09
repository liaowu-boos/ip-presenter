import {SpeechGate} from './voice-input.js?v=public-core-2';

/** Segment all room speech, not speaker identities. Commits do not request replies. */
export class ManualListening {
 constructor({onStart,onEnd,onChunk=()=>{},onPcm,endMs=1200}){
  this.pre=[];this.preSamples=0;this.turn=0;this.send=onPcm;this.onEnd=onEnd;
  this.gate=new SpeechGate({endMs,onStart:()=>{onStart(++this.turn);for(const frame of this.pre)this.send(frame);this.pre=[];this.preSamples=0;},onEnd:info=>{
   if(info.truncated){this.gate.active=true;onChunk(this.turn);}else onEnd(this.turn);
  }});
 }
 submitNow(){
  if(!this.gate.active)return false;
  // Space is the operator's explicit end-of-question signal. Do not wait
  // for the acoustic silence timer (which room noise can keep resetting).
  this.gate.reset();this.pre=[];this.preSamples=0;this.onEnd(this.turn);return true;
 }
 push(samples,rate=24000){
  if(rate!==24000)throw Error('现场倾听需要 24 kHz 麦克风声音');
  let energy=0;for(const x of samples)energy+=x*x;
  if(this.gate.active)this.send(samples);
  else{this.pre.push(samples.slice());this.preSamples+=samples.length;while(this.preSamples>rate*.4&&this.pre.length>1)this.preSamples-=this.pre.shift().length;}
  this.gate.push(Math.sqrt(energy/samples.length),samples.length/rate*1000);
 }
}
