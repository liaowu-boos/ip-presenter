/** Independent geometric demonstration, with no original project materials. */
export function makeDemo(){
 function image(page){
  const c=document.createElement('canvas');c.width=1600;c.height=900;const g=c.getContext('2d');
  g.fillStyle='#f5f3ed';g.fillRect(0,0,1600,900);
  function text(s,x,y,size=30,color='#242520'){g.fillStyle=color;g.font=`${size}px sans-serif`;g.fillText(s,x,y);}
  text('IP PRESENTER  /  GENERIC DEMO',80,80,24,'#747768');
  if(page===1){
   text('让演示可以被提问。',80,290,76);text('讲解 · 暂停 · 聚焦 · 继续',80,405,40);
   for(let i=0;i<3;i++){g.fillStyle=['#ccdf70','#a9bfe2','#deded3'][i];g.fillRect(90+i*480,530,390,160);text(['听取问题','展示材料','恢复讲解'][i],120+i*480,630,36);}
  }else if(page===2){
   text('比较不同的展示区域',80,220,64);text('示意数值，不代表任何真实研究或测量。',80,295,30,'#747768');
   for(let i=0;i<3;i++){g.fillStyle=['#ccdf70','#a9bfe2','#deded3'][i];g.fillRect(130+i*470,720-(i+1)*120,280,(i+1)*120);text(['区域 A','区域 B','区域 C'][i],150+i*470,780,28);}
  }else{
   text('回答来自审核过的资料',80,240,64);text('没有资料时，明确说明未知。',80,370,44);
   text('自行导入图片、填写讲稿与知识卡。',80,555,36);text('公开示例不包含个人材料。',80,650,32,'#747768');
  }
  text('独立生成的通用演示 · 可替换为自己的材料',80,850,22,'#747768');return c.toDataURL('image/png');
 }
 return {version:'0.1',name:'我的交互演讲',avatar:'',character:{x:.83,y:.56,scale:1},background:{kind:'midnight',color:'#101513',image:''},slides:[
  {id:'intro',title:'01 / 演讲开场',src:image(1),script:'这是通用交互演讲示例。你可以导入自己的资料，在演讲中暂停、提问，再继续讲解。',regions:[]},
  {id:'exploration',title:'02 / 图表示例',src:image(2),script:'这里是三个独立绘制的示意区域。数值只用于测试图片展示，不代表实际测量。可以放大区域 B，再恢复全图。',regions:[{id:'area-b',name:'区域 B',x:.36,y:.48,w:.23,h:.40}]},
  {id:'boundary',title:'03 / 资料边界',src:image(3),script:'回答应当依据审核过的知识卡。资料没有覆盖的内容，需要明确说明未知。',regions:[]}
 ],knowledge:[
  {id:'demo-chart',title:'示例图表',keywords:['数值','图表','区域'],kind:'unknown',text:'示意图用于测试交互，没有对应的真实测量数据。',source:'通用演示说明',reviewed:true,slideId:'exploration',regionId:'area-b'},
  {id:'demo-boundary',title:'资料边界',keywords:['资料','依据'],kind:'unknown',text:'尚未导入真实材料，不能给出项目事实或研究结论。',source:'通用演示说明',reviewed:true,slideId:'boundary',regionId:''}
 ]};
}
