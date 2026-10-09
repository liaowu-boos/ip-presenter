/** Pure presentation/domain functions. No DOM, network, or model-generated code. */
export const clone = (value) => structuredClone(value);
export const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
export const freshView = (imageId) => ({main:{imageId, scale:1, x:0, y:0}, secondary:null});
export const splitSentences = (text) => (String(text).match(/[^。！？!?\n]+[。！？!?\n]*/g)||[]).map(s=>s.trim()).filter(Boolean);
export const normalize = (text) => String(text).toLowerCase().replace(/[\s，。！？、,.!?：:]/g,'');
export class Epoch {
  constructor(){this.number=0;this.controller=new AbortController();}
  cancel(){this.controller.abort();this.controller=new AbortController();return ++this.number;}
  current(n){return n===this.number&&!this.controller.signal.aborted;}
}
export function focusTransform(region, imageAspect=16/9, frameAspect=16/9){
  const fitW=Math.min(1,imageAspect/frameAspect),fitH=Math.min(1,frameAspect/imageAspect);
  const scale=clamp(Math.min(.86/(region.w*fitW),.86/(region.h*fitH)),1,5);
  return {scale,x:(.5-region.x-region.w/2)*fitW*scale,y:(.5-region.y-region.h/2)*fitH*scale};
}
export function validRegion(r){return r&&typeof r.id==='string'&&typeof r.name==='string'&&['x','y','w','h'].every(k=>Number.isFinite(r[k]))&&r.x>=0&&r.y>=0&&r.w>=.01&&r.h>=.01&&r.x+r.w<=1.001&&r.y+r.h<=1.001;}
export function validateProject(p){
  if(!p||p.version!=='0.1'||!Array.isArray(p.slides)||p.slides.length<1||p.slides.length>60)throw Error('项目格式不正确：需要 V0.1 项目和 1—60 张图片。');
  if(typeof p.name!=='string'||p.name.length>100)throw Error('项目名称无效。');
  const ids=new Set();
  const imageOK=s=>typeof s==='string'&&/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=\r\n]+$/.test(s)&&s.length<24*1024*1024;
  for(const s of p.slides){
    if(!s||typeof s.id!=='string'||ids.has(s.id)||!imageOK(s.src)||typeof s.title!=='string'||s.title.length>120||typeof s.script!=='string'||s.script.length>12000||!Array.isArray(s.regions)||s.regions.length>20||!s.regions.every(validRegion))throw Error('图片、讲稿或区域数据不合法。');
    if(new Set(s.regions.map(r=>r.id)).size!==s.regions.length)throw Error('同一图片的区域ID不能重复。');
    ids.add(s.id);
  }
  if(p.avatar&&!imageOK(p.avatar))throw Error('IP素材必须为 PNG、JPG 或 WebP。');
  if(p.avatarRig&&(!p.avatar||p.avatarRig.id!=='demo-v1'||!imageOK(p.avatarRig.atlas)))throw Error('人物动作素材无效。');
  if(!p.character||!['x','y','scale'].every(k=>Number.isFinite(p.character[k]))||p.character.x<0||p.character.x>1||p.character.y<0||p.character.y>1||p.character.scale<.4||p.character.scale>1.7)throw Error('人物位置参数无效。');
  if(!p.background||!['midnight','ink','paper','custom'].includes(p.background.kind)||!/^#[0-9a-fA-F]{6}$/.test(p.background.color)||p.background.image&&!imageOK(p.background.image))throw Error('背景参数无效。');
  if(!Array.isArray(p.knowledge)||p.knowledge.length>150)throw Error('知识卡格式无效。');
  const kids=new Set();
  for(const k of p.knowledge){
    if(!k||typeof k.id!=='string'||kids.has(k.id)||!ids.has(k.slideId)||typeof k.text!=='string'||k.text.length>12000||!Array.isArray(k.keywords)||k.keywords.length>40||!k.keywords.every(w=>typeof w==='string'&&w.length<100)||typeof k.reviewed!=='boolean'||typeof k.title!=='string'||typeof k.source!=='string'||!['fact','decision','hypothesis','unknown'].includes(k.kind))throw Error('知识卡或图片关联无效。');
    if(k.regionId&&!p.slides.find(s=>s.id===k.slideId).regions.some(r=>r.id===k.regionId))throw Error('知识卡关联的区域不存在。');
    kids.add(k.id);
  }
  return p;
}
export function validateActions(actions,project){
  if(!Array.isArray(actions)||actions.length>4)throw Error('动作数量无效。');
  for(const a of actions){
    if(!a||!['show_image','focus_region','adjust_view','compare','restore_view'].includes(a.type))throw Error('拒绝未允许的动作。');
    if(['show_image','focus_region'].includes(a.type)){
      const slide=project.slides.find(s=>s.id===a.imageId);if(!slide)throw Error('请求的图片不存在。');
      if(a.type==='focus_region'&&!slide.regions.some(r=>r.id===a.regionId))throw Error('请求的区域不存在。');
    }
    if(a.type==='compare'&&(!Array.isArray(a.imageIds)||a.imageIds.length!==2||!a.imageIds.every(id=>project.slides.some(s=>s.id===id))))throw Error('比较材料无效。');
    if(a.type==='adjust_view'&&(!Number.isFinite(a.factor)||a.factor<.2||a.factor>5||!Number.isFinite(a.dx??0)||!Number.isFinite(a.dy??0)||Math.abs(a.dx??0)>1||Math.abs(a.dy??0)>1||!['main','secondary',undefined].includes(a.slot)))throw Error('缩放或平移超出范围。');
  }return actions;
}
/** Explicit command router: deliberately not marketed as semantic AI. */
export function commandRoute(text,project,view){
  let q=normalize(text);const current=project.slides.find(s=>s.id===view.main.imageId)||project.slides[0];
  if(/^(请)?(继续|继续汇报|继续讲解|接着讲|继续演讲|恢复汇报)$/.test(q))return{control:'resume'};
  if(/^(请)?(暂停|停一下|停止|别讲了|先停一下)$/.test(q))return{control:'pause'};
  if(/^(我来回答|我来讲|人工接管)$/.test(q))return{control:'takeover'};
  if(/^(请)?(恢复原图|看全图|恢复全图|回到全图|还原图片)$/.test(q))return{actions:[{type:'restore_view'}],text:'已恢复整张图片。'};
  // A correction is safe only with an explicit positive replacement and an image verb.
  const correction=q.match(/^不是.+?(?:我说的是|而是)(.+)$/);
  if(correction&&/放大|调出来|展示|看看|看一下/.test(correction[1]))q=correction[1];
  if(/不是|不要|别|不想|如果|假如|能不能不/.test(q))return null;
  if(/^(?:请)?(?:把)?(?:那个|这个)(?:给我)?(?:放大|缩小)(?:一下|一点)?$/.test(q))return {clarify:true,actions:[],text:'你指的是哪个表情？请说它的名称，或者说整张图片。'};
  const regions=project.slides.flatMap(s=>s.regions.filter(r=>q.includes(normalize(r.name))).map(r=>({s,r})));
  if(regions.length===2&&/比较|对比|并排/.test(q)&&!/为什么|原因|有什么|哪里|区别|不同|怎么/.test(q)){
    const ids=[...new Set(regions.map(x=>x.s.id))];
    return {actions:ids.length===2?[{type:'compare',imageIds:ids}]:[{type:'show_image',imageId:ids[0]}],text:ids.length===2?'已并排展示两组表情。':'这两个表情在同一页，已展示整页。'};
  }
  if(regions.length===1&&/放大|调出来|展示|看看|看一下|聚焦/.test(q)&&!/为什么|原因|怎么|为何|区别|不同|比较|对比|如果|假如|是什么意思/.test(q)){
    const {s,r}=regions[0];return {actions:[{type:'focus_region',imageId:s.id,regionId:r.id}],text:`已聚焦「${r.name}」。`};
  }
  const slot=/右边|右侧/.test(q)?'secondary':'main';
  if(/^(请)?(把)?(左边|右边|左侧|右侧)?(的)?(图片)?(再)?(放大|拉近)(一点|一下|些)?$/.test(q))return{actions:[{type:'adjust_view',factor:1.3,slot}],text:'已放大图片，人物大小保持不变。'};
  if(/^(请)?(把)?(左边|右边|左侧|右侧)?(的)?(图片)?(再)?(缩小|拉远)(一点|一下|些)?$/.test(q))return{actions:[{type:'adjust_view',factor:1/1.3,slot}],text:'已缩小图片。'};
  if(/^(请)?(往|向)(左|右|上|下)(移|挪)(动)?(一点|一下)?$/.test(q))return{actions:[{type:'adjust_view',factor:1,dx:q.includes('左')?-.1:q.includes('右')?.1:0,dy:q.includes('上')?-.1:q.includes('下')?.1:0}],text:'已调整图片位置。'};
  if(/^(请)?(下一张|下一页|上一张|上一页)$/.test(q)){
    const i=project.slides.findIndex(s=>s.id===current.id),n=clamp(i+(/下/.test(q)?1:-1),0,project.slides.length-1);
    return{actions:[{type:'show_image',imageId:project.slides[n].id}],text:`已展示「${project.slides[n].title}」。`};
  }
  if(/^(和另一版比较|和另一张比较|对比一下|比较一下|并排展示)$/.test(q)){
    if(project.slides.length<2)return{text:'还需要另一张图片才能并排比较。',actions:[]};
    const idx=project.slides.findIndex(s=>s.id===current.id);return{actions:[{type:'compare',imageIds:[current.id,project.slides[(idx+1)%project.slides.length].id]}],text:'已并排展示两张材料。'};
  }
  const picture=q.match(/^(?:请|请你|帮我)?(?:把)?(.{2,18}?)(?:这张|这一张|的表情|表情|图片)?(?:放大|上大|调出来|展示|看一下|看看)(?:一下|一点|给我看)?$/);
  if(picture&&!/为什么|怎么|区别|不同|不/.test(q)){
    const name=picture[1];
    const candidates=project.slides.flatMap(s=>s.regions.map(r=>({s,r,score:[...new Set(Array.from(name).slice(0,-1).map((_,i)=>name.slice(i,i+2)))].filter(pair=>r.name.includes(pair)).length}))).filter(x=>x.score>0).sort((a,b)=>b.score-a.score);
    if(candidates.length&&(!candidates[1]||candidates[0].score>candidates[1].score)){
      const {s,r}=candidates[0];return {clarify:true,actions:[],text:`你说的是「${r.name}」吗？`,confirmationActions:[{type:'focus_region',imageId:s.id,regionId:r.id}],confirmedText:`已聚焦「${r.name}」。`};
    }
    return {clarify:true,actions:[],text:'我没听清要看的具体名称，请再说一下名称。'};
  }
  return null;
}
export function ruleAnswer(text,project,view){
  let q=normalize(text);
  const correction=q.match(/(?:不是|不要)(.*?)(?:而是|是|改成|要)(.+)$/);if(correction)q=correction[2];
  const scored=project.knowledge.filter(k=>k.reviewed).map(k=>({k,score:k.keywords.reduce((n,w)=>n+(w&&q.includes(normalize(w))?normalize(w).length:0),0)})).filter(x=>x.score>0).sort((a,b)=>b.score-a.score);
  if(!scored.length)return{kind:'unknown',sources:[],actions:[],text:'当前已审核材料还不足以回答这个问题。请补充知识卡，或由项目作者说明；规则演示不生成项目外答案。'};
  const k=scored[0].k;
  const prefix=k.kind==='hypothesis'?'以下属于待验证的延展设想，不是已完成的项目结论。':k.kind==='unknown'?'这部分目前存在明确的资料边界。':'';
  return{kind:k.kind==='hypothesis'?'extension':k.kind==='unknown'?'unknown':'project',sources:[k.id],actions:[k.regionId?{type:'focus_region',imageId:k.slideId,regionId:k.regionId}:{type:'show_image',imageId:k.slideId}],text:prefix+k.text};
}
export function modelContext(project,view,history=[]){
  return{name:project.name,slides:project.slides.map(({id,title,regions})=>({id,title,regions:regions.map(({id,name})=>({id,name}))})),knowledge:project.knowledge.filter(k=>k.reviewed).map(({id,title,text,kind,source,slideId,regionId})=>({id,title,text,kind,source,slideId,regionId})),view,history:history.slice(-6)};
}
export function metadataOnly(project){return modelContext(project,freshView(project.slides[0].id));}
