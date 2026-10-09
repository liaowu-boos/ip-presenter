import {clone,clamp,freshView,focusTransform} from './core.js?v=public-core-2';
import {abortError} from './audio.js?v=public-core-2';
import {Avatar} from './avatar.js?v=public-core-2';
export class Stage {
  constructor(element,onManual=()=>{}){this.el=element;this.onManual=onManual;this.view=null;this.animations=[];this.project=null;
    element.innerHTML=`<div class="scene-glow"></div><div class="scene-label"><span class="live-dot"></span><span data-stage-label>演讲预览</span></div><div class="material-space"><div class="material-frame main-frame" data-slot="main"><img alt="演示图片" draggable="false"></div><div class="material-frame second-frame" data-slot="secondary"><img alt="对比图片" draggable="false"></div></div><div class="character"><img class="character-image" alt="你上传的IP形象" draggable="false" hidden><div class="character-empty"><div class="ip-mark">IP</div><strong>你的形象，站在这里。</strong><span>上传一张定稿图片即可开始</span><small>不要求建模 · 当前为占位</small></div><div class="character-state"><span class="voice-bars"><i></i><i></i><i></i><i></i></span><span data-char-state>待机</span></div></div><div class="scene-caption" hidden></div><div class="scene-footnote">调试背景 · 非视觉定稿</div>`;
    const avatarElement=document.createElement('div');avatarElement.className='character-avatar';avatarElement.hidden=true;avatarElement.setAttribute('role','img');avatarElement.setAttribute('aria-label','示例机器人，随声音开合嘴部并眨眼');element.querySelector('.character').prepend(avatarElement);this.avatar=new Avatar(avatarElement);
    for(const frame of element.querySelectorAll('.material-frame')){
      let drag=null;
      frame.addEventListener('pointerdown',e=>{if(e.button!==0||element.closest('.audience-mode'))return;this.freeze();const slot=frame.dataset.slot;if(!this.view[slot])return;this.onManual('begin');drag={slot,x:e.clientX,y:e.clientY,view:clone(this.view[slot])};frame.setPointerCapture(e.pointerId);});
      frame.addEventListener('pointermove',e=>{if(!drag)return;const v=this.view[drag.slot];v.x=clamp(drag.view.x+(e.clientX-drag.x)/frame.clientWidth,-4,4);v.y=clamp(drag.view.y+(e.clientY-drag.y)/frame.clientHeight,-4,4);this.setTransform(frame.querySelector('img'),v);});
      const end=()=>{if(drag){drag=null;this.onManual('end');}};frame.addEventListener('pointerup',end);frame.addEventListener('pointercancel',end);
      frame.addEventListener('wheel',e=>{if(element.closest('.audience-mode'))return;e.preventDefault();this.freeze();this.onManual('begin');const v=this.view?.[frame.dataset.slot];if(v){v.scale=clamp(v.scale*Math.exp(-e.deltaY*.0015),.5,5);this.setTransform(frame.querySelector('img'),v);this.onManual('end');}},{passive:false});
    }
  }
  setProject(project){this.project=project;this.avatar.setRig(project.avatarRig);const a=this.el.querySelector('.character-image'),placeholder=this.el.querySelector('.character-empty');a.hidden=!project.avatar||!!project.avatarRig;placeholder.hidden=!!project.avatar;if(project.avatar&&a.src!==project.avatar)a.src=project.avatar;const char=this.el.querySelector('.character');char.style.left=`${project.character.x*100}%`;char.style.top=`${project.character.y*100}%`;char.style.transform=`translate(-50%,-50%) scale(${project.character.scale})`;
    this.el.dataset.background=project.background.kind;this.el.style.backgroundColor=project.background.color;this.el.style.backgroundImage=project.background.kind==='custom'&&project.background.image?`url("${project.background.image}")`:'';
  }
  setStatus(status,caption=''){this.el.dataset.status=status;this.avatar.setStatus(status);const labels={idle:'待机',thinking:'准备回答',speaking:'讲解中',captioning:'字幕预览',listening:'正在录音',preparing:'准备讲解',paused:'暂停 / 等待追问',takeover:'作者接管',error:'等待处理'};this.el.querySelector('[data-char-state]').textContent=labels[status]||status;const c=this.el.querySelector('.scene-caption');c.textContent=caption;c.hidden=!caption;}
  setSpeech(frame){this.avatar.setSpeech(frame);}
  setHearing(value){this.avatar.setHearing(value);}
  snapshot(){return clone(this.view);}
  transform(v){return `translate(${v.x*100}%, ${v.y*100}%) scale(${v.scale})`;}
  setTransform(el,v){el.style.transform=this.transform(v);}
  freeze(){
    if(this.view)for(const slot of ['main','secondary']){const v=this.view[slot];const frame=this.el.querySelector(`[data-slot="${slot}"]`);if(!v||!frame.clientWidth)continue;const image=frame.querySelector('img');try{const m=new DOMMatrixReadOnly(getComputedStyle(image).transform);v.scale=m.a;v.x=m.m41/frame.clientWidth;v.y=m.m42/frame.clientHeight;}catch{}this.setTransform(image,v);}
    for(const a of this.animations)a.cancel();this.animations=[];
  }
  async restore(view,project,signal){
    if(signal?.aborted)throw abortError();this.freeze();this.view=clone(view);this.setProject(project);this.el.querySelector('.material-space').classList.toggle('comparison',!!view.secondary);
    for(const slot of ['main','secondary']){const frame=this.el.querySelector(`[data-slot="${slot}"]`),v=this.view[slot];frame.hidden=!v;if(!v)continue;const s=project.slides.find(s=>s.id===v.imageId);if(!s)throw Error('要展示的图片不存在。');const img=frame.querySelector('img');img.src=s.src;await img.decode();if(signal?.aborted)throw abortError();this.setTransform(img,v);}
  }
  async tween(slot,target,signal){
    if(signal.aborted)throw abortError();const img=this.el.querySelector(`[data-slot="${slot}"] img`);const start=getComputedStyle(img).transform;const end=this.transform(target);const anim=img.animate([{transform:start},{transform:end}],{duration:window.matchMedia('(prefers-reduced-motion: reduce)').matches?0:420,easing:'cubic-bezier(.22,1,.36,1)',fill:'forwards'});this.animations.push(anim);
    const cancel=()=>this.freeze();signal.addEventListener('abort',cancel,{once:true});
    try{await anim.finished;if(signal.aborted)throw abortError();this.view[slot]={...target};this.setTransform(img,target);anim.cancel();}catch(e){if(signal.aborted)throw abortError();throw e;}finally{signal.removeEventListener('abort',cancel);this.animations=this.animations.filter(a=>a!==anim);}
  }
  async apply(action,project,signal){
    if(signal.aborted)throw abortError();this.setProject(project);if(!this.view)await this.restore(freshView(project.slides[0].id),project,signal);
    if(action.type==='show_image'){await this.restore(freshView(action.imageId),project,signal);return;}
    if(action.type==='compare'){await this.restore({main:{imageId:action.imageIds[0],scale:1,x:0,y:0},secondary:{imageId:action.imageIds[1],scale:1,x:0,y:0}},project,signal);return;}
    if(action.type==='restore_view'){await this.restore(freshView(this.view.main.imageId),project,signal);return;}
    if(action.type==='focus_region'){
      if(this.view.main.imageId!==action.imageId||this.view.secondary)await this.restore(freshView(action.imageId),project,signal);
      const s=project.slides.find(s=>s.id===action.imageId),r=s.regions.find(r=>r.id===action.regionId),frame=this.el.querySelector('[data-slot="main"]'),img=frame.querySelector('img');
      await this.tween('main',{imageId:s.id,...focusTransform(r,img.naturalWidth/img.naturalHeight,frame.clientWidth/frame.clientHeight)},signal);return;
    }
    if(action.type==='adjust_view'){
      const slot=action.slot||'main';if(!this.view[slot])throw Error('当前没有右侧对比图片。');const v=this.view[slot];await this.tween(slot,{...v,scale:clamp(v.scale*action.factor,.5,5),x:clamp(v.x+(action.dx||0),-4,4),y:clamp(v.y+(action.dy||0),-4,4)},signal);
    }
  }
}
