import {commandRoute,clone} from './core.js?v=public-core-2';
/** Conservative fast path; uncertain natural language is delegated to the model or clarified aloud. */
export function localVoiceIntent(text,rt,awaiting=null){
  const q=text.replace(/[，。！？!?、\s]/g,'').replace(/(?:吧|好吗|好嘛)$/,'');
  const number=value=>/^\d+$/.test(value)?Number(value):({'一':1,'二':2,'两':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9,'十':10}[value]);
  if(/^(你好|您好|哈喽|嗨|你能听到吗|能听到我说话吗)$/.test(q))return {intent:'greeting'};
  if(/^(结束语音|关闭麦克风|结束语音会话|退出语音模式)$/.test(q))return {intent:'stop_session'};
  if(/^(开始汇报|开始讲解|开始演讲|请开始汇报|请开始讲解|开始|开始讲|你开始讲|可以开始了|请开始)$/.test(q))return {intent:'start_lecture'};
  if(/^(你来回答|交给你回答|请你回答)$/.test(q)){const pending=rt.questions.filter(x=>!['done','skipped','repeat'].includes(x.status));return pending.length===1?{intent:'select',target_id:pending[0].id}:{intent:'clarify',release:true,clarification:'你想让我先回答哪一题？也可以说继续汇报。'};}
  if(/^(我来回答|我来讲|人工接管)$/.test(q))return {intent:'takeover'};
  if(/^(继续汇报|继续主讲|回到主讲|接着汇报|请继续汇报)$/.test(q))return {intent:'resume_lecture'};
  if(/^(继续当前回答|继续回答|接着回答|先回答刚才的问题)$/.test(q))return {intent:'resume_answer',target_id:awaiting?.oldId??rt.activeQuestionId};
  if(/^(停|停止|暂停|停一下|先停一下|别讲了|暂停一下|停止讲解|停下来|等一下|等等|先别说了)$/.test(q))return {intent:'pause'};
  if(/^(没听清|没有听清|请重说|刚才没听清|刚才两个人同时说话)$/.test(q))return {intent:'repeat'};
  let match=q.match(/^(?:先回答|回答|先讲|继续第?|跳过第?)(?:第)?([一二两三四五六七八九十\d]+)(?:个)?(?:题|问题)$/);
  if(match)return {intent:q.startsWith('跳过')?'skip':'select',target_id:number(match[1])};
  if(awaiting?.kind==='choose'&&/^(先回答新的|先回答新问题|先说新的)$/.test(q))return {intent:'select',target_id:awaiting.newId};
  if(awaiting?.kind==='choose'&&/^(先回答原来的|先回答刚才的|先说原来的|先说刚才的)$/.test(q))return {intent:'select',target_id:awaiting.oldId};
  if(awaiting?.kind==='picture'&&/^(是|是的|对|对的|没错|好的|确认|可以)$/.test(q))return {intent:'image',actions:awaiting.actions,text:awaiting.text};
  if(awaiting?.kind==='main'&&/^(是|是的|好的|继续|继续吧|确认|可以)$/.test(q))return {intent:'resume_lecture',confirmed:true};
  if(awaiting&&/^(不是|取消|不用|不要)$/.test(q))return {intent:'pause'};
  if(/^(继续|继续讲|继续说|接着说|接着讲|往下讲|你继续讲)$/.test(q)){
    if(rt.currentQuestion?.status==='paused')return {intent:'resume_answer',target_id:rt.activeQuestionId};
    if(rt.bookmark)return {intent:'resume_lecture'};
    return {intent:'clarify',clarification:'你想继续哪一个问题，还是开始汇报？'};
  }
  if(/^(嗯|嗯嗯|好|好的|明白了|知道了|对|对的)$/.test(q))return {intent:'ack'};
  const action=commandRoute(q,rt.project,rt.view);if(action?.clarify)return {intent:'clarify',clarification:action.text,confirmationActions:action.confirmationActions,confirmedText:action.confirmedText};if(action?.actions)return {intent:'image',actions:action.actions,text:action.text};
  if(awaiting?.kind==='repeat')return {intent:'restated',target_id:awaiting.targetId};
  // 无模型时仅匹配明确的题目名称，不把模糊话语伪装成语义理解。
  match=q.match(/^先(?:回答|讲|说)(.+?)(?:的问题|问题)?$/);
  if(match){const hits=rt.questions.filter(x=>!['done','skipped','repeat'].includes(x.status)&&x.text.includes(match[1]));if(hits.length===1)return {intent:'select',target_id:hits[0].id};}
  return null;
}
/** Voice owns turn coordination; Runtime retains presentation and answer bookmarks. */
export class VoiceDialogue {
  constructor(runtime,{onState=()=>{},onStop=()=>{},online=()=>false}={}){this.rt=runtime;this.onState=onState;this.onStop=onStop;this.online=online;this.enabled=false;this.turn=0;this.awaiting=null;this.fragment='';}
  start(){this.enabled=true;this.awaiting=null;this.fragment='';this.rt.voiceMode=true;this.onState('正在聆听');}
  stop(){this.enabled=false;++this.turn;this.routeController?.abort();this.rt.voiceMode=false;this.rt.cancel('paused');this.awaiting=null;this.fragment='';this.onState('语音会话已结束');}
  speechStart(){
    if(!this.enabled)return;++this.turn;this.routeController?.abort();
    // 只暂停输出；持续麦克风由独立会话管理，不能跟着 Runtime.cancel 关闭。
    if(this.rt.main||this.rt.currentQuestion?.status==='answering'||this.rt.caption)this.interrupted={main:this.rt.main,questionId:this.rt.currentQuestion?.status==='answering'?this.rt.activeQuestionId:null,caption:this.rt.caption};
    this.rt.cancel(this.rt.humanControl?'takeover':'listening');this.onState('正在听，请说');
  }
  async say(text){
    if(!this.enabled||this.rt.humanControl)return;
    const n=this.rt.cancel('thinking');this.rt.ui.message('assistant',text);this.onState('正在协调');
    try{await this.rt.speak(text,n);if(this.rt.epoch.current(n)){this.rt.caption='';this.rt.state('paused');this.onState('正在聆听');}}catch(e){if(e.name!=='AbortError')this.rt.fail(e,n);}
  }
  async unclear(){
    if(!this.enabled)return;
    let q=this.rt.questions.find(q=>q.status==='repeat');
    if(!q){q={id:++this.rt.questionSequence,text:'未听清的提问',status:'repeat',parts:[],delivered:[],complete:false,source:'语音待确认',view:null};this.rt.questions.push(q);}
    this.awaiting={kind:'repeat',targetId:q.id};this.rt.emit();await this.say('这句话我没听清，请再说一遍。');
  }
  async resumeInterrupted(){
    const previous=this.interrupted;this.interrupted=null;
    if(this.rt.humanControl)return;
    if(previous?.questionId)return this.answer(previous.questionId);
    if(previous?.main)return this.rt.resume(true);
    this.rt.state('paused');this.onState('正在聆听');
  }
  async classify(text,signal){
    const response=await fetch('/api/dialogue',{method:'POST',headers:{'Content-Type':'application/json','X-IP-Presenter':'1'},body:JSON.stringify({text,questions:this.rt.questions.filter(q=>!['done','skipped'].includes(q.status)).slice(-20).map(({id,text,status})=>({id,text,status})),active_id:this.rt.activeQuestionId,awaiting:JSON.stringify(this.awaiting||{}),view:this.rt.view}),signal});
    if(!response.ok)throw Error('语义判断暂时不可用');return response.json();
  }
  async accept(text,{defer=false}={}){
    if(!this.enabled)return;text=text.trim().slice(0,2000);if(!text)return this.unclear();
    const generation=this.turn,rt=this.rt,epoch=this.rt.epoch.number;
    this.onState('正在理解');rt.note('语音',text);
    if(this.utteranceEndAt)rt.note('耗时',`转写完成 ${Math.round(performance.now()-this.utteranceEndAt)} ms（含句末停顿等待）`);
    let plan=localVoiceIntent(text,rt,this.awaiting);
    // 只过滤明显的自身回声；短控制词永远不被这条规则吞掉。
    const normal=s=>(s||'').replace(/[\s，。！？!?]/g,'');
    if(!plan&&normal(text).length>=8&&normal(this.interrupted?.caption).includes(normal(text))){rt.note('语音','忽略与刚才播放内容一致的疑似回声。');return this.resumeInterrupted();}
    if(this.fragment&&!plan){text=(this.fragment+' '+text).slice(0,2000);this.fragment='';plan=null;}
    // Clear standalone questions need an answer, not an extra model classification.
    // Keep compound turns, unfinished fragments and queued-question decisions on the semantic path.
    if(!plan&&!this.awaiting&&!this.fragment&&!rt.questions.some(q=>!['done','skipped'].includes(q.status))&&/(?:为什么|为何|如何|怎样|有什么|有没有|是否|哪些|什么|多少|能否证明|[吗呢][？?。！!]*$)/.test(text)&&!/(?:还有|另外|其次|同时|以及)/.test(text)&&(text.match(/[？?]/g)||[]).length<=1)plan={intent:'new'};
    if(!plan&&this.online()){
      this.routeController=new AbortController();const controller=this.routeController;const timer=setTimeout(()=>controller.abort(),10000);
      try{plan=await this.classify(text,this.routeController.signal);}catch(e){if(!this.enabled||generation!==this.turn)return 'retry';await this.say('我没能确认刚才的意思，请再说一遍。');return;}finally{clearTimeout(timer);}
    }
    if(!this.enabled||generation!==this.turn)return 'retry';
    if(rt.epoch.number!==epoch)return;
    if(!plan){
      if(/^(那|还有|另外|不是|也|对)[，,\s]/.test(text)&&rt.currentQuestion?.status==='paused')plan={intent:'clarify',clarification:'这是补充刚才的问题，还是一个新问题？请完整说一下。'};
      else plan={intent:'new'};
    }
    this.lastIntent=plan.intent;
    if(plan.intent==='greeting')return this.say('你好，我能听到。你可以说开始汇报，或者直接问我关于这个项目的问题。');
    if(plan.intent==='stop_session'){this.onStop();return;}
    if(plan.intent==='takeover'){this.fragment='';rt.takeover();this.onState('作者接管 · 仍可听到恢复指令');return;}
    if(plan.intent==='ack'){if(this.awaiting)return this.say('请说先回答哪一题，或者说继续汇报。');return defer?undefined:this.resumeInterrupted();}
    if(plan.intent==='pause'){this.fragment='';this.awaiting=null;rt.cancel(rt.humanControl?'takeover':'paused');this.onState('已暂停，仍在聆听');return;}
    if(plan.intent==='repeat')return this.unclear();
    if(plan.intent==='incomplete'){this.fragment=text;this.onState('请继续说');return;}
    if(plan.intent==='clarify'){if(plan.release)rt.humanControl=false;this.awaiting=plan.confirmationActions?{kind:'picture',actions:plan.confirmationActions,text:plan.confirmedText}:{kind:'clarify',text};return this.say(plan.clarification||'请明确说一下你想先讨论哪个问题。');}
    if(plan.intent==='resume_lecture'||plan.intent==='start_lecture'){
      const pending=rt.questions.some(q=>!['done','skipped'].includes(q.status));
      if(pending&&!plan.confirmed&&this.awaiting?.kind!=='main'){rt.humanControl=false;this.awaiting={kind:'main'};return this.say('还有没回答完的问题，先保留这些问题，继续汇报，可以吗？');}
      this.awaiting=null;rt.humanControl=false;this.onState('主讲中 · 可以直接打断');return plan.intent==='start_lecture'?rt.startLecture(Math.max(0,rt.project.slides.findIndex(s=>s.id===rt.view.main.imageId)),null,true):rt.resume(true);
    }
    if(plan.intent==='image'){
      this.awaiting=null;await rt.manual(plan.actions);if(generation===this.turn&&!rt.humanControl)await this.say(plan.text||'已调整。');return;
    }
    const targetId=plan.target_id??rt.activeQuestionId;
    const target=rt.questions.find(q=>q.id===targetId&&!['done','skipped','repeat'].includes(q.status));
    if(['select','resume_answer'].includes(plan.intent)){if(!target)return this.say('没有找到对应的待答问题。请说第几题，或者说继续汇报。');this.awaiting=null;return this.answer(target.id);}
    if(plan.intent==='skip'){if(!target)return this.say('请说要跳过第几题。');rt.skipQuestion(target.id);this.awaiting=null;return this.say('这题先跳过。');}
    if(['supplement','correction','restated'].includes(plan.intent)){
      if(plan.intent!=='restated'&&!target)return this.say('没有确定要修改哪一个问题，请完整重说。');
      await rt.ask(text,performance.now(),{kind:plan.intent==='restated'?'repeat':plan.intent,targetId,source:'持续语音'});this.awaiting=null;
      if(!defer&&!rt.humanControl)return this.answer(targetId);return;
    }
    if(plan.intent!=='new')return this.say('请再明确说一下你的问题。');
    const questions=plan.questions?.length?plan.questions:[text];const old=rt.questions.find(q=>q.id===rt.activeQuestionId&&q.status==='paused');
    const held=rt.humanControl;
    // 用现有入口登记但暂不自动播放；所有选择都通过下一句口头协调完成。
    for(const question of questions){if(typeof question!=='string'||!question.trim()||question.length>2000)continue;rt.questions.push({id:++rt.questionSequence,text:question.trim(),status:'queued',parts:[],delivered:[],complete:false,view:clone(rt.view),source:'持续语音'});}rt.emit();
    const added=rt.questions.slice(-questions.length);rt.state(held?'takeover':'paused');
    if(held){this.onState('作者接管 · 提问已记下');return;}
    if(defer)return;
    if(questions.length>1||old){this.awaiting={kind:'choose',oldId:old?.id??added[0].id,newId:added.at(-1).id};return this.say(`我记下了${old?'新的问题':'几个问题'}。先回答第${this.awaiting.oldId}题，还是第${this.awaiting.newId}题？`);}
    return this.answer(added[0].id);
  }
  async answer(id){
    if(!this.enabled)return;const turn=this.turn;this.awaiting=null;this.onState('正在回答 · 可以直接打断');
    const startAt=this.utteranceEndAt??performance.now();this.utteranceEndAt=null;
    await this.rt.answerQuestion(id,startAt);
    if(!this.enabled||turn!==this.turn||this.rt.humanControl||this.rt.currentQuestion?.status!=='done')return;
    const pending=this.rt.questions.filter(q=>!['done','skipped','repeat'].includes(q.status));
    this.onState('正在聆听');
    if(pending.length){this.awaiting={kind:'choose',oldId:pending[0].id,newId:pending.at(-1).id};await this.say(`第${pending[0].id}题还没回答完。要继续回答，还是继续汇报？`);}
  }
  async acceptBatch(texts){
    if(texts.length===1)return this.accept(texts[0]);
    for(let i=0;i<texts.length;i++){const result=await this.accept(texts[i],{defer:true});if(result==='retry')return {retry:texts.slice(i)};if(!this.enabled)return;}
    if(this.rt.humanControl||!['new','supplement','correction','restated'].includes(this.lastIntent))return;
    const pending=this.rt.questions.filter(q=>!['done','skipped','repeat'].includes(q.status));
    if(pending.length===1)return this.answer(pending[0].id);
    if(pending.length>1){this.awaiting={kind:'choose',oldId:pending[0].id,newId:pending.at(-1).id};return this.say(`我听到了接连的提问。先回答第${pending[0].id}题，还是第${pending.at(-1).id}题？也可以直接说问题的主题。`);}
  }
}
