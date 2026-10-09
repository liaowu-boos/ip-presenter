import {clone,modelContext,validateActions} from './core.js?v=public-core-2';
import {abortError} from './audio.js?v=public-core-2';
import {ContinuousMicrophone} from './voice-input.js?v=public-core-2';
import {ManualListening} from './manual-listening.js?v=public-core-2';

export function pcm16(samples){
  const bytes=new Uint8Array(samples.length*2),view=new DataView(bytes.buffer);
  for(let i=0;i<samples.length;i++){const x=Math.max(-1,Math.min(1,samples[i]));view.setInt16(i*2,Math.round(x*(x<0?32768:32767)),true);}
  return bytes;
}

function audioBytes(encoded){
  if(typeof encoded!=='string'||encoded.length>4*1024*1024)throw Error('收到的声音数据无效。');
  const raw=atob(encoded),bytes=new Uint8Array(raw.length);for(let i=0;i<raw.length;i++)bytes[i]=raw.charCodeAt(i);return bytes;
}

/** Tools are data, never executable code. All IDs and limits are checked locally. */
export function validateTool(name,args,project){
  if(!args||typeof args!=='object'||Array.isArray(args))throw Error('动作参数无效。');
  const fields={presentation:['actions'],performer_gesture:['kind'],lecture:['operation'],question:['operation','text','id'],presentation_state:[]}[name];
  if(!fields||Object.keys(args).some(key=>!fields.includes(key)))throw Error('不支持的动作。');
  if(name==='presentation'){
    if(!Array.isArray(args.actions)||!args.actions.length||args.actions.length>4)throw Error('图片动作数量无效。');
    if(args.actions.some(a=>!a||Object.keys(a).some(k=>!['type','imageId','regionId','imageIds','factor','dx','dy','slot'].includes(k))))throw Error('图片动作含有不支持的字段。');
    validateActions(args.actions,project);
  }else if(name==='performer_gesture'){
    if(!['explain','smile','laugh','shy','sad','angry'].includes(args.kind))throw Error('人物动作无效。');
  }else if(name==='lecture'){
    if(!['start','resume','pause','takeover','stop_session'].includes(args.operation))throw Error('主讲控制无效。');
  }else if(name==='question'){
    if(!['new','select','update','skip','repeat'].includes(args.operation))throw Error('问题操作无效。');
    if(['new','update'].includes(args.operation)&&(typeof args.text!=='string'||!args.text.trim()||args.text.length>2000))throw Error('问题内容无效。');
    if(['select','update','skip'].includes(args.operation)&&(!Number.isSafeInteger(args.id)||args.id<1))throw Error('问题编号无效。');
  }
  return args;
}

