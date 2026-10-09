/** Energy-based turn gate. This detects activity/silence, NOT speaker identities or overlap. */
export class SpeechGate {
  constructor({startMs=100,endMs=700,minMs=120,maxMs=30000,threshold=.006,onStart=()=>{},onEnd=()=>{}}={}){
    Object.assign(this,{startMs,endMs,minMs,maxMs,threshold,onStart,onEnd});this.reset();
  }
  reset(){this.active=false;this.hot=0;this.quiet=0;this.elapsed=0;this.voiced=0;this.noise=.002;}
  push(rms,ms=20){
    const loud=rms>Math.max(this.threshold,this.noise*3);
    if(!this.active){
      if(!loud)this.noise=.98*this.noise+.02*Math.min(rms,this.threshold);
      this.hot=loud?this.hot+ms:Math.max(0,this.hot-ms*2);
      if(this.hot>=this.startMs){this.active=true;this.elapsed=this.hot;this.voiced=this.hot;this.quiet=0;this.onStart();}
      return;
    }
    this.elapsed+=ms;if(loud){this.voiced+=ms;this.quiet=0;}else this.quiet+=ms;
    if(this.quiet>=this.endMs||this.elapsed>=this.maxMs){
      const info={valid:this.voiced>=this.minMs,truncated:this.elapsed>=this.maxMs,durationMs:this.elapsed,silenceMs:this.quiet};
      this.reset();this.onEnd(info);
    }
  }
}
/** Encode mono PCM as a bounded WAV accepted by the existing transcription endpoint. */
export function pcmWave(frames,sampleRate){
  const length=frames.reduce((sum,x)=>sum+x.length,0),buffer=new ArrayBuffer(44+length*2),view=new DataView(buffer);
  const str=(offset,text)=>[...text].forEach((c,i)=>view.setUint8(offset+i,c.charCodeAt(0)));
  str(0,'RIFF');view.setUint32(4,36+length*2,true);str(8,'WAVE');str(12,'fmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,sampleRate,true);view.setUint32(28,sampleRate*2,true);view.setUint16(32,2,true);view.setUint16(34,16,true);str(36,'data');view.setUint32(40,length*2,true);
  let at=44;for(const frame of frames)for(const x of frame){view.setInt16(at,Math.round(Math.max(-1,Math.min(1,x))*(x<0?32768:32767)),true);at+=2;}
  return new Blob([buffer],{type:'audio/wav'});
}
const CAPTURE_WORKLET=`class VoiceCapture extends AudioWorkletProcessor {
 constructor(){super();this.frame=new Float32Array(Math.round(sampleRate*.02));this.at=0;}
 process(inputs){const input=inputs[0]?.[0];if(input)for(const value of input){this.frame[this.at++]=value;if(this.at===this.frame.length){this.port.postMessage(this.frame,[this.frame.buffer]);this.frame=new Float32Array(Math.round(sampleRate*.02));this.at=0;}}return true;}
}registerProcessor('ip-voice-capture',VoiceCapture);`;
/** One permission request per session; no per-question record/submit button. */
export class ContinuousMicrophone {
  constructor(callbacks={}){this.cb=callbacks;this.running=false;this.token=0;this.frames=[];this.pre=[];}
  async start(){
    if(this.running)return;this.running=true;const token=++this.token;
    try{
      if(!navigator.mediaDevices?.getUserMedia)throw Error('当前浏览器不支持麦克风，请用 Chrome 打开本地服务。');
      let stream;
      try{stream=await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false});}
      catch(error){
        if(/permission denied by system/i.test(error.message||'')){
          const guidance=/Mac/i.test(navigator.platform||'')
            ?'请在“系统设置 → 隐私与安全 → 麦克风”中开启当前应用：ChatGPT 内置浏览器对应 ChatGPT，Chrome 对应 Google Chrome。若系统提示重启应用，请重启后再开启语音会话。'
            :'请在系统隐私设置中允许当前浏览器使用麦克风，再重新开启语音会话。';
          throw new Error('系统阻止了麦克风访问；网页里点击允许还不够。'+guidance,{cause:error});
        }
        if(error.name==='NotAllowedError')throw new Error('麦克风访问未获允许。请检查网页的麦克风权限，以及系统设置中当前浏览器所在应用的麦克风权限，再开启语音会话。',{cause:error});
        throw error;
      }
      if(!this.running||token!==this.token){stream.getTracks().forEach(t=>t.stop());return;}
      this.stream=stream;const C=window.AudioContext||window.webkitAudioContext;this.context=new C(this.cb.sampleRate?{sampleRate:this.cb.sampleRate}:undefined);await this.context.resume();
      const url=URL.createObjectURL(new Blob([CAPTURE_WORKLET],{type:'application/javascript'}));
      try{await this.context.audioWorklet.addModule(url);}finally{URL.revokeObjectURL(url);}
      if(!this.running||token!==this.token)return;
      this.pre=[];this.frames=[];
      this.gate=new SpeechGate({endMs:this.cb.endMs||700,threshold:this.cb.threshold||.006,
        onStart:()=>{this.frames=this.pre.slice();this.cb.onSpeechStart?.();},
        onEnd:info=>{const frames=this.frames;this.frames=[];this.pre=[];this.cb.onSpeechEnd?.();if(info.valid)this.cb.onTurn?.(pcmWave(frames,this.context.sampleRate),info);else this.cb.onEmpty?.();}});
      this.source=this.context.createMediaStreamSource(stream);this.node=new AudioWorkletNode(this.context,'ip-voice-capture');this.mute=this.context.createGain();this.mute.gain.value=0;
      this.source.connect(this.node);this.node.connect(this.mute);this.mute.connect(this.context.destination);
      this.node.port.onmessage=({data})=>{
        if(!this.running||token!==this.token)return;
        let sum=0;for(const x of data)sum+=x*x;const rms=Math.sqrt(sum/data.length);
        this.cb.onLevel?.(rms);
        if(this.cb.onPcm){this.cb.onPcm(data,this.context.sampleRate);return;}
        const wasActive=this.gate.active;
        if(wasActive)this.frames.push(data);else{this.pre.push(data);if(this.pre.length>20)this.pre.shift();}
        this.gate.push(rms,data.length/this.context.sampleRate*1000);
      };
      stream.getAudioTracks()[0].onended=()=>{if(this.running){this.stop();this.cb.onError?.(Error('麦克风连接已断开，请重新启动语音会话。'));}};
      const track=stream.getAudioTracks()[0],settings=track.getSettings();this.cb.onReady?.({echoCancellation:settings.echoCancellation===true,device:track.label,sampleRate:settings.sampleRate||this.context.sampleRate});
    }catch(error){if(token===this.token){this.stop();throw error;}}
  }
  stop(){this.running=false;++this.token;this.node?.disconnect();this.source?.disconnect();this.mute?.disconnect();this.stream?.getTracks().forEach(t=>t.stop());this.context?.close().catch(()=>{});this.frames=[];this.pre=[];}
}
/** Optional browser engine. Availability/network/privacy depend on the browser, not the backend. */
export class BrowserVoiceInput {
  constructor(cb={}){this.cb=cb;this.running=false;this.final='';this.partial='';this.failures=0;this.activity=false;}
  async start(){
    const C=window.SpeechRecognition||window.webkitSpeechRecognition;if(!C)throw Error('当前浏览器没有语音识别引擎。请配置后端识别服务，或在 Chrome 中尝试。');
    this.running=true;this.recognition=new C();const r=this.recognition;r.lang='zh-CN';r.continuous=true;r.interimResults=true;
    const begin=()=>{clearTimeout(this.flushTimer);if(!this.activity){this.activity=true;this.cb.onSpeechStart?.();}};
    r.onspeechstart=begin;
    r.onresult=e=>{if(!this.running)return;this.failures=0;begin();this.partial='';for(let i=e.resultIndex;i<e.results.length;i++){const text=e.results[i][0].transcript;if(e.results[i].isFinal)this.final+=text;else this.partial+=text;}this.cb.onPartial?.(this.final+this.partial);this.schedule();};
    r.onspeechend=()=>this.schedule();
    r.onerror=e=>{if(!this.running)return;if(e.error==='no-speech')return;this.failures++;if(['not-allowed','service-not-allowed','audio-capture'].includes(e.error)||this.failures>=3){this.stop();this.cb.onError?.(Error('浏览器语音识别不可用：'+e.error+'。可配置后端识别服务后重试。'));}};
    r.onend=()=>{if(!this.running)return;this.schedule();this.restart=setTimeout(()=>{if(this.running)try{r.start();}catch{this.stop();this.cb.onError?.(Error('语音识别重连失败，请重新启动会话。'));}},300);};
    r.onstart=()=>this.cb.onReady?.({browser:true});r.start();
  }
  schedule(){clearTimeout(this.flushTimer);this.flushTimer=setTimeout(()=>{if(!this.running)return;const text=this.final.trim(),uncertain=this.partial.trim();this.final='';this.partial='';this.activity=false;this.cb.onSpeechEnd?.();if(text&&!uncertain)this.cb.onText?.(text);else if(text||uncertain)this.cb.onUnclear?.();else this.cb.onEmpty?.();},this.cb.endMs||1200);}
  stop(){this.running=false;clearTimeout(this.flushTimer);clearTimeout(this.restart);this.recognition?.abort();this.final='';this.partial='';this.activity=false;}
}

/** Short project nouns help ASR spell names; no lecture, answers, or personal history. */
export function recognitionVocabulary(project){
  const words=['开始汇报','继续汇报','暂停','放大','缩小','下一页','上一页','数据图表','标题',
    ...(project?.slides||[]).flatMap(s=>(s.regions||[]).map(r=>r.name))];
  return [...new Set(words)].filter(w=>typeof w==='string'&&/^[\p{L}\p{N}· -]{1,24}$/u.test(w)).slice(0,40);
}
