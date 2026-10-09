/** Operator-only controls. No on-screen signal or focus movement in audience mode. */
export function installAnswerControls({controls,session,runtime}){
 const group=document.createElement('span');group.className='stage-answer-controls';
 group.innerHTML='<button type="button" data-answer disabled>空格 · 助手回答这一轮</button><button type="button" data-hold disabled>我来回答</button><button type="button" data-resume disabled>开始 / 继续讲述</button><small>说完按空格立即提交 · 再按收回 · 不按由你回答</small>';
 controls.append(group);const answer=group.querySelector('[data-answer]'),hold=group.querySelector('[data-hold]'),resume=group.querySelector('[data-resume]');
 const update=()=>{const live=session.running&&session.manualAnswers;answer.disabled=hold.disabled=resume.disabled=!live;answer.textContent=session.floorPermit?'空格 · 收回回答权':'空格 · 助手回答这一轮';};
 const previous=session.cb.onFloor;session.cb.onFloor=state=>{previous?.(state);update();};
 const toggle=()=>{session.answerOnce();update();};
 answer.onclick=toggle;hold.onclick=()=>{session.holdAnswer();update();};
 resume.onclick=()=>{session.holdAnswer();void runtime.resume(true);};
 const key=e=>{
  if(e.code!=='Space'||!session.running||!session.manualAnswers||e.ctrlKey||e.metaKey||e.altKey||e.isComposing)return;
  if(e.target.closest?.('input,textarea,select,[contenteditable="true"],a'))return;
  // A mouse-clicked button can retain focus. Space must still be the floor
  // key, not activate that old button (e.g. Stop) a second time.
  e.preventDefault();e.stopImmediatePropagation();if(!e.repeat)toggle();
 };
 document.addEventListener('keydown',key,true);update();
 return {destroy:()=>{document.removeEventListener('keydown',key,true);session.cb.onFloor=previous;group.remove();}};
}