export class QwenSession {
  constructor(runtime,callbacks={},dependencies={}){
    this.rt=runtime;this.cb=callbacks;this.Socket=dependencies.Socket||globalThis.WebSocket;
    this.Microphone=dependencies.Microphone||ContinuousMicrophone;
    this.narrationTimeoutMs=dependencies.narrationTimeoutMs??45000;
    this.running=false;this.token=0;this.speechActive=false;this.dialogue={awaiting:null};this.responses=new Map();this.handledCalls=new Set();this.narrations=new Map();this.toolChain=Promise.resolve();
  }
  state(text){this.cb.onState?.(text);}
  send(message){if(this.socket?.readyState===1)this.socket.send(JSON.stringify(message));}
  presentationState(){return {capabilities:clone(this.rt.stage.capabilities||{comparison:'side-by-side'}),view:clone(this.rt.view),bookmark:clone(this.rt.bookmark),main:this.rt.main,position:clone(this.rt.position),human_control:this.rt.humanControl,
    active_question:this.rt.activeQuestionId,questions:this.rt.questions.slice(-30).map(q=>({id:q.id,text:q.text,status:q.status,heard:q.delivered.join('')}))};}
  async start({endMs=700,answerMode='auto'}={}){
    if(this.running)return;
    this.running=true;const token=++this.token;
    this.manualAnswers=answerMode==='manual';this.floorTurn=0;this.floorPermit=null;this.floorStatus='listening';this.listening=null;
    this.switchAnswers=answerMode==='auto-switch';this.interactionPaused=false;this.interactionRevision=0;this.interactionReady=false;this.awaitingFreshInput=this.switchAnswers;
    this.rt.humanControl=this.manualAnswers;
    this.speechActive=false;this.lastTurnEnd=null;this.toolChain=Promise.resolve();
    this.cb.onEnabled?.(true);this.state('正在连接千问…');
    this.rt.cancel('preparing');this.previousSettings={...this.rt.settings};
    this.rt.onCancel=()=>this.interrupt();this.rt.voiceMode=true;
    this.rt.settings.mode='qwen';this.rt.settings.audio='qwen';
    this.rt.audio.realtimeSpeak=(text,options)=>this.narrate(text,options);
    try{
      await this.rt.audio.unlock();
      if(!this.running||token!==this.token)return;
      const url=new URL('/api/qwen/realtime',location.href);url.protocol=location.protocol==='https:'?'wss:':'ws:';
      const socket=this.socket=new this.Socket(url.href);
      await new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>reject(Error('千问连接超时，请检查配置和网络。')),30000);
        this.connectionReject=error=>{clearTimeout(timer);reject(error);};
        socket.onopen=()=>{
          if(!this.running||token!==this.token)return socket.close();
          const context=modelContext(this.rt.project,this.rt.view,this.rt.heardContext());
          context.view={...context.view,presentation:this.presentationState()};
          this.send({type:'init',context,allow_outside:this.rt.settings.outside,silence_ms:endMs,answer_mode:answerMode});
        };
        socket.onmessage=({data})=>{
          if(!this.running||token!==this.token)return;
          try{
            const packet=JSON.parse(data);
            if(packet.type==='ready'){if((this.manualAnswers||this.switchAnswers)&&packet.answer_mode!==answerMode)throw Error('本机服务尚未启用当前对话模式，请重启本机服务。');clearTimeout(timer);this.connectionReject=null;resolve();}
            else if(packet.type==='floor')this.floorEvent(packet);
            else if(packet.type==='interaction')this.interactionEvent(packet);
            else if(packet.type==='error')throw Error(packet.message||'千问连接中断。');
            else if(packet.type==='event')this.event(packet);
          }catch(error){this.connectionReject?.(error);this.fail(error);}
        };
        socket.onerror=()=>{if(!this.running||token!==this.token)return;const error=Error('无法连接本机实时语音服务，请检查启动窗口。');this.connectionReject?.(error);if(!this.connectionReject)this.fail(error);};
        socket.onclose=()=>{if(this.running&&token===this.token){const error=Error('千问会话已断开，麦克风已停止。请重新开启。');this.connectionReject?.(error);this.fail(error);}};
      });
      if(!this.running||token!==this.token)throw abortError();
      this.state('千问已连接 · 正在开启麦克风…');
      if(this.manualAnswers)this.listening=new ManualListening({endMs,onPcm:samples=>this.sendPcm(samples),onChunk:turn=>this.send({type:'listen_chunk',turn_id:turn}),onStart:turn=>{
        this.floorPermit=null;this.floorTurn=turn;this.floorStatus='listening';this.speechActive=true;this.rt.humanControl=true;this.rt.cancel('takeover');this.rt.hearing(true);this.send({type:'listen_start',turn_id:turn});this.state('正在倾听 · 默认由作者回答，空格交给助手');this.cb.onFloor?.(this.floorSnapshot());
      },onEnd:turn=>{this.speechActive=false;this.lastTurnEnd=performance.now();this.rt.hearing(false);this.rt.state('takeover');this.send({type:'listen_end',turn_id:turn});if(this.floorPermit)this.waitForManualAnswer();this.state(this.floorPermit?'问题已提交 · 正在等千问回答':'安静倾听 · 说完按空格，助手回答这一轮');}});
      const microphone=this.microphone=new this.Microphone({sampleRate:24000,onPcm:(samples,rate)=>{
        if(!this.running||token!==this.token)return;
        if(rate!==24000)return this.fail(Error('浏览器未提供24 kHz采样率，请用 Chrome 重试。'));
        if(this.listening)this.listening.push(samples,rate);else this.sendPcm(samples);
      },onLevel:level=>{if(this.running&&token===this.token)this.cb.onLevel?.(level);},onError:error=>{if(this.running&&token===this.token)this.fail(error);}});
      await microphone.start();
      if(!this.running||token!==this.token){microphone.stop();return;}
      this.interactionReady=this.switchAnswers;
      this.rt.stage.beginConversation?.();
      this.rt.state(this.manualAnswers?'takeover':this.switchAnswers?'listening':'paused');this.state(this.manualAnswers?'现场倾听已开启 · 默认作者回答，空格只交给助手这一轮':this.switchAnswers?'自动对话已开启 · 直接提问，空格暂停助手':'千问已连接，直接说“开始汇报”或提问。');this.cb.onFloor?.(this.floorSnapshot());this.cb.onInteraction?.(this.interactionSnapshot());
      this.rt.note('千问','实时语音已连接；语音和审核资料发送至千问。');
    }catch(error){
      // An ended start may still be awaiting a browser permission result. It
      // owns its old resources, never the session the user has since opened.
      if(!this.running||token!==this.token)return;
      this.stop();if(error.name!=='AbortError')throw error;
    }
  }
  sendPcm(samples){if(this.socket.bufferedAmount>192000)return this.fail(Error('网络发送积压，已停止录音。请检查网络后重连。'));if(this.socket.readyState===1)this.socket.send(pcm16(samples));}
  interactionSnapshot(){return {running:this.running,ready:this.interactionReady,automatic:this.switchAnswers,paused:this.interactionPaused,revision:this.interactionRevision,awaitingFreshInput:this.awaitingFreshInput};}
  interactionEvent(packet){
    if(!this.switchAnswers||packet.revision!==this.interactionRevision||packet.paused!==this.interactionPaused)return;
    this.cb.onInteraction?.(this.interactionSnapshot());
  }
  setInteractionPaused(paused){
    if(!this.running||!this.switchAnswers||!this.interactionReady||paused===this.interactionPaused)return false;
    this.interactionPaused=paused;++this.interactionRevision;this.awaitingFreshInput=true;
    this.rt.humanControl=paused;this.rt.cancel(paused?'takeover':'listening');this.rt.hearing(this.speechActive);
    this.send({type:'interaction_control',paused,revision:this.interactionRevision});
    this.state(paused?'助手已暂停回答 · 你来回答，空格恢复':'自动对话已恢复 · 只接后面的新提问');
    this.cb.onInteraction?.(this.interactionSnapshot());return true;
  }
  toggleInteraction(){return this.setInteractionPaused(!this.interactionPaused);}
  floorSnapshot(){return {running:this.running,manual:this.manualAnswers,turn:this.floorTurn,status:this.floorStatus,granted:!!this.floorPermit,capturing:this.speechActive};}
  floorEvent(packet){
    if(!this.manualAnswers||packet.turn_id!==this.floorTurn)return;
    // A delayed acknowledgement must never re-enable a locally revoked grant.
    if(packet.grant_id&&packet.grant_id!==this.floorPermit)return;
    this.floorStatus=packet.status;
    if(!packet.grant_id&&['answered','context'].includes(packet.status)){this.floorPermit=null;this.rt.humanControl=true;}
    if(packet.note)this.state(packet.note);
    this.cb.onFloor?.(this.floorSnapshot());
  }
  answerOnce(){
    if(!this.running||!this.manualAnswers)return false;
    if(this.floorPermit){this.holdAnswer();return false;}
    if(!this.floorTurn||!['listening','waiting'].includes(this.floorStatus)){this.state('当前没有新的提问 · 保持安静倾听');return false;}
    this.floorPermit=globalThis.crypto.randomUUID();this.floorStatus='armed';
    this.send({type:'answer_grant',turn_id:this.floorTurn,grant_id:this.floorPermit});
    this.listening?.submitNow();
    if(!this.speechActive)this.waitForManualAnswer();this.state('问题已提交 · 正在等千问回答');this.cb.onFloor?.(this.floorSnapshot());return true;
  }
  waitForManualAnswer(){this.clearWait();this.waitHard=setTimeout(()=>{if(!this.floorPermit)return;this.holdAnswer();this.state('本轮等待超过30秒，已收回回答权；仍在倾听，请由作者继续。');},30000);}
  holdAnswer(){
    if(!this.running||!this.manualAnswers)return;
    this.floorPermit=null;this.floorStatus='context';this.rt.humanControl=true;this.rt.cancel('takeover');this.send({type:'answer_hold'});this.state('作者回答 · 助手继续倾听，不补答这一轮');this.cb.onFloor?.(this.floorSnapshot());
  }
  interrupt(){
    if(!this.running)return;
    this.pendingGesture=null;
    if(this.manualAnswers){this.floorPermit=null;this.rt.humanControl=true;}
    this.clearWait();
    const playbacks=[];
    for(const response of this.responses.values()){
      const alreadyCancelled=response.cancelled;response.cancelled=true;response.stream?.cancel();
      const receipt=this.playbackReceipt(response);
      if(!alreadyCancelled&&receipt)playbacks.push(receipt);
    }
    for(const pending of this.narrations.values())pending.reject(abortError());
    this.narrations.clear();this.send({type:'cancel',playbacks});
    for(const response of [...this.responses.values()])this.endResponse(response,{valid:false,hasAudio:!!response.stream,tools:response.tools.length});
  }
  endResponse(response,result){
    if(response.endReported)return;
    response.endReported=true;
    // A tool-only origin may hand its intent to exactly the next response.
    // A claimed successor with no sound must not pass it down another chain.
    if(this.pendingGesture?.targetId===response.id||!result.valid&&this.pendingGesture?.originId===response.id)this.pendingGesture=null;
    if(this.responses.get(response.id)===response)this.responses.delete(response.id);
    this.cb.onResponseEnd?.({id:response.id,...result});
  }
  playbackReceipt(response){
    const status=response.stream?.playbackStatus?.();
    if(!status)return null;
    return {response_id:response.id,played_samples:status.playedSamples,received_samples:status.receivedSamples};
  }
  stop(){
    if(!this.running)return;
    this.running=false;++this.token;this.connectionReject?.(abortError());this.connectionReject=null;
    this.floorPermit=null;this.listening=null;this.floorStatus='listening';
    this.interactionReady=false;
    this.clearWait();this.pendingGesture=null;
    this.microphone?.stop();this.send({type:'stop'});this.socket?.close();
    this.rt.onCancel=null;this.rt.audio.realtimeSpeak=null;this.rt.cancel('paused');this.rt.hearing(false);
    for(const pending of this.narrations.values())pending.reject(abortError());this.narrations.clear();
    this.responses.clear();this.handledCalls.clear();this.rt.voiceMode=false;
    if(this.previousSettings)Object.assign(this.rt.settings,this.previousSettings);
    this.rt.emit();this.cb.onEnabled?.(false);this.state('语音会话已结束，麦克风已关闭。');
    this.cb.onFloor?.(this.floorSnapshot());
    this.cb.onInteraction?.(this.interactionSnapshot());
  }
  fail(error){if(!this.running)return;this.cb.onFailure?.(error);this.stop();this.state(error.message);this.rt.ui.toast(error.message,'error');this.rt.note('千问',error.message);}
  clearWait(){clearTimeout(this.waitHint);clearTimeout(this.waitHard);}
  event(packet){
    const e=packet.event,type=e.type;
    this.cb.onEvent?.(packet);
    if(type==='input_audio_buffer.speech_started'){
      if(this.manualAnswers)return;
      if(this.switchAnswers&&!this.interactionPaused)this.awaitingFreshInput=false;
      this.speechActive=true;
      this.rt.cancel(this.rt.humanControl?'takeover':'listening');this.rt.hearing(true);this.state(this.switchAnswers&&this.interactionPaused?'助手已暂停回答 · 正在听取上下文':'正在听…');this.rt.ui.waiting('');return;
    }
    if(type==='input_audio_buffer.speech_stopped'){
      if(this.manualAnswers)return;
      this.speechActive=false;
      if(this.switchAnswers&&(this.interactionPaused||this.awaitingFreshInput)){this.rt.hearing(false);this.state(this.interactionPaused?'助手已暂停回答 · 你来回答，空格恢复':'已恢复 · 等待下一次新提问');return;}
      this.rt.hearing(false);this.lastTurnEnd=performance.now();this.rt.state(this.rt.humanControl?'takeover':'thinking');this.state('正在理解…');
      this.clearWait();if(!this.rt.humanControl){this.waitHint=setTimeout(()=>this.state('千问仍在处理，可以直接开口打断。'),3000);this.waitHard=setTimeout(()=>this.fail(Error('千问本轮等待超过30秒，已停止录音并保留主讲位置。请检查网络后重新开启。')),30000);}return;
    }
    if(type==='conversation.item.input_audio_transcription.delta'){this.cb.onHeard?.((e.text||'')+(e.stash||''));return;}
    if(type==='conversation.item.input_audio_transcription.completed'){
      if(e.transcript?.trim()){this.cb.onHeard?.(e.transcript);this.rt.ui.message('user',e.transcript);}return;
    }
    // Transcription is a caption, not the control source; Omni listens directly to audio.
    if(type==='conversation.item.input_audio_transcription.failed'){this.cb.onHeard?.('这句话未生成可靠字幕，正在根据声音处理。');return;}
    if(type==='response.created'){
      const id=e.response?.id;if(!id)return;
      const floorDenied=this.manualAnswers&&!packet.request_id&&(!this.floorPermit||packet.floor_grant!==this.floorPermit||packet.floor_turn!==this.floorTurn);
      const interactionDenied=this.switchAnswers&&!packet.request_id&&(this.interactionPaused||this.awaitingFreshInput||packet.interaction_revision!==this.interactionRevision);
      this.responses.set(id,{id,text:'',messageId:null,stream:null,audioBytes:0,requestId:packet.request_id,cancelled:this.speechActive||!!packet.cancelled||!!packet.request_id&&!this.narrations.has(packet.request_id),
        epoch:this.rt.epoch.number,token:this.token,tools:[],motions:[],deferred:null,questionId:this.rt.currentQuestion?.status==='answering'?this.rt.activeQuestionId:null});
      this.responses.get(id).floorGrant=packet.floor_grant;
      if(floorDenied||interactionDenied)this.responses.get(id).cancelled=true;
      else if(this.manualAnswers&&!this.responses.get(id).cancelled)this.rt.humanControl=false;
      const next=this.responses.get(id),intent=this.pendingGesture;
      if(intent&&id!==intent.originId){
        if(intent.targetId||packet.request_id||next.cancelled||intent.epoch!==next.epoch||intent.token!==next.token||intent.questionId!==next.questionId)this.pendingGesture=null;
        else {intent.targetId=id;next.gestureRequested=true;}
      }
      if(this.speechActive)this.send({type:'cancel'});return;
    }
    const id=e.response_id||e.response?.id,response=this.responses.get(id);
    if(type==='response.function_call_arguments.done'){
      if(this.handledCalls.has(e.call_id))return;this.handledCalls.add(e.call_id);
      // Capture at receipt, before the serial tool queue or later PCM packets.
      const boundary=response?.stream?{stream:response.stream,sampleCount:Math.floor(response.audioBytes/2)}:null;
      const token=this.token;
      const task=this.toolChain.then(()=>{if(this.running&&token===this.token)return this.tool(e,response,packet.cancelled,boundary);}).catch(error=>{if(this.running&&token===this.token)this.send({type:'tool_result',call_id:e.call_id,result:{ok:false,message:error.message}});});
      this.toolChain=task;response?.tools.push(task);return;
    }
    if(!response)return;
    if(packet.cancelled)response.cancelled=true;
    if(type==='response.done'){void this.finishResponse(response,e.response).catch(error=>this.fail(error));return;}
    if(response.cancelled||response.epoch!==this.rt.epoch.number)return;
    if(type==='response.audio_transcript.delta'||type==='response.text.delta'){
      response.text+=e.delta||'';
      if(response.text.length>32000)throw Error('这一轮回答过长，已停止。');
      if(!response.messageId)response.messageId=this.rt.ui.message('assistant',response.text);
      else this.rt.ui.updateMessage(response.messageId,response.text);
      if(!this.rt.humanControl){this.rt.caption=response.text;this.rt.emit();}return;
    }
    if(type==='response.audio.delta'&&!this.rt.humanControl){
      if(!response.stream){
        response.stream=this.rt.audio.openPcmStream({onStart:()=>{
          if(response.cancelled||!this.running)return;
          this.clearWait();
          this.rt.state('speaking');this.state('正在回答，可直接开口打断。');
          response.audioStarted=true;this.startPendingGesture(response);
          this.narrations.get(response.requestId)?.onStart?.();
          if(this.lastTurnEnd&&!response.requestId){this.rt.metric=Math.round(performance.now()-this.lastTurnEnd);this.lastTurnEnd=null;this.rt.note('千问耗时',`收到语音结束事件至客户端起播 ${this.rt.metric} ms`);}
        }});
      }
      const bytes=audioBytes(e.delta);response.audioBytes+=bytes.length;response.stream.push(bytes);
    }
  }
  async finishResponse(response,remote){
    if(!this.running||response.token!==this.token)return;
    if(remote?.status==='failed')throw Error('千问未能完成本轮回答，请重说或检查平台状态。');
    if(remote?.status==='incomplete')throw Error('千问这一轮输出被截断，已停止并保留主讲位置。');
    if(remote?.status==='cancelled')response.cancelled=true;
    response.stream?.finish();
    // EOF belongs to the received PCM, not the completion of PPT animations.
    // Mouth preparation needs EOF to release the final context/padded batch.
    await Promise.all(response.tools);
    if(!this.running||response.token!==this.token)return;
    try{await response.stream?.done;}catch(error){if(error.name!=='AbortError')throw error;response.cancelled=true;}
    await Promise.all(response.motions);
    const valid=this.running&&response.token===this.token&&!response.cancelled&&response.epoch===this.rt.epoch.number;
    if(valid&&response.stream){
      const receipt=this.playbackReceipt(response);
      if(receipt)this.send({type:'playback_done',...receipt});
    }
    const pending=this.narrations.get(response.requestId);
    if(pending){
      this.narrations.delete(response.requestId);
      this.send({type:'narration_done',request_id:response.requestId});
      if(!valid)pending.reject(abortError());
      else if(!response.stream)pending.reject(Error('千问没有返回讲稿声音，主讲位置已保留。'));
      else pending.resolve();
    }
    if(valid){
      if(!response.tools.length)this.clearWait();
      if(response.questionId&&response.text&&response.stream){
        const q=this.rt.questions.find(q=>q.id===response.questionId);
        if(q?.status==='answering'){q.delivered.push(response.text);q.parts=[...q.delivered];q.complete=true;q.status='done';q.lastDelivery=++this.rt.deliverySequence;this.rt.history=this.rt.heardContext();}
      }
      if(response.deferred){response.deferred();}
      // A completed answer leaves the still-connected conversation listening.
      // Explicit pause/cancel remains distinct and still stops the performer.
      else if(this.manualAnswers&&response.stream&&!response.requestId&&!response.tools.length&&response.floorGrant===this.floorPermit){
        this.send({type:'answer_done',grant_id:this.floorPermit});this.floorPermit=null;this.floorStatus='answered';this.rt.humanControl=true;this.rt.caption='';this.rt.state('takeover');this.state('回答结束 · 恢复安静倾听，下一轮仍需空格授权');this.cb.onFloor?.(this.floorSnapshot());
      }
      else if(!this.rt.main){this.rt.caption='';this.rt.state(this.rt.humanControl?'takeover':'listening');this.state(this.manualAnswers?'正在处理本轮获准回答':this.switchAnswers?this.interactionPaused?'助手已暂停回答 · 你来回答，空格恢复':'自动对话中 · 直接提问，空格暂停助手':this.rt.humanControl?'作者接管中。说“继续汇报”可交回主讲。':'正在听，可以继续提问。');}
    }
    this.endResponse(response,{valid,hasAudio:!!response.stream,tools:response.tools.length});
  }
  narrate(text,{signal,onStart}={}){
    if(!this.running||signal?.aborted)return Promise.reject(abortError());
    if(typeof text!=='string'||!text.trim()||text.length>2000)return Promise.reject(Error('单句讲稿需要控制在2000字以内。'));
    const id=globalThis.crypto.randomUUID();
    return new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>{
        // Reject before cancelling the session: cancel also rejects pending
        // narrations, and must not hide this failure as a routine interruption.
        const error=Error('讲稿声音等待超时，已停止会话并保留当前句子。请重新开启后继续汇报。');
        this.narrations.delete(id);finish(reject)(error);this.fail(error);
      },this.narrationTimeoutMs);
      const finish=fn=>value=>{clearTimeout(timeout);signal?.removeEventListener('abort',cancel);fn(value);};
      const cancel=()=>{this.narrations.delete(id);finish(reject)(abortError());};
      signal?.addEventListener('abort',cancel,{once:true});
      this.narrations.set(id,{resolve:finish(resolve),reject:finish(reject),onStart});
      this.send({type:'narrate',request_id:id,text});
    });
  }
  gestureCurrent(response){return this.running&&response.token===this.token&&!response.cancelled&&response.epoch===this.rt.epoch.number&&!this.speechActive&&!this.rt.humanControl;}
  async playGesture(response,intent,boundary){
    if(!Number.isSafeInteger(boundary.stream.playbackId))throw Error('人物动作缺少有效的播放归属。');
    const timing={originResponseId:intent.originId,responseId:response.id,callId:intent.callId,kind:intent.kind,sampleCount:boundary.sampleCount,playbackId:boundary.stream.playbackId};
    const played=await boundary.stream.waitForPlayback(boundary.sampleCount);
    if(!this.gestureCurrent(response)||response.stream!==boundary.stream)throw abortError();
    const motion=this.rt.stage.speechGesture?.(intent.kind,{when:'speech',playbackId:timing.playbackId,signal:this.rt.epoch.controller.signal,source:'qwen-performer',action:intent.kind});
    if(!motion)throw Error('当前人物未接受这个动作，保持现有姿态。');
    this.cb.onGestureCue?.({...timing,...played,motion,phase:'scheduled',at:performance.now()});
    return {ok:true,status:'scheduled',kind:intent.kind,playbackId:timing.playbackId};
  }
  startPendingGesture(response){
    const intent=this.pendingGesture;
    if(!intent||(intent.targetId??intent.originId)!==response.id)return;
    this.pendingGesture=null;
    if(!this.gestureCurrent(response)||intent.token!==this.token||intent.epoch!==response.epoch)return;
    // onStart can precede the first AudioContext sample. Wait for one actually
    // played sample before asking the performer to reserve the gesture.
    const task=this.playGesture(response,intent,{stream:response.stream,sampleCount:1}).catch(error=>{
      this.cb.onGestureCue?.({originResponseId:intent.originId,responseId:response.id,callId:intent.callId,kind:intent.kind,phase:error.name==='AbortError'?'cancelled':'rejected',message:error.message,at:performance.now()});
    });
    // The tool was already acknowledged by its originating response. This
    // local gesture does not require another model reply after speech ends.
    response.motions.push(task);
  }
  async tool(e,response,cancelled,boundary=null){
    const token=this.token;
    const reply=(result,proceed=true)=>{if(this.running&&token===this.token&&(!response||response.token===token))this.send({type:'tool_result',call_id:e.call_id,result,continue:proceed});};
    if(!this.running||!response||cancelled||response.cancelled||response.token!==this.token||response.epoch!==this.rt.epoch.number){reply({ok:false,message:'本轮已被打断，不执行过期动作。'},false);return;}
    let releaseIntent;
    try{
      if(typeof e.arguments!=='string'||e.arguments.length>16000)throw Error('工具参数无效。');
      const args=validateTool(e.name,JSON.parse(e.arguments),this.rt.project);
      if((this.manualAnswers||this.switchAnswers)&&['lecture','question'].includes(e.name)){reply({ok:false,message:'现场不建立待答队列，不自行恢复主讲。'},false);return;}
      if(e.name==='presentation_state'){reply({ok:true,...this.presentationState()});return;}
      if(e.name==='performer_gesture'){
        if(!this.gestureCurrent(response)||response.requestId)throw abortError();
        if(!this.rt.stage.capabilities?.gestures?.includes(args.kind)||typeof this.rt.stage.speechGesture!=='function')throw Error('当前人物没有启用这个动作。');
        if(response.gestureRequested||this.pendingGesture)throw Error('当前回答已有动作，不重复安排。');
        response.gestureRequested=true;
        const intent={originId:response.id,targetId:null,callId:e.call_id,kind:args.kind,token,epoch:response.epoch,questionId:response.questionId};
        this.cb.onGestureCue?.({originResponseId:response.id,responseId:response.id,callId:e.call_id,kind:args.kind,sampleCount:boundary?.sampleCount??1,phase:'queued',at:performance.now()});
        if(boundary){reply(await this.playGesture(response,intent,{...boundary,sampleCount:Math.max(1,boundary.sampleCount)}));return;}
        this.pendingGesture=intent;
        if(response.audioStarted)this.startPendingGesture(response);
        reply({ok:true,status:'queued-for-speech',kind:args.kind,instruction:'仅预约动作，尚未显示。随本次或紧接着的下一次语音回答安排；不要宣称已经完成。'});return;
      }
      if(e.name==='presentation'){
        if(this.rt.humanControl)throw Error('作者正在接管，请先明确交还控制权。');
        const timing={responseId:response.id,callId:e.call_id,actions:clone(args.actions),sampleCount:boundary?.sampleCount??0};
        if(boundary&&Number.isSafeInteger(boundary.stream.playbackId)){
          releaseIntent=this.rt.stage.preparePresentationIntent?.({...timing,playbackId:boundary.stream.playbackId,signal:this.rt.epoch.controller.signal});
          // EOF/cancellation can settle while a picture is still awaiting its
          // sample or animation. Releasing the hint never releases audio.
          if(releaseIntent)boundary.stream.done.then(()=>releaseIntent('eof'),()=>releaseIntent('cancelled'));
        }
        this.cb.onPresentationCue?.({...timing,phase:'queued',at:performance.now()});
        const played=boundary?await boundary.stream.waitForPlayback(boundary.sampleCount):null;
        if(!this.running||response.cancelled||response.token!==this.token||response.epoch!==this.rt.epoch.number)throw abortError();
        this.cb.onPresentationCue?.({...timing,...played,phase:'start',at:performance.now()});
        await this.rt.action(args.actions,response.epoch,{cueTiming:'speech',cueSource:'qwen-presentation'});
        if(!this.running||response.cancelled||response.epoch!==this.rt.epoch.number)throw abortError();
        this.cb.onPresentationCue?.({...timing,phase:'completed',at:performance.now()});
        reply({ok:true,view:clone(this.rt.view)});return;
      }
      if(e.name==='lecture'){
        // Wait until this tool response is finished before starting the next narration.
        const operation=args.operation;
        reply({ok:true,operation,bookmark:clone(this.rt.bookmark)},false);
        response.deferred=()=>{
          if(operation==='start')void this.rt.startLecture(Math.max(0,this.rt.project.slides.findIndex(s=>s.id===this.rt.view.main.imageId)),null,true);
          else if(operation==='resume')void this.rt.resume(true);
          else if(operation==='takeover')this.rt.takeover();
          else if(operation==='pause')this.rt.cancel('paused');
          else this.stop();
        };
        return;
      }
      if(e.name==='question'){
        const op=args.operation;
        if(op==='repeat'){this.dialogue.awaiting='repeat';reply({ok:true,instruction:'请一位先说，再重说没有听清的内容。'});return;}
        if(op==='new'){
          if(this.rt.questions.length>=100)throw Error('本轮问题记录已满，请结束后重新开启会话。');
          const held=this.rt.humanControl,pending=this.rt.questions.some(q=>!['done','skipped'].includes(q.status));
          const q={id:++this.rt.questionSequence,text:args.text.trim(),status:pending||held?'queued':'answering',parts:[],delivered:[],complete:false,view:clone(this.rt.view),source:'千问实时语音'};
          this.rt.questions.push(q);this.dialogue.awaiting=pending?'select':null;
          if(!pending&&!held){this.rt.activeQuestionId=q.id;response.questionId=q.id;}
          this.rt.emit();reply({ok:true,id:q.id,queued:pending||held,instruction:held?'作者接管中，保持安静。':pending?'口头询问先回答哪一道，不立即回答新问题。':'现在回答这道问题。',...this.presentationState()});return;
        }
        const q=this.rt.questions.find(q=>q.id===args.id);
        if(!q||['done','skipped'].includes(q.status))throw Error('该问题已完成或不存在，请口头确认。');
        if(op==='skip'){q.status='skipped';if(this.rt.activeQuestionId===q.id)this.rt.activeQuestionId=null;reply({ok:true,...this.presentationState()});}
        else{
          if(op==='update'){q.text=args.text.trim();q.delivered=[];q.parts=[];q.complete=false;}
          this.rt.humanControl=false;this.rt.activeQuestionId=q.id;q.status='answering';this.dialogue.awaiting=null;response.questionId=q.id;
          reply({ok:true,question:q.text,heard:q.delivered.join(''),instruction:'回答这道问题。之前未完整播放的内容不能视作已经讲过。'});
        }
        this.rt.emit();
      }
    }catch(error){reply({ok:false,message:error.name==='AbortError'?'操作已被打断。':error.message},error.name!=='AbortError');}
    finally{releaseIntent?.('tool-finished');}
  }
}
