import {clone,clamp,validateProject,freshView} from './core.js?v=public-core-2';
import {makeDemo} from './demo.js?v=public-core-2';
import {installDemoAvatar} from './demo-avatar.js?v=public-core-2';
import {Stage} from './stage.js?v=public-core-2';
import {Runtime} from './runtime.js?v=public-core-2';
import {Recorder} from './audio.js?v=public-core-2';
import {VoiceSession} from './voice-session.js?v=public-core-2';
import {QwenSession} from './qwen-session.js?v=public-core-2';
import {storage,download,loadImage} from './storage.js?v=public-core-2';
const $=s=>document.querySelector(s);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uid=()=>globalThis.crypto?.randomUUID?.()||Date.now().toString(36)+Math.random().toString(36).slice(2);
const labels={idle:'待机',preparing:'准备讲解',speaking:'讲解中',captioning:'字幕预览',listening:'正在录音',thinking:'准备回答',paused:'暂停 / 等待追问',takeover:'作者接管',error:'等待处理'};
let toastTimer,saveTimer,healthTimer,saveQueue=Promise.resolve(),messageCounter=0,editingSlide=null,editorSave=null,editorDelete=null,service=null,recorder=new Recorder();
function toast(text,type=''){clearTimeout(toastTimer);$('#toast').textContent=text;$('#toast').className='toast '+type;$('#toast').hidden=false;toastTimer=setTimeout(()=>$('#toast').hidden=true,6500);}
async function boot(){
  const projectKey='current';
  let project;try{const saved=await storage(undefined,projectKey);project=saved?validateProject(saved):makeDemo();}catch{project=makeDemo();}
  if((!project.avatar&&!project.avatarSelection)||project.avatarSelection==='demo-static')installDemoAvatar(project);
  const audience=new URLSearchParams(location.search).get('audience')==='1';const channelName=new URLSearchParams(location.search).get('channel')||uid();
  const channel=typeof BroadcastChannel==='function'&&location.protocol!=='file:'?new BroadcastChannel('ip-presenter-'+channelName):null;let mirrorEpoch=new AbortController(),revision=0,motionSequence=0,lastMotionSequence=-1,motionWatchdog;
  const stage=new Stage($('#stage'),phase=>{if(audience)return;if(phase==='begin')runtime.cancel('paused');else{runtime.view=stage.snapshot();runtime.emit();}});
  await stage.restore(freshView(project.slides[0].id),project);
  const ui={
    audioFrame(frame){if(!audience)channel?.postMessage({type:'audio-frame',sequence:++motionSequence,frame});},
    hearing(value){if(!audience)channel?.postMessage({type:'hearing',value});},
    update(rt){stage.setStatus(rt.status,rt.caption);$('#status-label').textContent=labels[rt.status]||rt.status;$('#audio-label').textContent=rt.settings.audio==='qwen'?'千问固定音色 · Tina':rt.settings.audio==='silent'?'仅字幕，没有声音':rt.settings.audio==='cloud'?(service?.runtime==='local'?'本机中文声音 · 婷婷':'在线合成 · 固定音色'):'浏览器系统声音';$('#zoom-value').textContent=Math.round((rt.view?.main.scale||1)*100)+'%';$('#bookmark-status').textContent=rt.bookmark?`已保留第 ${rt.bookmark.slide+1} 页，第 ${rt.bookmark.sentence+1} 句`:rt.main?`主讲 · 第 ${rt.position.slide+1} 页，第 ${rt.position.sentence+1} 句`:'尚无主讲书签';$('#metric').textContent=rt.metric?`首段声音（客户端）：${(rt.metric/1000).toFixed(2)} s`:'首段声音：尚无测量';
      const selected=rt.view?.main.imageId;for(const b of document.querySelectorAll('.slide-item'))b.classList.toggle('active',b.dataset.id===selected);
      if(editingSlide!==selected){editingSlide=selected;refreshScript();}
      $('#logs').replaceChildren(...rt.log.slice(0,30).map(row=>{const d=document.createElement('div');d.className='log-row';d.textContent=`${row.time} [${row.type}] ${row.text}`;return d;}));
      renderQuestions(rt);
      if(!audience)channel?.postMessage({type:'state',revision:++revision,view:rt.view,status:rt.status,caption:rt.caption});
    },
    message(role,text){if(role==='assistant')$('#live-answer').textContent=text;const id='m'+(++messageCounter),d=document.createElement('div');d.className='message '+role;d.id=id;const label=document.createElement('div');label.className='message-label';label.textContent=role==='user'?'你 / 提问':'IP / '+(runtime.settings.mode==='qwen'?'千问实时回答':runtime.settings.mode==='demo'?'规则答复':service?.runtime==='local'?'本机回答':'在线答复');const content=document.createElement('div');content.className='message-text';content.textContent=text;d.append(label,content);$('#messages').append(d);$('#messages').scrollTop=$('#messages').scrollHeight;return id;},
    updateMessage(id,text){$('#live-answer').textContent=text;const el=document.getElementById(id)?.querySelector('.message-text');if(el)el.textContent=text;$('#messages').scrollTop=$('#messages').scrollHeight;},
    confirmLecture(){return confirm('还有未完成的问题。暂存问题队列并继续主讲？');},
    waiting(text){$('#waiting').textContent=text;$('#waiting').hidden=!text;},toast,
    cancelRecorder(){recorder.cancel();$('#record').classList.remove('recording');$('#record').textContent='● 点击录音';}
  };
  const runtime=new Runtime(project,stage,ui);
  let qwenConfig=null,voiceStarting=false;
  const voiceCallbacks={
    online:()=>runtime.settings.mode==='online',
    onState:text=>{for(const el of document.querySelectorAll('[data-voice-status]'))el.textContent=text;},
    onLevel:level=>{$('#mic-level').style.width=Math.min(100,level*1200)+'%';},
    onHeard:text=>{$('#last-heard').textContent='听到：'+text;},
    onEnabled:active=>{if(!active)$('#mic-level').style.width='0';document.body.classList.toggle('voice-active',active);$('#voice-start').disabled=active;$('#voice-stop').hidden=!active;$('#voice-engine').disabled=active;$('#record').disabled=active;$('#qwen-open').disabled=active;$('#answer-mode').value=runtime.settings.mode;$('#audio-mode').value=runtime.settings.audio;if(!active&&$('#voice-engine').value==='qwen'){$('#mode-badge').textContent='千问 · 待开启';$('#footer-mode').textContent='千问语音 · 未开启麦克风';}updateVoiceReadiness();}
  };
  let voiceSession=new VoiceSession(runtime,voiceCallbacks);
  function updateVoiceReadiness(){
    const engine=$('#voice-engine').value;
    $('#qwen-open').hidden=engine!=='qwen';
    if(engine==='qwen'){
      $('#voice-readiness').textContent=qwenConfig?.configured?'千问密钥已保存。开启后持续语音交流，音频和审核资料将发送至千问。':'先点“配置千问”，填写你刚创建的密钥。完成一次配置后就可以直接说话。';
      $('#voice-start').disabled=voiceStarting||voiceSession.running||!qwenConfig?.configured;
      return;
    }
    const missing=[!service?.asr&&'语音识别',!service?.llm&&'语言模型',!service?.tts&&'固定音色'].filter(Boolean);
    const browserAvailable=!!(window.SpeechRecognition||window.webkitSpeechRecognition);
    $('#voice-readiness').textContent=engine==='server'?(missing.length?'等待服务：'+missing.join('、')+'。请从“启动数字人.command”启动。':service?.runtime==='local'?'本机识别、问答和中文声音已连接。开启后直接说话，不用逐条点击。':'配置已就绪，连接与真人效果仍待验证。'):(browserAvailable?'浏览器试运行：受浏览器服务限制；未配置模型时仅规则答复。':'当前浏览器没有识别引擎，请使用本机语音。');
    $('#voice-start').disabled=voiceStarting||voiceSession.running||(engine==='server'?missing.length>0:!browserAvailable);
  }
  function chooseVoiceEngine(){
    if(voiceSession.running)return;
    const engine=$('#voice-engine').value;
    if(engine==='qwen'){
      runtime.settings.mode='qwen';runtime.settings.audio='qwen';
      $('#mode-badge').textContent='千问 · 待开启';$('#footer-mode').textContent='千问语音 · 未开启麦克风';
    }else if(engine==='server'&&service?.llm&&service?.tts){
      runtime.settings.mode='online';runtime.settings.audio='cloud';runtime.settings.hardTimeout=20;
      $('#mode-badge').textContent=service.runtime==='local'?'本机 AI · 已连接':'在线服务';$('#footer-mode').textContent=service.runtime==='local'?'本机识别与问答':'在线服务';
    }else{
      runtime.settings.mode='demo';runtime.settings.audio='system';$('#mode-badge').textContent='规则演示';$('#footer-mode').textContent='浏览器试运行';
    }
    $('#answer-mode').value=runtime.settings.mode;$('#audio-mode').value=runtime.settings.audio;runtime.emit();updateVoiceReadiness();
  }
  $('#voice-engine').onchange=chooseVoiceEngine;
  const voiceConsent=new Set();
  $('#voice-start').onclick=async()=>{
    if(voiceStarting||voiceSession.running)return;
    const engine=$('#voice-engine').value;
    await runtime.audio.unlock();
    if(engine==='qwen'&&!qwenConfig?.configured){$('#qwen-open').click();return;}
    if(engine==='server'&&(!service?.asr||!service?.llm||!service?.tts))return toast('正式语音需要配置识别、模型和固定音色服务。设置里可以查看缺少哪项。浏览器试运行可单独选择。','error');
    const disclosure=engine==='qwen'?'会话期间将持续发送麦克风声音、已审核知识卡及当前讲稿到千问，并按官方平台用量计费。本机不保存录音；可以随时结束会话。':engine==='server'?(service.runtime==='local'?'将持续使用麦克风，语音识别、问答和声音生成都在这台 Mac 上完成；录音不会上传云端，也不会保存。':`持续拾音后，有声音的片段会自动发送到已配置的识别服务（${service.audio_destination||'服务端配置'}）；回答使用已配置模型与音色。`):'浏览器语音试运行可能将声音发送给浏览器厂商的识别服务；无模型配置时只能使用示例规则回答。';
    let consent=voiceConsent.has(engine);try{consent=consent||!!sessionStorage.getItem('ip-continuous-consent-'+engine);}catch{}
    if(!consent){if(!confirm(disclosure+'是否开启？'))return;voiceConsent.add(engine);try{sessionStorage.setItem('ip-continuous-consent-'+engine,'1');}catch{}}
    if(engine==='server'){
      runtime.settings.mode='online';runtime.settings.audio='cloud';$('#answer-mode').value='online';$('#audio-mode').value='cloud';$('#mode-badge').textContent=service.runtime==='local'?'本机 AI · 语音交互':'在线语音';$('#footer-mode').textContent=service.runtime==='local'?'本机识别与问答':'在线语音';
    }else if(runtime.settings.audio==='silent'){runtime.settings.audio='system';$('#audio-mode').value='system';}
    try{
      voiceStarting=true;voiceSession=engine==='qwen'?new QwenSession(runtime,voiceCallbacks):new VoiceSession(runtime,voiceCallbacks);
      $('#voice-start').disabled=true;
      if(engine==='server'&&service.runtime==='local'){
        $('#voice-readiness').textContent='正在唤醒本机模型，首次启动请稍候…';
        const response=await fetch('/api/warmup',{method:'POST',headers:{'X-IP-Presenter':'1'},signal:AbortSignal.timeout(65000)});
        if(!response.ok)throw Error('本机模型启动失败，请检查启动窗口后重试。');
      }
      await voiceSession.start({engine,endMs:Number($('#voice-silence').value),threshold:Number($('#voice-threshold').value)});
      if(engine==='qwen'&&voiceSession.running){$('#answer-mode').value='qwen';$('#audio-mode').value='qwen';$('#mode-badge').textContent='千问 · 实时语音';$('#footer-mode').textContent='千问实时语音';runtime.emit();}
    }catch(e){toast(e.message,'error');}finally{voiceStarting=false;updateVoiceReadiness();}
  };
  async function loadQwenConfig(){
    if(location.protocol==='file:')return;
    try{const r=await fetch('/api/qwen/config',{signal:AbortSignal.timeout(5000)});if(r.ok)qwenConfig=await r.json();}catch{}
    updateVoiceReadiness();
  }
  $('#qwen-open').onclick=()=>{
    $('#qwen-key').value='';$('#qwen-key').required=!qwenConfig?.configured;
    $('#qwen-key').placeholder=qwenConfig?.configured?'已保存；留空继续使用原密钥':'粘贴 API Key（只保存在这台电脑）';
    $('#qwen-workspace').value=qwenConfig?.workspace||'';$('#qwen-region').value=qwenConfig?.region||'beijing';
    $('#qwen-result').textContent=qwenConfig?.configured?'密钥已保存，可重新检查连接或更换。':'这里只检查连接，不开启麦克风。';
    $('#qwen-forget').hidden=!qwenConfig?.configured;$('#qwen-dialog').showModal();
  };
  $('#qwen-close').onclick=()=>$('#qwen-dialog').close();
  $('#qwen-form').onsubmit=async event=>{
    event.preventDefault();const button=$('#qwen-save');button.disabled=true;$('#qwen-forget').disabled=true;button.textContent='正在检查…';
    $('#qwen-result').textContent='正在验证密钥、业务空间和实时模型权限…';
    try{
      const r=await fetch('/api/qwen/config',{method:'POST',headers:{'Content-Type':'application/json','X-IP-Presenter':'1'},
        body:JSON.stringify({api_key:$('#qwen-key').value.trim(),workspace:$('#qwen-workspace').value.trim(),region:$('#qwen-region').value}),signal:AbortSignal.timeout(35000)});
      const data=await r.json();if(!r.ok)throw Error(data.detail||'连接检查未通过。');
      qwenConfig=data;$('#qwen-key').value='';$('#qwen-key').required=false;$('#qwen-forget').hidden=false;
      $('#qwen-result').textContent='连接通过，密钥已保存在本机。关闭这个窗口，点击“开启语音会话”即可。';
      updateVoiceReadiness();toast('千问连接检查通过，可以开启语音会话。');
    }catch(error){$('#qwen-result').textContent=error.name==='TimeoutError'?'连接检查超时，请核对网络、空间 ID 和地域。':error.message;}
    finally{button.disabled=false;$('#qwen-forget').disabled=false;button.textContent='保存并检查连接';}
  };
  $('#qwen-forget').onclick=async()=>{
    const r=await fetch('/api/qwen/forget',{method:'POST',headers:{'X-IP-Presenter':'1'}});if(!r.ok)return toast('未能清除密钥，请重试。','error');
    qwenConfig=await r.json();$('#qwen-key').value='';$('#qwen-key').required=true;$('#qwen-forget').hidden=true;$('#qwen-result').textContent='本机已清除密钥。';updateVoiceReadiness();
  };
  loadQwenConfig();
  $('#voice-stop').onclick=$('#present-voice-stop').onclick=()=>voiceSession.stop();
  // Exposes read-only debug snapshots, never credentials. Useful for repeatable UI testing.
  window.ipPresenter={snapshot:()=>({status:runtime.status,view:clone(runtime.view),character:clone(project.character),bookmark:clone(runtime.bookmark),epoch:runtime.epoch.number,questions:clone(runtime.questions),activeQuestionId:runtime.activeQuestionId,voiceActive:voiceSession.running,voiceAwaiting:clone(voiceSession.dialogue.awaiting),metric:runtime.metric,log:clone(runtime.log)}),version:'0.6.0'};
  let queueSignature='';
  function renderQuestions(rt){
    const signature=JSON.stringify(rt.questions.map(q=>[q.id,q.text,q.status,q.delivered.length,q.parts.length,q.complete,q.source]));
    if(signature===queueSignature)return;queueSignature=signature;
    const pending=rt.questions.filter(q=>!['done','skipped'].includes(q.status));
    $('#question-count').textContent=pending.length;
    const stateNames={queued:'待回答',answering:'正在回答',paused:'已暂停',repeat:'待重说',done:'已完成',skipped:'已跳过'};
    $('#question-queue').replaceChildren();
    for(const q of [...pending,...rt.questions.filter(q=>['done','skipped'].includes(q.status)).slice(-3)]){
      const row=document.createElement('article');row.className='question-row';row.dataset.questionId=q.id;
      const title=document.createElement('strong');title.textContent=`第 ${q.id} 题 · ${stateNames[q.status]}`;
      const text=document.createElement('p');text.textContent=q.text;
      const detail=document.createElement('small');detail.textContent=`${q.source} · 已完成 ${q.delivered.length} 段`+(q.status==='paused'?(q.complete?' · 可从未播完句子继续':' · 需重新组织剩余回答'):'');
      row.append(title,text,detail);
      if(!['done','skipped'].includes(q.status)){
        const actions=document.createElement('div');actions.className='question-actions';
        const button=(label,action)=>{const b=document.createElement('button');b.type='button';b.textContent=label;b.onclick=action;actions.append(b);return b;};
        if(q.status!=='repeat')button(q.status==='paused'?'继续此题':'先回答',()=>runtime.settings.mode==='qwen'?toast(`请直接说“先回答第 ${q.id} 题”。`):runtime.answerQuestion(q.id)).disabled=q.status==='answering';
        button(q.status==='repeat'?'填写重说内容':'补充 / 纠正',()=>{$('#question-kind').value=q.status==='repeat'?'repeat':'supplement';updateQuestionTargets(q.id);$('#question').focus();});
        button('跳过',()=>runtime.skipQuestion(q.id));row.append(actions);
      }
      $('#question-queue').append(row);
    }
    if(!rt.questions.length){const empty=document.createElement('p');empty.className='queue-note';empty.textContent='听清的问题会显示在这里。';$('#question-queue').append(empty);}
    updateQuestionTargets();
  }
  function updateQuestionTargets(preferred){
    const kind=$('#question-kind').value,select=$('#question-target'),selected=String(preferred??select.value);
    $('#question-target-label').hidden=kind==='new';select.replaceChildren();
    const placeholder=document.createElement('option');placeholder.value='';placeholder.textContent='请选择问题';select.append(placeholder);
    for(const q of runtime.questions.filter(q=>!['done','skipped'].includes(q.status)&&(kind==='repeat'?q.status==='repeat':q.status!=='repeat'))){
      const o=document.createElement('option');o.value=q.id;o.textContent=`第 ${q.id} 题：${q.text.slice(0,24)}`;select.append(o);
    }
    if([...select.options].some(o=>o.value===selected))select.value=selected;
  }
  function inputOptions(source='文字输入'){return {kind:$('#question-kind').value,targetId:$('#question-target').value,source};}
  $('#question-kind').onchange=()=>updateQuestionTargets();
  $('#request-repeat').onclick=()=>{runtime.requestRepeat();$('#question-kind').value='repeat';updateQuestionTargets(runtime.questions.find(q=>q.status==='repeat')?.id);};
  function fitStage(){const holder=$('.stage-holder'),r=holder.getBoundingClientRect(),w=Math.max(1,Math.min(r.width,r.height*16/9));$('#stage').style.width=w+'px';$('#stage').style.height=w*9/16+'px';}
  const observer=new ResizeObserver(fitStage);observer.observe($('.stage-holder'));window.addEventListener('resize',fitStage);
  function broadcastProject(){channel?.postMessage({type:'project',project});}
  function clearSession(){$('#live-answer').textContent='';$('#last-heard').textContent='听到的话会显示在这里。';if(voiceSession.running)voiceSession.stop();$('#question-kind').value='new';runtime.clearQuestions();runtime.humanControl=false;runtime.history=[];runtime.log=[];runtime.metric=null;runtime.bookmark=null;ui.waiting('');$('#messages').innerHTML='<div class="welcome-note"><span>i</span><p>当前项目已载入。问答只使用当前项目的审核材料；请先检查讲稿和知识卡。</p></div>';messageCounter=0;}
  function save(){if(voiceSession.running&&voiceSession instanceof QwenSession){voiceSession.stop();toast('资料已修改；重新开启语音会话后会使用新资料。');}clearTimeout(saveTimer);$('#save-state').textContent='保存中…';saveTimer=setTimeout(()=>{const copy=clone(project);saveQueue=saveQueue.catch(()=>{}).then(()=>storage(copy,projectKey)).then(()=>{$('#save-state').textContent='已保存到此浏览器';}).catch(()=>{$('#save-state').textContent='本地保存失败，请导出';});broadcastProject();},400);}
  function refreshScript(){const s=project.slides.find(s=>s.id===runtime.view?.main.imageId);if(!s)return;$('#script-title').textContent=s.title;$('#script').value=s.script;$('#regions').replaceChildren();if(!s.regions.length){const span=document.createElement('span');span.textContent='还没有标记重点区域';$('#regions').append(span);}for(const r of s.regions){const b=document.createElement('button');b.textContent='⌖ '+r.name;b.onclick=()=>runtime.manual([{type:'focus_region',imageId:s.id,regionId:r.id}]);$('#regions').append(b);}}
  function renderProject(){
    $('#avatar-demo').textContent='▶ 试播人物与声音';$('#use-demo-avatar').textContent='恢复示例机器人';
    const welcome=$('.welcome-note p');if(welcome)welcome.textContent='请先检查当前项目的讲稿与知识卡。';
    runtime.project=project;stage.setProject(project);$('#project-note').textContent=project.note||'';$('#stage .scene-footnote').textContent='通用演示 · 可导入自己的材料';$('#project-name').value=project.name;$('#slide-count').textContent=String(project.slides.length).padStart(2,'0');$('#slides').replaceChildren();
    project.slides.forEach((s,i)=>{const b=document.createElement('button');b.className='slide-item';b.dataset.id=s.id;b.title=s.title;b.innerHTML=`<div class="slide-thumb"><img alt=""></div><div class="slide-meta"><span>${String(i+1).padStart(2,'0')}</span><span></span></div>`;b.querySelector('img').src=s.src;b.querySelector('.slide-meta span:last-child').textContent=s.title;b.onclick=()=>runtime.manual([{type:'show_image',imageId:s.id}]);$('#slides').append(b);});
    $('#avatar-status').textContent=project.avatarRig?'示例机器人 · 随声音开合嘴部':project.avatar?'静态图片 · 未配置动作素材':'尚未设置人物';
    const mini=$('.avatar-mini');mini.replaceChildren();if(project.avatar){const img=new Image();img.src=project.avatar;img.alt='已上传IP';mini.append(img);$('.avatar-upload strong').textContent='更换IP形象';}else{mini.textContent='IP';$('.avatar-upload strong').textContent='上传你的IP';}
    $('#char-x').value=project.character.x*100;$('#char-y').value=project.character.y*100;$('#char-scale').value=project.character.scale*100;
    document.querySelectorAll('[data-bg]').forEach(b=>b.classList.toggle('active',b.dataset.bg===project.background.kind));$('#custom-bg').classList.toggle('active',project.background.kind==='custom');renderKnowledge();refreshScript();runtime.emit();
  }
  function renderKnowledge(){const list=$('#knowledge-list');list.replaceChildren();for(const k of project.knowledge){const b=document.createElement('button');b.className='knowledge-item';b.style.width='100%';b.style.textAlign='left';b.innerHTML=`<strong></strong><p></p><small></small>`;b.querySelector('strong').textContent=k.title;b.querySelector('p').textContent=k.text;b.querySelector('small').textContent=(k.reviewed?(k.reviewBasis==='source'?'已核对原稿 · 非效果验证':'作者已审核'):'未审核 · 不参与回答')+' / '+({fact:'事实',decision:'设计理由',hypothesis:'延展假设',unknown:'未知边界'}[k.kind]);b.onclick=()=>openKnowledge(k);list.append(b);}}
  function openEditor(title,html,onSave,onDelete){runtime.cancel('paused');$('#editor-title').textContent=title;$('#editor-body').innerHTML=html;editorSave=onSave;editorDelete=onDelete;$('#delete-item').hidden=!onDelete;$('#editor').showModal();}
  function openSlide(){const s=project.slides.find(s=>s.id===runtime.view.main.imageId);openEditor('编辑演示材料',`<label class="field">图片标题<input id="e-title" value="${esc(s.title)}" maxlength="120" required></label><label class="field">该页讲稿<textarea id="e-script" maxlength="12000" rows="7">${esc(s.script)}</textarea></label><p class="small-note">主讲按完整句子推进。删除图片也会删除关联知识卡；至少保留一张图片。</p>`,()=>{s.title=$('#e-title').value.trim()||'未命名图片';s.script=$('#e-script').value;},project.slides.length>1?async()=>{project.slides=project.slides.filter(x=>x.id!==s.id);project.knowledge=project.knowledge.filter(k=>k.slideId!==s.id);runtime.bookmark=null;runtime.view=freshView(project.slides[0].id);await stage.restore(runtime.view,project);}:null);}
  function openKnowledge(existing){const k=existing?clone(existing):{id:uid(),title:'',keywords:[],kind:'decision',text:'',source:'',reviewed:false,slideId:runtime.view.main.imageId,regionId:''};
    const slides=project.slides.map(s=>`<option value="${esc(s.id)}" ${s.id===k.slideId?'selected':''}>${esc(s.title)}</option>`).join('');
    openEditor(existing?'编辑知识卡':'新建知识卡',`<div class="two-fields"><label class="field">主题<input id="k-title" value="${esc(k.title)}" maxlength="120" required placeholder="例如：为什么选择示例图表"></label><label class="field">内容类型<select id="k-kind">${[['fact','项目事实'],['decision','设计理由'],['hypothesis','延展假设'],['unknown','未知边界']].map(([v,t])=>`<option value="${v}" ${k.kind===v?'selected':''}>${t}</option>`).join('')}</select></label></div><label class="field">关键词（用逗号分隔，规则模式依此匹配）<input id="k-keywords" value="${esc(k.keywords.join('，'))}" placeholder="图表，图形，金丝"></label><label class="field">可用于回答的内容<textarea id="k-text" maxlength="12000" rows="5" required>${esc(k.text)}</textarea></label><label class="field">来源 / 边界说明<input id="k-source" value="${esc(k.source)}" maxlength="500" placeholder="例如：作者设计说明第3节；尚无效果验证"></label><div class="two-fields"><label class="field">关联图片<select id="k-slide">${slides}</select></label><label class="field">聚焦区域<select id="k-region"></select></label></div><label class="checkbox-field"><input id="k-reviewed" type="checkbox" ${k.reviewed?'checked':''}>允许这条已核对的资料参与回答，事实、设想与未知边界需区分。</label><div class="hint-banner">未审核的卡片不会传给模型。上传图片不会自动提取其内容。</div>`,()=>{
      k.title=$('#k-title').value.trim();k.keywords=$('#k-keywords').value.split(/[,，、\n]/).map(s=>s.trim()).filter(Boolean);k.text=$('#k-text').value.trim();k.source=$('#k-source').value.trim();k.reviewed=$('#k-reviewed').checked;k.kind=$('#k-kind').value;k.slideId=$('#k-slide').value;k.regionId=$('#k-region').value;
      if(!k.title||!k.text)throw Error('请填写主题和内容。');if(k.reviewed&&!k.source)throw Error('审核前请补充来源或边界说明。');if(k.keywords.length>40)throw Error('关键词请控制在40个以内。');if(existing)project.knowledge=project.knowledge.map(x=>x.id===k.id?k:x);else project.knowledge.push(k);
    },existing?()=>project.knowledge=project.knowledge.filter(x=>x.id!==k.id):null);
    function regions(){const rs=project.slides.find(s=>s.id===$('#k-slide').value).regions;$('#k-region').innerHTML='<option value="">只展示全图</option>'+rs.map(r=>`<option value="${esc(r.id)}" ${r.id===k.regionId?'selected':''}>${esc(r.name)}</option>`).join('');}regions();$('#k-slide').onchange=regions;
  }
  function openRegions(){const s=project.slides.find(s=>s.id===runtime.view.main.imageId),regions=clone(s.regions);let box=null,start=null;
    openEditor('标记图片中的重点区域',`<div class="hint-banner">在原图上拖出一个矩形，然后命名并添加。这里只保存相对坐标，不裁切或拆分原图。</div><div class="region-editor-wrap"><img id="region-image" alt="要标记的图片"><div class="selection-box" hidden></div></div><div class="two-fields"><label class="field">区域名称<input id="region-name" maxlength="60" placeholder="例如：图表、标题"></label><div class="field"><span>选好区域后</span><button id="add-region" type="button" class="control-button">＋ 添加区域</button></div></div><div id="region-rows"></div>`,()=>{const deleted=s.regions.filter(r=>!regions.some(x=>x.id===r.id)).map(r=>r.id);s.regions=regions;project.knowledge.forEach(k=>{if(k.slideId===s.id&&deleted.includes(k.regionId))k.regionId='';});});
    $('#region-image').src=s.src;const wrap=$('.region-editor-wrap'),overlay=$('.selection-box');
    const point=e=>{const r=wrap.getBoundingClientRect();return{x:clamp((e.clientX-r.left)/r.width,0,1),y:clamp((e.clientY-r.top)/r.height,0,1)};};
    wrap.onpointerdown=e=>{start=point(e);box=null;wrap.setPointerCapture(e.pointerId);overlay.hidden=false;overlay.style.cssText=`left:${start.x*100}%;top:${start.y*100}%;width:0;height:0`;};
    wrap.onpointermove=e=>{if(!start)return;const p=point(e);box={x:Math.min(p.x,start.x),y:Math.min(p.y,start.y),w:Math.abs(p.x-start.x),h:Math.abs(p.y-start.y)};overlay.style.cssText=`left:${box.x*100}%;top:${box.y*100}%;width:${box.w*100}%;height:${box.h*100}%`;};wrap.onpointerup=()=>start=null;wrap.onpointercancel=()=>start=null;
    function rows(){$('#region-rows').replaceChildren();regions.forEach(r=>{const row=document.createElement('div');row.className='region-row';const name=document.createElement('span');name.textContent=r.name;const del=document.createElement('button');del.type='button';del.textContent='移除';del.onclick=()=>{regions.splice(regions.indexOf(r),1);rows();};row.append(name,del);$('#region-rows').append(row);});}rows();
    $('#add-region').onclick=()=>{const name=$('#region-name').value.trim();if(!name||!box||box.w<.01||box.h<.01)return toast('请先框选区域并填写名称。');if(regions.length>=20)return toast('每张图片最多标记20个区域。');regions.push({id:uid(),name,...box});box=null;overlay.hidden=true;$('#region-name').value='';rows();};
  }
  $('#editor-form').onsubmit=async e=>{e.preventDefault();try{await editorSave?.();validateProject(project);$('#editor').close();renderProject();save();toast('已保存修改。');}catch(e){toast(e.message,'error');}};
  $('#delete-item').onclick=async()=>{if(!confirm('确定删除？相关的关联数据也会调整。'))return;try{await editorDelete?.();$('#editor').close();renderProject();save();}catch(e){toast(e.message,'error');}};
  $('#close-editor').onclick=$('#cancel-editor').onclick=()=>$('#editor').close();
  $('#edit-slide').onclick=openSlide;$('#edit-regions').onclick=openRegions;$('#new-knowledge').onclick=()=>project.knowledge.length>=150?toast('第一版最多150张知识卡。'):openKnowledge();
  for(const b of document.querySelectorAll('[data-tab]'))b.onclick=()=>{document.querySelectorAll('[data-tab]').forEach(x=>x.classList.toggle('active',x===b));document.querySelectorAll('.tab-content').forEach(x=>x.hidden=x.id!=='tab-'+b.dataset.tab);};
  $('#script').oninput=()=>{if(runtime.main){runtime.cancel('paused');runtime.bookmark=null;}const s=project.slides.find(s=>s.id===runtime.view.main.imageId);if(s){s.script=$('#script').value.slice(0,12000);save();}};
  $('#project-name').onchange=()=>{project.name=$('#project-name').value.trim()||'我的IP项目';save();};
  $('#avatar-file').onchange=async e=>{const f=e.target.files[0];e.target.value='';if(!f)return;try{const src=await loadImage(f);runtime.cancel();project.avatar=src;delete project.avatarRig;project.avatarSelection='custom';renderProject();save();toast('IP已替换；没有自动建模或生成新动作。');}catch(e){toast(e.message,'error');}};
  $('#add-slides').onclick=()=>$('#slides-file').click();$('#slides-file').onchange=async e=>{const fs=[...e.target.files];e.target.value='';if(!fs.length)return;try{if(project.slides.length+fs.length>60)throw Error('第一版最多60张图片。');const added=[];for(const f of fs)added.push({id:uid(),title:f.name.replace(/\.[^.]+$/,'').slice(0,120),src:await loadImage(f),script:'',regions:[]});const replace=project.slides.every(s=>['intro','exploration','boundary'].includes(s.id))&&confirm('要用新图片替换全部占位素材和示例知识卡吗？“取消”会保留示例并追加。');runtime.cancel();runtime.bookmark=null;if(replace){clearSession();project.slides=added;project.knowledge=[];}else project.slides.push(...added);runtime.view=freshView(added[0].id);await stage.restore(runtime.view,project);renderProject();save();toast('图片已导入。请编辑讲稿，并补充知识卡。');}catch(e){toast(e.message,'error');}};
  $('#export-project').onclick=()=>{try{validateProject(project);download('IP演讲项目.ip-presenter.json',JSON.stringify(project,null,2));toast('已导出项目，包含图片、讲稿和知识卡，不包含密钥。');}catch(e){toast(e.message,'error');}};
  $('#import-project').onclick=()=>$('#project-file').click();$('#project-file').onchange=async e=>{const f=e.target.files[0];e.target.value='';if(!f)return;try{if(f.size>120*1024*1024)throw Error('项目包超过120MB。');const next=validateProject(JSON.parse(await f.text()));if(!confirm('载入这个项目并替换当前工作区？建议先导出当前项目。'))return;runtime.cancel();clearSession();project=next;runtime.project=project;runtime.view=freshView(project.slides[0].id);await stage.restore(runtime.view,project);renderProject();save();}catch(e){toast(e.message,'error');}};
  for(const b of document.querySelectorAll('[data-bg]'))b.onclick=()=>{project.background.kind=b.dataset.bg;project.background.color={midnight:'#101513',ink:'#050806',paper:'#eeeadd'}[b.dataset.bg];renderProject();save();};
  $('#custom-bg').onclick=()=>$('#background-file').click();$('#background-file').onchange=async e=>{const f=e.target.files[0];e.target.value='';if(!f)return;try{project.background.image=await loadImage(f);project.background.kind='custom';renderProject();save();}catch(e){toast(e.message,'error');}};
  for(const [id,key]of[['char-x','x'],['char-y','y'],['char-scale','scale']])$('#'+id).oninput=e=>{project.character[key]=Number(e.target.value)/100;stage.setProject(project);save();};
  $('#remove-avatar').onclick=()=>{runtime.cancel();project.avatar='';delete project.avatarRig;project.avatarSelection='none';renderProject();save();};
  $('#use-demo-avatar').onclick=()=>{runtime.cancel();installDemoAvatar(project);renderProject();save();};
  $('#zoom-in').onclick=()=>runtime.manual([{type:'adjust_view',factor:1.3}]);$('#zoom-out').onclick=()=>runtime.manual([{type:'adjust_view',factor:1/1.3}]);$('#reset-view').onclick=()=>runtime.manual([{type:'restore_view'}]);$('#compare-view').onclick=()=>runtime.ask('和另一版比较');
  $('#pause').onclick=$('#present-pause').onclick=()=>runtime.cancel('paused');$('#resume').onclick=$('#present-resume').onclick=()=>runtime.resume();$('#takeover').onclick=$('#present-takeover').onclick=()=>runtime.takeover();$('#start').onclick=()=>runtime.startLecture(project.slides.findIndex(s=>s.id===runtime.view.main.imageId));
  function debugAsk(text,options){if(runtime.settings.mode==='qwen')return toast('千问会话请直接说话；文字调试可切换到本机语音。');return runtime.ask(text,performance.now(),options);}
  $('#ask-form').onsubmit=e=>{e.preventDefault();const q=$('#question').value;$('#question').value='';debugAsk(q,inputOptions());};$('#question').onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();$('#ask-form').requestSubmit();}};for(const b of document.querySelectorAll('[data-question]'))b.onclick=()=>debugAsk(b.dataset.question);
  function present(value){document.body.classList.toggle('presenting',value);requestAnimationFrame(fitStage);}
  $('#present').onclick=()=>present(true);$('#exit-present').onclick=()=>present(false);$('#fullscreen').onclick=()=>{$('#stage').requestFullscreen?.().catch(()=>toast('浏览器未允许全屏。'));};
  $('#popout').onclick=()=>{if(!channel)return toast('独立观众窗口请从本地服务打开；单文件预览可以使用“进入演讲”。');const url=new URL(location.href);url.searchParams.set('audience','1');url.searchParams.set('channel',channelName);const w=window.open(url.href,'ip-presenter-audience');if(!w)toast('浏览器阻止了新窗口，请允许弹出。');};
  document.addEventListener('keydown',e=>{if(audience)return;if(e.key==='Escape'){if($('#qwen-dialog').open)return;runtime.cancel('paused');if(!$('#editor').open)present(false);}if(e.code==='Space'&&!/INPUT|TEXTAREA|SELECT|BUTTON/.test(e.target.tagName)&&!$('#editor').open){e.preventDefault();runtime.status==='speaking'||runtime.main?runtime.cancel('paused'):runtime.resume();}});
  async function health(){
    clearTimeout(healthTimer);
    if(location.protocol==='file:'){service=null;$('#service-status').textContent='请双击“启动数字人.command”开启语音；这个文件只用于界面预览。';updateVoiceReadiness();return;}
    try{
      const r=await fetch('/api/health',{signal:AbortSignal.timeout(5000)});if(!r.ok)throw Error();service=await r.json();
      $('#service-status').textContent=`${service.runtime==='local'?'本机服务':'在线适配服务'}已连接\n问答：${service.llm?'就绪':'未就绪'} / 识别：${service.asr?'就绪':'未就绪'} / 声音：${service.tts?'就绪':'未就绪'}\n${service.description}`;
      if(service.runtime==='local'){
        if(!service.llm||!service.asr||!service.tts)healthTimer=setTimeout(health,3000);
        $('#voice-engine option[value="server"]').textContent='本机语音（无需 API）';
        $('#answer-mode option[value="online"]').textContent='本机 AI 问答';
        $('#audio-mode option[value="cloud"]').textContent='本机中文声音 · 婷婷';
        if($('#voice-engine').value!=='qwen'&&!voiceSession.running&&runtime.settings.mode==='demo'&&service.llm&&service.asr&&service.tts){
          runtime.settings.mode='online';runtime.settings.audio='cloud';runtime.settings.hardTimeout=20;
          $('#answer-mode').value='online';$('#audio-mode').value='cloud';$('#timeout').value='20';
          $('#mode-badge').textContent='本机 AI · 已连接';$('#footer-mode').textContent='本机识别与问答';
          runtime.emit();
        }
      }
    }catch{service=null;$('#service-status').textContent='服务未连接，请双击“启动数字人.command”。';}
    updateVoiceReadiness();
  }
  $('#health-check').onclick=health;
  $('#answer-mode').onchange=e=>{if(e.target.value==='online'&&!service?.llm){e.target.value='demo';return toast('请先在服务端 .env 配置模型密钥和模型ID，再点击检查服务。');}if(voiceSession.running)voiceSession.stop();runtime.cancel();runtime.settings.mode=e.target.value;$('#mode-badge').textContent=e.target.value==='online'?(service?.runtime==='local'?'本机 AI · 已连接':'在线模型'):'规则演示';$('#mode-badge').classList.toggle('online',e.target.value==='online');$('#footer-mode').textContent=e.target.value==='online'?'在线问答 · 请核验答案':'规则演示';};
  $('#audio-mode').onchange=e=>{if(e.target.value==='cloud'&&!service?.tts){e.target.value=runtime.settings.audio;return toast('在线固定音色需要先配置后端语音服务。');}if(voiceSession.running)voiceSession.stop();runtime.cancel();runtime.settings.audio=e.target.value;runtime.emit();};
  function voices(){const previous=$('#system-voice').value;$('#system-voice').innerHTML='<option value="">系统默认中文声音</option>';for(const voice of window.speechSynthesis?.getVoices()||[]){const o=document.createElement('option');o.value=voice.voiceURI;o.textContent=voice.name+' / '+voice.lang;$('#system-voice').append(o);}$('#system-voice').value=previous;}
  voices();window.speechSynthesis?.addEventListener('voiceschanged',voices);$('#system-voice').onchange=e=>runtime.settings.voice=e.target.value;$('#outside').onchange=e=>{if(voiceSession.running&&voiceSession instanceof QwenSession)voiceSession.stop();runtime.settings.outside=e.target.checked;};$('#timeout').onchange=e=>{runtime.settings.hardTimeout=clamp(Number(e.target.value)||8,4,60);e.target.value=runtime.settings.hardTimeout;};
  $('#avatar-demo').onclick=$('#voice-test').onclick=async()=>{const n=runtime.cancel('preparing');try{await runtime.audio.unlock();await runtime.speak('你好，我是这个项目的讲解员。现在测试选定的声音。',n);if(runtime.epoch.current(n))runtime.state('paused');}catch(e){if(e.name!=='AbortError')runtime.fail(e,n);}};
  $('#record').onclick=async()=>{
    if(recorder.recorder){recorder.stop();return;}
    if(!service?.asr)return toast('点击录音需要在线识别服务。请先配置并检查后端；现在仍可用文字测试。');
    if(!sessionStorage.getItem('ip-audio-consent')){if(!confirm('录音片段会发送给后端配置的语音识别服务，不在本机保存原始音频。是否开始？'))return;sessionStorage.setItem('ip-audio-consent','1');}
    const recordingOptions=inputOptions('录音转写');const n=runtime.cancel('listening');$('#record').classList.add('recording');$('#record').textContent='■ 点击结束并识别';
    try{await recorder.start(async blob=>{const submitted=performance.now();if(!runtime.epoch.current(n))return;$('#record').classList.remove('recording');$('#record').textContent='识别中…';runtime.state('thinking');const timer=setTimeout(()=>{if(runtime.epoch.current(n)){runtime.takeover();toast('语音识别超时，已停止。','error');}},25000);
      try{const r=await fetch('/api/transcribe',{method:'POST',headers:{'Content-Type':blob.type,'X-IP-Presenter':'1'},body:blob,signal:runtime.epoch.controller.signal});const d=await r.json();if(!r.ok)throw Error(d.detail||'识别失败。');if(!runtime.epoch.current(n))return;clearTimeout(timer);$('#record').textContent='● 点击录音';if(!d.text?.trim())throw Error('没有识别到可用文字，请重说或输入文字。');runtime.note('识别',d.text);await runtime.ask(d.text,submitted,recordingOptions);
      }catch(e){if(e.name!=='AbortError')runtime.fail(e,n);}finally{clearTimeout(timer);}});
    }catch(e){if(runtime.epoch.current(n)){runtime.cancel('error');toast(e.message,'error');}}
  };
  $('#download-logs').onclick=()=>download('IP演讲调试记录.json',JSON.stringify({version:'0.1',recordedAt:new Date().toISOString(),notes:'仅客户端时间，不是Mac或实际扬声器端到端验收。可能包含提问转写，请谨慎分享。',log:runtime.log},null,2));
  $('#reset-project').onclick=async()=>{if(!confirm('重置会替换当前素材、讲稿和知识卡。请先导出备份。确定继续？'))return;runtime.cancel();clearSession();project=makeDemo();runtime.project=project;runtime.view=freshView(project.slides[0].id);await stage.restore(runtime.view,project);renderProject();save();toast('已恢复演示项目。');};
  channel?.addEventListener('message',async e=>{
    const msg=e.data;if(!msg||typeof msg!=='object')return;
    if(audience&&msg.type==='audio-frame'&&Number.isFinite(msg.sequence)&&msg.sequence>lastMotionSequence){lastMotionSequence=msg.sequence;stage.setSpeech(msg.frame||{active:false});clearTimeout(motionWatchdog);motionWatchdog=setTimeout(()=>stage.setSpeech({active:false}),250);return;}
    if(audience&&msg.type==='hearing'){stage.setHearing(msg.value===true);return;}
    if(!audience&&msg.type==='request'){broadcastProject();runtime.emit();return;}
    if(audience&&msg.type==='project'){try{project=validateProject(msg.project);stage.setProject(project);}catch{toast('收到无效项目数据。','error');}return;}
    if(audience&&msg.type==='state'&&msg.revision>=revision){revision=msg.revision;mirrorEpoch.abort();mirrorEpoch=new AbortController();try{await stage.restore(msg.view,project,mirrorEpoch.signal);stage.setStatus(msg.status,msg.caption);}catch(e){if(e.name!=='AbortError')toast('观众画面同步失败。','error');}}
  });
  renderProject();fitStage();if(audience){document.body.classList.add('audience-mode');present(true);$('#stage [data-stage-label]').textContent='IP讲解 · 观众画面';channel?.postMessage({type:'request'});$('#stage').title='音频由工作台窗口播放，避免双重声音。';}else{chooseVoiceEngine();health();}
  window.addEventListener('beforeunload',()=>{voiceSession.stop();recorder.cancel();runtime.audio.stop();stage.avatar.destroy();clearTimeout(motionWatchdog);channel?.close();});
}
boot().catch(e=>{console.error(e);toast('初始化失败：'+e.message,'error');});
