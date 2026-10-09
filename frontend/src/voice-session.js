import {ContinuousMicrophone,BrowserVoiceInput,recognitionVocabulary} from './voice-input.js?v=public-core-2';
import {VoiceDialogue} from './voice-dialogue.js?v=public-core-2';
/** Owns microphone lifetime and ordered transcription independently from cancelled answers. */
export class VoiceSession {
  constructor(runtime,{onState=()=>{},onEnabled=()=>{},onLevel=()=>{},onHeard=()=>{},online=()=>false}={}){
    this.rt=runtime;this.onState=onState;this.onLevel=onLevel;this.onHeard=onHeard;this.onEnabled=onEnabled;this.serial=0;this.running=false;
    this.dialogue=new VoiceDialogue(runtime,{onState,onStop:()=>this.stop(),online});
  }
  async start({engine='server',endMs=700,threshold=.006}={}){
    if(this.running)return;this.running=true;this.needsRepeat=false;this.empty=false;const serial=++this.serial;this.speaking=false;this.pending=0;this.texts=[];this.processing=false;this.asrChain=Promise.resolve();this.controllers=new Set();
    this.dialogue.start();this.onEnabled(true);this.onState('等待麦克风授权');
    const valid=()=>this.running&&serial===this.serial;
    const callbacks={endMs,threshold,onLevel:level=>{if(valid())this.onLevel(level);},
      onSpeechStart:()=>{if(valid()){this.speaking=true;this.dialogue.speechStart();this.rt.hearing?.(true);}},
      onSpeechEnd:()=>{if(valid()){this.speaking=false;this.rt.hearing?.(false);this.schedule();}},
      onTurn:(blob,info)=>{if(valid())this.transcribe(blob,info,serial);},
      onText:text=>{if(valid()){this.onHeard(text);this.texts.push(text);this.schedule();}},
      onUnclear:()=>{if(valid()){this.needsRepeat=true;this.schedule();}},
      onEmpty:()=>{if(valid()){this.empty=true;this.schedule();}},
      onReady:info=>{if(valid()){this.onState(engine==='server'?'持续聆听中':'浏览器识别中 · 试运行');this.rt.note('麦克风',info.browser?'浏览器识别引擎；可能使用浏览器厂商的在线服务。':`持续拾音：${info.device||'默认麦克风'}，${info.sampleRate||'未知'} Hz；回声消除${info.echoCancellation?'开启':'未确认'}。`);}},
      onError:error=>{if(valid()){this.stop();this.onState(error.message);this.rt.ui.toast(error.message,'error');}}
    };
    this.input=engine==='server'?new ContinuousMicrophone(callbacks):new BrowserVoiceInput(callbacks);
    try{await this.rt.audio.unlock();await this.input.start();}catch(error){if(valid()){this.stop();this.onState(error.message);throw error;}}
  }
  transcribe(blob,info,serial){
    if(this.pending>=4){this.needsRepeat=true;this.rt.note('语音','连续提问超过识别队列容量，将口头请求重说。');return;}
    // 以最后一段有声采样为起点，覆盖静音分段、识别和理解耗时。
    if(!this.pending&&!this.texts.length)this.dialogue.utteranceEndAt=performance.now()-(info.silenceMs||0);
    this.pending++;this.onState('正在识别，仍可继续说');
    this.asrChain=this.asrChain.then(async()=>{
      if(!this.running||serial!==this.serial)return;
      const controller=new AbortController();this.controllers.add(controller);const timer=setTimeout(()=>controller.abort(),10000);const started=performance.now();
      try{
        const response=await fetch('/api/transcribe',{method:'POST',headers:{'Content-Type':'audio/wav','X-IP-Presenter':'1','X-IP-ASR-Vocabulary':encodeURIComponent(JSON.stringify(recognitionVocabulary(this.rt.project)))},body:blob,signal:controller.signal});
        if(!response.ok)throw Error('语音识别服务不可用');const data=await response.json();
        if(!this.running||serial!==this.serial)return;
        this.rt.note('识别',`转写服务 ${Math.round(performance.now()-started)} ms，录音 ${Math.round(info.durationMs||0)} ms。`);
        if(data.empty){this.empty=true;}
        else if(info.truncated||!data.text?.trim()){this.needsRepeat=true;this.rt.note('语音','没有得到完整可靠的提问，将请求重说。');}
        else {const text=data.text.trim().slice(0,2000);this.onHeard(text);this.texts.push(text);}
      }catch(error){if(this.running&&serial===this.serial){this.needsRepeat=true;this.rt.note('语音','识别失败或超时，请检查服务。');}}
      finally{clearTimeout(timer);this.controllers.delete(controller);if(serial===this.serial){this.pending--;this.schedule();}}
    });
  }
  schedule(){clearTimeout(this.flushTimer);this.flushTimer=setTimeout(()=>this.flush(),80);}
  async flush(){
    if(!this.running||this.speaking||this.pending||this.processing)return;
    const serial=this.serial;this.processing=true;
    try{
      if(this.needsRepeat){this.needsRepeat=false;
        // 已听清的独立问题仍登记，未听清的片段不参与回答。
        const batch=this.texts.splice(0),turn=this.dialogue.turn;
        for(let i=0;i<batch.length;i++){const result=await this.dialogue.accept(batch[i],{defer:true});if(result==='retry'){this.texts.unshift(...batch.slice(i));this.needsRepeat=true;return;}}
        if(turn!==this.dialogue.turn||this.speaking){this.needsRepeat=true;return;}
        await this.dialogue.unclear();
      }else if(this.texts.length){const batch=this.texts.splice(0);const result=await this.dialogue.acceptBatch(batch);if(result==='retry')this.texts.unshift(...batch);else if(result?.retry)this.texts.unshift(...result.retry);}
      else if(this.empty){this.empty=false;await this.dialogue.resumeInterrupted();}
    }catch(error){if(serial===this.serial&&this.running){this.rt.cancel('error');this.rt.ui.toast(error.message,'error');this.onState('语音流程出错，已停止输出；仍在聆听');}}
    finally{if(serial===this.serial){this.processing=false;if(this.texts.length||this.needsRepeat)this.schedule();}}
  }
  stop(){this.rt.hearing?.(false);this.running=false;++this.serial;clearTimeout(this.flushTimer);this.input?.stop();for(const controller of this.controllers||[])controller.abort();this.texts=[];this.pending=0;this.empty=false;this.needsRepeat=false;this.dialogue.stop();this.onEnabled(false);}
}
