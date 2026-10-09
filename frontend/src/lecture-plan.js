import {splitSentences} from './core.js?v=public-core-2';

/** One score for live narration and recorded audio. Library-only images are
 * never lecture pages; slideIndex stays in project coordinates for bookmarks. */
export function lecturePlan(project,manifest=null){
  const spoken=project.slides.filter(slide=>slide.script?.trim());
  if(!manifest)return spoken.map(slide=>({id:slide.id,slideIndex:project.slides.indexOf(slide),
    units:splitSentences(slide.script).map((text,index)=>({id:slide.id+'-'+index,text,actions:[],gesture:null}))}));
  const pages=manifest.pages,clips=manifest.clips,used=new Set();
  if(!Array.isArray(pages)||!Array.isArray(clips)||pages.length!==spoken.length||!pages.length)throw Error('试讲内容不完整');
  const normalize=text=>text.replace(/\s/g,'');
  const plan=pages.map((page,index)=>{
    const slide=spoken[index];
    if(page.id!==slide.id||!Array.isArray(page.clips)||!page.clips.length)throw Error('试讲页面与当前项目不一致');
    const units=page.clips.map((id,unitIndex)=>{
      const clip=clips.find(c=>c.id===id);
      if(used.has(id)||!clip||clip.imageId!==page.id||clip.role!=='presenter')throw Error('试讲音频页序不完整');
      used.add(id);
      if(clip.focus&&!slide.regions.some(region=>region.id===clip.focus))throw Error('试讲细节区域已改变');
      return {id,text:clip.text,focus:clip.focus||null,
        actions:[clip.focus?{type:'focus_region',imageId:page.id,regionId:clip.focus}:{type:'restore_view'}],
        gesture:clip.focus?'point':unitIndex===0?(index===0?'welcome':'point'):null};
    });
    if(normalize(units.map(unit=>unit.text).join(''))!==normalize(slide.script))throw Error('讲稿已更新，请重新生成预录声音');
    return {id:page.id,slideIndex:project.slides.indexOf(slide),units};
  });
  if(used.size!==clips.length)throw Error('试讲片段重复或遗漏');
  return plan;
}
