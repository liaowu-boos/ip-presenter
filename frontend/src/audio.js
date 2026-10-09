import {PcmPlaybackClock} from './pcm-playback-clock.js?v=public-core-2';
export const abortError=()=>new DOMException('已取消','AbortError');
// Broad spectral balance supplies a conservative rounded/wide tendency.
// It does not identify phonemes or infer mouth shapes from transcript timing.
export function acousticRoundness(spectrum,sampleRate,fftSize){
  let low=0,high=0;
  for(let i=1;i<spectrum.length;i++){
    const hz=i*sampleRate/fftSize,value=Number.isFinite(spectrum[i])?10**(spectrum[i]/10):0;
    if(hz>=200&&hz<900)low+=value;
    if(hz>=1400&&hz<3800)high+=value;
  }
  if(low+high<1e-8)return 0;
  return Math.max(0,Math.min(1,(low/(low+high)-.55)*2.5));
}
export function sleep(ms,signal){return new Promise((resolve,reject)=>{if(signal?.aborted)return reject(abortError());const end=()=>{signal?.removeEventListener('abort',cancel);resolve();};const id=setTimeout(end,ms);const cancel=()=>{clearTimeout(id);signal?.removeEventListener('abort',cancel);reject(abortError());};signal?.addEventListener('abort',cancel,{once:true});});}
/** Retain odd trailing bytes; network chunks are not aligned to PCM samples. */
export class PcmDecoder {
  constructor(){this.odd=null;}
  push(bytes){let input=bytes;if(this.odd!==null){input=new Uint8Array(bytes.length+1);input[0]=this.odd;input.set(bytes,1);this.odd=null;}const n=Math.floor(input.length/2);if(input.length%2)this.odd=input[input.length-1];const samples=new Float32Array(n),d=new DataView(input.buffer,input.byteOffset,n*2);for(let i=0;i<n;i++)samples[i]=d.getInt16(i*2,true)/32768;return samples;}
}
export class SpeechPlayer {
  constructor(onWarning=()=>{},onFrame=()=>{},onPcmPlayback=()=>{}){this.context=null;this.onWarning=onWarning;this.onFrame=onFrame;this.onPcmPlayback=onPcmPlayback;this.sources=new Set();this.serial=0;this.meterFrame=null;}
  pcmPlayback(event){
    // A rendering subscriber cannot interrupt the voice transport. PCM is a
    // private copy; neither the model nor a recorder may mutate sounding data.
    try{this.onPcmPlayback(event);}catch(error){this.onWarning(`口型数据接收失败：${error.message}`);}
  }
  async unlock(){if(!this.context){const C=window.AudioContext||window.webkitAudioContext;if(C)this.context=new C();}if(this.context?.state==='suspended')await this.context.resume();}
  finishMeter(){if(this.meterFrame!==null)clearTimeout(this.meterFrame);this.meterFrame=null;this.onFrame({active:false,level:0});}
  output(){if(!this.analyser){this.analyser=this.context.createAnalyser();this.analyser.fftSize=1024;this.analyser.smoothingTimeConstant=.35;this.samples=new Float32Array(this.analyser.fftSize);this.spectrum=new Float32Array(this.analyser.fftSize/2);this.analyser.connect(this.context.destination);}return this.analyser;}
  startMeter(serial,estimated=false){
    if(serial!==this.serial)return;
    const began=performance.now();
    // Timers also feed an audience window while the sounding controller is behind it.
    const tick=()=>{
      if(serial!==this.serial)return;
      const now=performance.now();let level=0,roundness=0;
        if(estimated){if(!this.systemPaused){const phase=(now-began)%270;level=phase>210?0:phase>95?.075:.025;}}
        else if(this.context.state==='running'){this.analyser.getFloatTimeDomainData(this.samples);let sum=0;for(const x of this.samples)sum+=x*x;level=Math.sqrt(sum/this.samples.length);}
        if(!estimated&&level>.007&&this.analyser.getFloatFrequencyData){
          this.analyser.getFloatFrequencyData(this.spectrum);
          roundness=acousticRoundness(this.spectrum,this.context.sampleRate,this.analyser.fftSize);
        }
        this.onFrame({active:true,level,roundness,mode:estimated?'estimated':'pcm',playbackId:serial,audioTime:estimated?null:this.context.currentTime});
      this.meterFrame=setTimeout(tick,33);
    };
    this.meterFrame=setTimeout(tick,0);
  }
  stop(){this.streamCancel?.();++this.serial;this.finishMeter();window.speechSynthesis?.cancel();for(const source of this.sources){try{source.stop();}catch{}}this.sources.clear();}
  openPcmStream({onStart=()=>{}}={}){
    this.stop();const serial=this.serial,ctx=this.context;
    if(!ctx||ctx.state!=='running')throw Error('声音播放尚未就绪，请重新开启语音会话。');
    const decoder=new PcmDecoder();let next=ctx.currentTime+.05,pending=0,inputDone=false,settled=false,started=false,startTimer,sampleOffset=0,released=0,preparation=null;
    const waiting=[],clock=new PcmPlaybackClock(ctx,serial);let sourceSamples=0,playbackError=null;
    let resolve,reject;const done=new Promise((ok,no)=>{resolve=ok;reject=no;});done.catch(()=>{});
    const finish=error=>{
      if(settled)return;settled=true;playbackError=error||null;clearTimeout(startTimer);clock.finish(error);
      try{preparation?.cancel?.({completed:!error});}catch{}waiting.length=0;
      if(error)for(const source of [...this.sources]){try{source.stop();}catch{}}
      if(this.streamCancel===cancel)this.streamCancel=null;
      this.pcmPlayback({type:error?'cancel':'ended',playbackId:serial,audioTime:ctx.currentTime});
      if(serial===this.serial)this.finishMeter();error?reject(error):resolve();
    };
    const cancel=()=>finish(abortError());this.streamCancel=cancel;
    const complete=()=>{if(inputDone&&released===sampleOffset&&pending===0)finish();};
    const schedule=(samples,offset,purpose='speech')=>{
      const buffer=ctx.createBuffer(1,samples.length,24000);buffer.copyToChannel(samples,0);
      const source=ctx.createBufferSource();source.buffer=buffer;source.connect(this.output());this.sources.add(source);pending++;
      next=Math.max(next,ctx.currentTime+.02);const when=next;next+=buffer.duration;
      source.onended=()=>{this.sources.delete(source);source.disconnect();clock.ended(offset+samples.length);pending--;complete();};
      if(!started){started=true;this.startMeter(serial);startTimer=setTimeout(()=>{if(!settled&&serial===this.serial)onStart();},Math.max(0,(when-ctx.currentTime)*1000));}
      source.start(when);clock.add(offset,samples.length,when);
      this.pcmPlayback({type:'chunk',playbackId:serial,sampleRate:24000,sampleOffset:offset,
        startTime:when,endTime:next,audioTime:ctx.currentTime,purpose,samples:samples.slice()});
    };
    const releaseThrough=until=>{
      if(settled||serial!==this.serial)return;
      if(!Number.isSafeInteger(until)||until<released||until>sampleOffset)throw Error('口型缓冲释放了无效的声音范围。');
      while(waiting.length&&released<until){
        const item=waiting[0],take=Math.min(item.samples.length,until-released);
        schedule(item.samples.subarray(0,take),released,item.purpose);released+=take;
        if(take===item.samples.length)waiting.shift();else item.samples=item.samples.subarray(take);
      }
      complete();
    };
    this.pcmPlayback({type:'begin',playbackId:serial,sampleRate:24000,audioTime:ctx.currentTime});
    try{preparation=this.pcmPreparation?.({playbackId:serial,context:ctx,releaseThrough,fail:finish})||null;}
    catch(error){finish(error);}
    return {done,cancel,playbackId:serial,
      playbackStatus:()=>({receivedSamples:sourceSamples,playedSamples:Math.min(sourceSamples,clock.position()),
        completed:settled&&!playbackError,cancelled:!!playbackError}),
      waitForPlayback:sampleCount=>{
        if(!Number.isSafeInteger(sampleCount)||sampleCount<0||sampleCount>sampleOffset)return Promise.reject(Error('图片动作请求了无效的声音位置。'));
        return clock.wait(sampleCount);
      },
      push:bytes=>{
        if(settled||inputDone||serial!==this.serial)return;
        const samples=decoder.push(bytes);if(!samples.length)return;
        // Omni may generate a minute of PCM in a few seconds. This is normal
        // look-ahead, not a network timeout. Bound all unplayed PCM (~11.5 MB
        // float samples) while keeping playback and interruption immediate.
        if(sampleOffset-clock.position()+samples.length>24000*120){finish(Error('未播放声音超过两分钟的缓存上限，已停止这一轮。'));return;}
        if(sampleOffset-released+samples.length>24000*30){finish(Error('口型等待声音超过30秒，已停止这一轮。'));return;}
        const offset=sampleOffset;sampleOffset+=samples.length;sourceSamples=sampleOffset;waiting.push({samples});
        try{if(preparation)preparation.push(samples.slice(),offset);else releaseThrough(sampleOffset);}
        catch(error){finish(error);}
      },
      finish:()=>{
        if(settled||inputDone)return;
        if(decoder.odd!==null){finish(Error('千问音频不完整，已停止这一轮。'));return;}
        let tailSamples=0,appending=true;
        try{
          preparation?.finish?.({appendSilence:count=>{
            if(!appending||tailSamples||settled||!Number.isSafeInteger(count)||count<=0||count>12000)throw Error('无效的闭嘴静音尾部');
            const samples=new Float32Array(count),offset=sampleOffset;tailSamples=count;sampleOffset+=count;
            waiting.push({samples,purpose:'closure'});preparation.push(samples.slice(),offset);
          }});
          inputDone=true;this.pcmPlayback({type:'input-ended',playbackId:serial,sampleCount:sourceSamples,playbackSampleCount:sampleOffset,
            closureTailSamples:tailSamples,audioTime:ctx.currentTime,endTime:released===sampleOffset?next:null,pendingSamples:sampleOffset-released});
          complete();
        }catch(error){finish(error);}finally{appending=false;}
      }
    };
  }
  async play(text,options){
    if(options.signal.aborted)throw abortError();
    if(options.mode==='qwen'){
      if(!this.realtimeSpeak)throw Error('请先开启千问语音会话，再开始汇报。');
      return this.realtimeSpeak(text,options);
    }
    const serial=++this.serial;this.finishMeter();
    try{
      if(options.mode==='cloud')return await this.cloud(text,{...options,serial});
      if(options.mode==='silent'||!window.speechSynthesis){options.onCaption?.();await sleep(Math.min(10000,Math.max(1100,text.length*65)),options.signal);return;}
      return await this.system(text,{...options,serial});
    }finally{if(serial===this.serial)this.finishMeter();}
  }
  system(text,{signal,onStart,onCaption,voice,serial}){
    return new Promise((resolve,reject)=>{
      if(signal.aborted)return reject(abortError());
      const u=new SpeechSynthesisUtterance(text);u.lang='zh-CN';u.rate=1;const selected=speechSynthesis.getVoices().find(v=>v.voiceURI===voice)||speechSynthesis.getVoices().find(v=>/^zh/.test(v.lang));if(selected)u.voice=selected;
      let settled=false,started=false;let watchdog;
      const finish=(err)=>{if(settled)return;settled=true;clearTimeout(watchdog);signal.removeEventListener('abort',cancel);err?reject(err):resolve();};
      const cancel=()=>{if(serial===this.serial)speechSynthesis.cancel();finish(abortError());};signal.addEventListener('abort',cancel,{once:true});
      u.onstart=()=>{if(signal.aborted||serial!==this.serial)return cancel();started=true;this.systemPaused=false;this.startMeter(serial,true);onStart?.();};u.onpause=()=>{if(serial!==this.serial)return;this.systemPaused=true;this.onFrame({active:false,level:0});};u.onresume=()=>{if(serial===this.serial)this.systemPaused=false;};u.onend=()=>finish();u.onerror=e=>finish(e.error==='canceled'||e.error==='interrupted'?abortError():new Error(`系统试音失败：${e.error}。可在设置中改用字幕预览。`));
      watchdog=setTimeout(()=>{if(serial===this.serial)speechSynthesis.cancel();finish(new Error(started?'系统语音未报告结束，请切换字幕预览或重新试音。':'浏览器没有开始播放声音。请检查系统声音，或在设置中选择字幕预览。'));},Math.min(70000,Math.max(12000,text.length*350)));
      speechSynthesis.speak(u);
    });
  }
  async cloud(text,{signal,onStart,serial}){
    await this.unlock();const ctx=this.context;if(!ctx||ctx.state!=='running')throw Error('音频尚未解锁，请先点击“试音”或重新点击开始。');
    const response=await fetch('/api/tts',{method:'POST',headers:{'Content-Type':'application/json','X-IP-Presenter':'1'},body:JSON.stringify({text}),signal});
    if(!response.ok)throw Error((await response.json().catch(()=>null))?.detail||`语音服务错误 ${response.status}`);
    if(!response.headers.get('content-type')?.includes('audio/pcm'))throw Error('语音服务没有返回约定的PCM格式。');
    const reader=response.body.getReader(),decoder=new PcmDecoder();let next=ctx.currentTime+.065,first=true,total=0;const ended=[];const startTimers=[];
    const cancel=()=>{for(const id of startTimers)clearTimeout(id);if(serial===this.serial)this.stop();reader.cancel().catch(()=>{});};signal.addEventListener('abort',cancel,{once:true});
    try{
      while(true){if(signal.aborted)throw abortError();const {value,done}=await reader.read();if(done)break;const samples=decoder.push(value);if(!samples.length)continue;total+=samples.length;const b=ctx.createBuffer(1,samples.length,24000);b.copyToChannel(samples,0);const source=ctx.createBufferSource();source.buffer=b;source.connect(this.output());this.sources.add(source);next=Math.max(next,ctx.currentTime+.025);const when=next;next+=b.duration;
        ended.push(new Promise(resolve=>{source.onended=()=>{this.sources.delete(source);source.disconnect();resolve();};}));
        if(first){first=false;this.startMeter(serial);startTimers.push(setTimeout(()=>{if(!signal.aborted&&serial===this.serial)onStart?.();},Math.max(0,(when-ctx.currentTime)*1000)));}source.start(when);
      }
      if(signal.aborted)throw abortError();if(!total)throw Error('语音服务返回了空音频。');if(decoder.odd!==null)throw Error('PCM数据被截断。');
      await Promise.all(ended);if(signal.aborted)throw abortError();
    }catch(e){cancel();throw e;}finally{signal.removeEventListener('abort',cancel);reader.releaseLock();}
  }
}
/** Click-to-record; deliberately NOT continuous listening / full-duplex recognition. */
export class Recorder {
  constructor(){this.recorder=null;this.stream=null;this.timer=null;this.token=0;}
  async start(onStopped){
    if(!navigator.mediaDevices?.getUserMedia||!window.MediaRecorder)throw Error('当前浏览器或打开方式不支持录音。请从本地服务打开，或先用文字提问。');
    const token=++this.token;const stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false});
    if(token!==this.token){stream.getTracks().forEach(t=>t.stop());return;}
    this.stream=stream;const type=['audio/webm;codecs=opus','audio/mp4','audio/ogg;codecs=opus'].find(t=>MediaRecorder.isTypeSupported(t));const recorder=new MediaRecorder(stream,type?{mimeType:type}:{});this.recorder=recorder;const chunks=[];
    recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};recorder.onstop=()=>{clearTimeout(this.timer);stream.getTracks().forEach(t=>t.stop());this.recorder=null;this.stream=null;if(token===this.token&&chunks.length)onStopped(new Blob(chunks,{type:recorder.mimeType}));};
    recorder.start(250);this.timer=setTimeout(()=>this.stop(),45000);
  }
  stop(){if(this.recorder?.state==='recording')this.recorder.stop();}
  cancel(){++this.token;clearTimeout(this.timer);this.stop();this.stream?.getTracks().forEach(t=>t.stop());this.stream=null;}
}
export async function* events(response){
  if(!response.ok){const info=await response.json().catch(()=>({}));throw Error(info.detail||`服务错误 ${response.status}`);}
  const reader=response.body.getReader(),decoder=new TextDecoder();let buf='';
  try{while(true){const {done,value}=await reader.read();buf+=done?decoder.decode():decoder.decode(value,{stream:true});buf=buf.replace(/\r\n/g,'\n');let end;while((end=buf.indexOf('\n\n'))>=0){const block=buf.slice(0,end);buf=buf.slice(end+2);const data=block.split('\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');if(data)yield JSON.parse(data);}if(done)break;if(buf.length>200000)throw Error('服务事件超过长度限制。');}}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
