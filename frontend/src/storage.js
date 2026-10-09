export async function storage(write,key='current'){
  if(!window.indexedDB)throw Error('浏览器不支持本地保存，请导出项目备份。');
  return new Promise((resolve,reject)=>{const open=indexedDB.open('ip-presenter-v01',1);open.onupgradeneeded=()=>open.result.createObjectStore('projects');open.onerror=()=>reject(open.error);open.onsuccess=()=>{const db=open.result,tx=db.transaction('projects',write?'readwrite':'readonly'),store=tx.objectStore('projects');const req=write?store.put(write,key):store.get(key);let result;req.onsuccess=()=>result=req.result;tx.oncomplete=()=>{db.close();resolve(result);};tx.onerror=()=>{db.close();reject(tx.error);};};});
}
export function download(name,text,type='application/json'){const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([text],{type}));a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);}
export async function loadImage(file){
  if(!['image/png','image/jpeg','image/webp'].includes(file.type))throw Error('请使用 PNG、JPG 或 WebP 图片。SVG、视频和PDF暂不接收。');
  if(file.size>12*1024*1024)throw Error('单张图片请控制在12MB以内。');
  const data=await new Promise((resolve,reject)=>{const r=new FileReader();r.onerror=()=>reject(Error('图片读取失败。'));r.onload=()=>resolve(r.result);r.readAsDataURL(file);});
  const img=new Image();img.src=data;await img.decode();if(img.naturalWidth*img.naturalHeight>30000000)throw Error('单张图片请控制在3000万像素以内。');return data;
}
