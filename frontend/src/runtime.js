import {clone,Epoch,freshView,commandRoute,ruleAnswer,validateActions,modelContext} from './core.js?v=public-core-2';
import {SpeechPlayer,events,sleep,abortError} from './audio.js?v=public-core-2';
import {lecturePlan} from './lecture-plan.js?v=public-core-2';
export class Runtime {
  constructor(project,stage,ui){this.project=project;this.stage=stage;this.ui=ui;this.epoch=new Epoch();this.audio=new SpeechPlayer(()=>{},frame=>{this.stage.setSpeech?.(frame);this.ui.audioFrame?.(frame);},event=>this.stage.setPcmPlayback?.(event));this.audio.pcmPreparation=options=>this.preparePcm(options);this.view=freshView(project.slides[0].id);this.bookmark=null;this.main=false;this.position={slide:0,sentence:0};this.status='idle';this.history=[];this.questions=[];this.activeQuestionId=null;this.questionSequence=0;this.deliverySequence=0;this.humanControl=false;this.log=[];this.caption='';this.metric=null;this.settings={mode:'demo',audio:'system',voice:'',outside:false,hardTimeout:8};}
  // Called lazily for every PCM utterance, so a scene can prepare its current
  // pose without replacing Qwen's transport or microphone lifecycle.
  preparePcm(options){return this.stage.preparePcm?.(options)||null;}
  emit(){this.ui.update(this);}
  hearing(value){this.stage.setHearing?.(value);this.ui.hearing?.(value);}
  note(type,text){this.log.unshift({time:new Date().toLocaleTimeString('zh-CN',{hour12:false}),type,text});this.log=this.log.slice(0,60);this.emit();}
  state(value){this.status=value;this.emit();}
  freeze(){this.view=this.stage.freeze()||this.stage.snapshot();}
  cancel(reason='paused',keepBookmark=true){
    this.freeze();if(this.main&&keepBookmark)this.bookmark={...this.position,ready:!!this.lectureUnitReady,view:clone(this.view)};
    // 取消仅停止输出，保留本轮已经完整播完的句子和对应画面。
    const current=this.questions.find(q=>q.id===this.activeQuestionId);
    if(current?.status==='answering'){current.status='paused';current.view=clone(this.view);}
    this.ui.waiting('');this.main=false;this.epoch.cancel();this.audio.stop();this.ui.cancelRecorder?.();this.caption='';this.state(reason);this.onCancel?.(reason);return this.epoch.number;
  }
  async action(actions,n=this.epoch.number,options){
    validateActions(actions,this.project);
    for(const action of actions){if(!this.epoch.current(n))throw abortError();await this.stage.apply(action,this.project,this.epoch.controller.signal,options);if(!this.epoch.current(n))throw abortError();this.view=this.stage.snapshot();this.note('画面',action.type);}
  }
  async manual(actions){const n=this.cancel('paused');try{await this.action(actions,n);}catch(e){if(e.name!=='AbortError')this.fail(e,n);}}
  async speak(text,n,onStart=()=>{},signal=this.epoch.controller.signal){
    if(!this.epoch.current(n))throw abortError();this.caption=text;this.emit();
    await this.audio.play(text,{mode:this.settings.audio,voice:this.settings.voice,signal,onStart:()=>{if(this.epoch.current(n)){this.state('speaking');onStart();}},onCaption:()=>{if(this.epoch.current(n))this.state('captioning');}});
  }
  async startLecture(from=0,resume=null,confirmed=false){
    if(!confirmed&&this.questions.some(q=>!['done','skipped'].includes(q.status))&&!(await this.ui.confirmLecture?.()))return;
    this.humanControl=false;const n=this.cancel('preparing',false);this.bookmark=null;this.main=true;this.position={slide:from,sentence:resume?.sentence||0};this.audio.unlock().catch(()=>{});
    try{
      const plan=this.stage.lecturePlan||lecturePlan(this.project),signal=this.epoch.controller.signal;
      for(const page of plan.filter(page=>page.slideIndex>=from)){
        const i=page.slideIndex,start=i===from?(resume?.sentence||0):0;
        if(start>=page.units.length)continue;
        this.position={slide:i,sentence:start};this.lectureUnitReady=false;
        const restoreSaved=i===from&&resume&&resume.ready!==false;
        if(restoreSaved){await this.stage.restore(resume.view,this.project,signal);if(!this.epoch.current(n))return;this.view=this.stage.snapshot();}
        else await this.action([{type:'show_image',imageId:page.id}],n,{cue:false});
        for(let j=start;j<page.units.length;j++){
          const unit=page.units[j];this.position.sentence=j;this.lectureUnitReady=false;
          if(!(restoreSaved&&j===start))await this.stage.prepareLectureUnit?.(unit,signal);
          if(!this.epoch.current(n))return;
          this.view=this.stage.snapshot();this.lectureUnitReady=true;this.emit();
          await this.speak(unit.text,n,()=>this.stage.startLectureUnit?.(unit));
          if(!this.epoch.current(n))return;
          this.lectureUnitReady=false;this.position.sentence=j+1;
        }
      }
      if(this.epoch.current(n)&&this.stage.lecturePlan)await this.action([{type:'restore_view'}],n,{cue:false});
      if(this.epoch.current(n)){this.main=false;this.caption='';this.bookmark=null;this.state('idle');this.note('主讲','本轮主讲完成。');}
    }catch(e){if(e.name!=='AbortError'){if(this.main)this.bookmark={...this.position,view:clone(this.view)};this.fail(e,n);}}
  }
  resume(confirmed=false){if(this.bookmark){const b=clone(this.bookmark);return this.startLecture(b.slide,b,confirmed);}const i=this.project.slides.findIndex(s=>s.id===this.view.main.imageId);return this.startLecture(Math.max(0,i),null,confirmed);}
  takeover(){this.humanControl=true;this.cancel('takeover');this.note('接管','已停止声音、动画及旧请求。主讲书签保留。');}
  fail(error,n){if(!this.epoch.current(n))return;this.cancel('error');this.ui.toast(error.message||String(error),'error');this.note('异常',error.message||String(error));}
  clearQuestions(){this.questions=[];this.activeQuestionId=null;this.questionSequence=0;}
  get currentQuestion(){return this.questions.find(q=>q.id===this.activeQuestionId);}
  heardContext(){
    // 模型只接收已完成播放的片段，不把预生成但没说出口的文字当成已知交流。
    return this.questions.filter(q=>q.delivered.length||q.prefix).sort((a,b)=>(a.lastDelivery||0)-(b.lastDelivery||0)).flatMap(q=>[
      {role:'user',content:q.text},
      {role:'assistant',content:(q.silent?'[字幕已展示，未播放语音] ':'')+(q.prefix||'')+q.delivered.join('')+(q.status==='done'?'':' [回答未完成]')}
    ]).slice(-6);
  }
  requestRepeat(){
    this.cancel('paused');
    if(!this.questions.some(q=>q.status==='repeat'))this.questions.push({id:++this.questionSequence,text:'未听清的提问（请重说）',status:'repeat',parts:[],delivered:[],complete:false,view:null,source:'手动标记'});
    this.caption='刚才的提问没有听清，请一位先说。';
    this.ui.message('assistant',this.caption+'（手动协调提示；请在说话间隙使用）');
    this.note('协调','已暂停输出；重说时请选择待重说的问题。未启用自动重叠检测。');
  }
  skipQuestion(id){
    const q=this.questions.find(q=>q.id===id);if(!q)return;
    if(q.id===this.activeQuestionId)this.cancel('paused');q.status='skipped';this.note('问题',`已跳过第 ${id} 题。`);
  }
  async ask(question,startAt=performance.now(),options={}){
    question=question.trim();if(!question)return;
    if(question.length>2000){this.ui.toast('问题请控制在2000字以内。');return;}
    if(/^(嗯|嗯嗯|好的|好|明白了)[。！!]?$/u.test(question)){this.note('协调','收到简短回应，未新增问题。');return;}
    if(question==='请重说'){this.requestRepeat();return;}
    if(question==='继续当前回答')return this.answerQuestion(this.activeQuestionId);
    const choose=question.match(/^先回答第\s*(\d+)\s*题[。]?$/);
    if(choose)return this.answerQuestion(Number(choose[1]));
    const named=question.match(/^先回答(.+?)(?:的问题|问题)$/);
    if(named){const matches=this.questions.filter(q=>!['done','skipped','repeat'].includes(q.status)&&q.text.includes(named[1]));if(matches.length===1)return this.answerQuestion(matches[0].id);this.ui.toast('无法唯一确定问题，请在问题队列中选择。');return;}
    if(options.kind&&options.kind!=='new'){
      const q=this.questions.find(q=>q.id===Number(options.targetId));
      if(!q||['done','skipped'].includes(q.status)){this.ui.toast('请选择一条尚未完成的问题。');return;}
      if(options.kind==='repeat'&&q.status!=='repeat'){this.ui.toast('请选择待重说的问题。');return;}
      const updated=options.kind==='supplement'?q.text+'\n补充：'+question:question;
      if(updated.length>2000){this.ui.toast('补充后问题超过2000字，请精简或另建问题。');return;}
      this.cancel(this.humanControl?'takeover':'paused');this.ui.message('user',question);
      q.text=updated;
      q.parts=[];q.delivered=[];q.prefix='';q.complete=false;q.view=null;q.status='queued';q.source=options.source||'文字输入';this.history=this.heardContext();
      this.note('问题',`第 ${q.id} 题已更新。`);return;
    }
    const command=commandRoute(question,this.project,this.view);
    if(command){
      this.ui.message('user',question);
      if(command.control==='resume')return this.resume();
      if(command.control==='takeover')return this.takeover();
      const n=this.cancel('paused');
      if(command.control)return;
      try{await this.action(command.actions||[],n);if(this.epoch.current(n))this.ui.message('assistant',command.text||'已完成。');}catch(e){if(e.name!=='AbortError')this.fail(e,n);}return;
    }
    const held=this.humanControl;
    const pending=this.questions.some(q=>!['done','skipped'].includes(q.status));
    this.cancel(held?'takeover':'paused');this.ui.message('user',question);
    const q={id:++this.questionSequence,text:question,status:'queued',parts:[],delivered:[],complete:false,view:clone(this.view),source:options.source||'文字输入'};
    this.questions.push(q);this.note('问题',`已记录第 ${q.id} 题。`);
    if(!pending&&!held)return this.answerQuestion(q.id,startAt);
    if(!this.voiceMode)this.ui.toast(held?'问题已记录；点击“先回答”可明确交还发言权。':'问题已排队，请选择先回答哪题。');
  }
  async answerQuestion(id,startAt=performance.now()){
    const q=this.questions.find(q=>q.id===id);
    if(!q||['done','skipped','repeat'].includes(q.status)){this.ui.toast('请选择待回答的问题；未听清的问题需要先重说。');return;}
    this.humanControl=false;const n=this.cancel('thinking');this.activeQuestionId=q.id;q.status='answering';this.audio.unlock().catch(()=>{});this.emit();
    if(q.complete){
      let started=this.settings.audio==='silent';
      const timer=setTimeout(()=>{if(!started&&this.epoch.current(n)){this.takeover();this.ui.toast('恢复回答时声音等待超时，请人工接管。','error');}},this.settings.hardTimeout*1000);
      try{
        if(q.view){await this.stage.restore(q.view,this.project,this.epoch.controller.signal);if(!this.epoch.current(n))return;this.view=this.stage.snapshot();}
        for(let i=q.delivered.length;i<q.parts.length;i++){
          await this.speak(q.parts[i],n,()=>{started=true;});if(!this.epoch.current(n))return;q.delivered.push(q.parts[i]);q.lastDelivery=++this.deliverySequence;this.history=this.heardContext();
        }
        q.status='done';this.history=this.heardContext();this.caption='';this.state('paused');
      }catch(e){if(e.name!=='AbortError')this.fail(e,n);}finally{clearTimeout(timer);}return;
    }
    if(q.view){try{await this.stage.restore(q.view,this.project,this.epoch.controller.signal);if(!this.epoch.current(n))return;this.view=this.stage.snapshot();}catch(e){if(e.name!=='AbortError')this.fail(e,n);return;}}
    if(q.parts.length||q.delivered.length)this.note('问题','生成曾被中断，将结合已完成片段重新组织回答。');
    const previous=(q.prefix||'')+q.delivered.join('');q.parts=[];q.complete=false;
    return this.generateAnswer(q,n,startAt,previous);
  }
  async generateAnswer(q,n,startAt,previous=''){
    const question=q.text;

    q.prefix=previous; q.delivered=[];
    const signal=this.epoch.controller.signal;this.metric=null;
    const cue=new AbortController(),cancelCue=()=>cue.abort();signal.addEventListener('abort',cancelCue,{once:true});let cueTask=Promise.resolve(),answerQueued=false,textArrived=false;
    const elapsed=()=>Math.round(performance.now()-startAt);q.silent=this.settings.audio==='silent';
    const answerId=this.ui.message('assistant','正在寻找对应材料…');let full='',first=false,heard=[],hadMeta=false;let chain=Promise.resolve(),queueError=null,buffer='';
    const markFirst=()=>{if(!first&&this.epoch.current(n)){first=true;this.metric=Math.round(performance.now()-startAt);this.ui.waiting('');this.note('音频',`客户端首段起播 ${this.metric} ms（不是外部扬声器实测）`);}};
    const hint=setTimeout(()=>{if(!first&&this.epoch.current(n)){
      this.ui.waiting('正在进一步确认，请稍候。');
      if(this.voiceMode&&!answerQueued)cueTask=this.speak('稍等，我确认一下。',n,()=>{},cue.signal).catch(e=>{if(e.name!=='AbortError'&&this.epoch.current(n))this.note('提示音','等待提示未播放，继续准备回答。');});
    }},3000);
    const hard=setTimeout(()=>{if(!first&&this.epoch.current(n)){this.ui.updateMessage(answerId,full?full+'\n\n[回答或声音等待超时，已停止。请人工接管。]':'回答或声音等待超时。该轮已停止，请由项目作者接答。');this.takeover();}},this.settings.hardTimeout*1000);
    const enqueue=(part)=>{if(!part.trim())return;if(!answerQueued){answerQueued=true;clearTimeout(hint);cancelCue();this.note('耗时',`首个完整句 ${elapsed()} ms`);}q.parts.push(part);chain=chain.then(async()=>{await cueTask;if(queueError||!this.epoch.current(n))return;await this.speak(part,n,markFirst);if(this.epoch.current(n)){heard.push(part);q.delivered.push(part);q.lastDelivery=++this.deliverySequence;this.history=this.heardContext();}}).catch(e=>{queueError=e;if(e.name!=='AbortError')this.fail(e,n);});};
    const append=(delta)=>{if(!this.epoch.current(n))return;if(!textArrived&&delta.trim()){textArrived=true;this.note('耗时',`首段文字 ${elapsed()} ms`);}if(this.settings.audio==='silent'&&delta.trim()&&!first){first=true;this.ui.waiting('');this.note('文字','首段文字已到达；未测量声音。');}full+=delta;this.ui.updateMessage(answerId,full);buffer+=delta;let match;while((match=buffer.match(/^([\s\S]*?[。！？!?\n])/))){enqueue(match[1]);buffer=buffer.slice(match[1].length);}if(buffer.length>140){const cut=Math.max(buffer.lastIndexOf('，',140),buffer.lastIndexOf(' ',140));if(cut>30){enqueue(buffer.slice(0,cut+1));buffer=buffer.slice(cut+1);}}};
    try{
      if(this.settings.mode==='demo'){
        const result=ruleAnswer(question,this.project,this.view);await this.action(result.actions,n);hadMeta=true;q.view=clone(this.view);this.note('依据',result.sources.length?result.sources.join('、'):'未找到已审核依据');if(previous){q.prefix='';q.delivered=[];this.note('问题','规则模式不能重写剩余内容，本题从头重播。');}append(result.text);
      }else{
        const response=await fetch('/api/ask',{method:'POST',headers:{'Content-Type':'application/json','X-IP-Presenter':'1'},body:JSON.stringify({question,context:modelContext(this.project,this.view,this.history.map(h=>({...h,content:h.content.slice(-16000)}))),allow_outside:this.settings.outside}),signal});
        for await(const event of events(response)){
          if(!this.epoch.current(n))break;
          if(event.type==='meta'){if(hadMeta)throw Error('服务重复发送控制计划。');await this.action(event.actions||[],n);hadMeta=true;q.view=clone(this.view);this.note('依据',event.sources?.join('、')||'未找到依据 / 仅范围提示');}
          else if(event.type==='text'){if(!hadMeta)throw Error('服务未给出有效展示计划。');append(event.text);}
          else if(event.type==='error')throw Error(event.message);
        }
      }
      if(!this.epoch.current(n))return;if(!hadMeta||!full.trim())throw Error('服务没有返回有效回答。');if(buffer.trim())enqueue(buffer);q.complete=true;await chain;if(queueError)throw queueError;
      if(this.epoch.current(n)){this.caption='';this.state('paused');q.status='done';this.history=this.heardContext();this.emit();}
    }catch(e){if(e.name!=='AbortError'&&this.epoch.current(n)){this.ui.updateMessage(answerId,(full?full+'\n\n':'')+'[已停止] '+e.message);this.fail(e,n);}}
    finally{clearTimeout(hint);clearTimeout(hard);cancelCue();signal.removeEventListener('abort',cancelCue);if(this.epoch.current(n))this.ui.waiting('');}
  }
}
