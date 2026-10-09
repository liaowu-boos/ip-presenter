/** Mouth openness follows the output signal, never the microphone or pending text. */
export class MouthMotion {
  constructor(){this.reset();}
  reset(){this.level=0;this.mouth=0;this.changedAt=0;this.quietAt=null;}
  update({level=0,active=false},now=performance.now()){
    if(!active){this.reset();return 0;}
    const rms=Number.isFinite(level)?Math.max(0,level):0;
    this.level=this.level*.35+rms*.65;
    if(rms<.007){
      this.quietAt??=now;
      if(now-this.quietAt>=55){this.level=0;this.mouth=0;this.changedAt=now;}
    }else{
      this.quietAt=null;
      const next=this.level>.055?2:this.level>.011?1:0;
      if(next!==this.mouth&&now-this.changedAt>=65){this.mouth=next;this.changedAt=now;}
    }
    return this.mouth;
  }
}

/** Switch complete registered frames: the mouth stays part of the face. */
export class Avatar {
  constructor(element){
    this.el=element;this.motion=new MouthMotion();this.status='idle';this.hearing=false;
    element.innerHTML='<div class="avatar-pose"><div class="avatar-sheet avatar-base"></div></div>';
    this.reduced=window.matchMedia('(prefers-reduced-motion: reduce)');
    this.blinkTimer=null;this.closeTimer=null;
  }
  setRig(rig){
    if(this.rig===rig?.atlas)return;
    this.rig=rig?.atlas;this.el.hidden=!this.rig;this.stopBlink();this.motion.reset();
    this.el.dataset.mouth='0';this.el.dataset.blink='false';
    if(!this.rig){this.el.style.removeProperty('--avatar-atlas');return;}
    this.el.style.setProperty('--avatar-atlas',`url("${this.rig}")`);this.scheduleBlink();
  }
  scheduleBlink(){
    if(!this.rig)return;
    this.blinkTimer=setTimeout(()=>{
      if(!document.hidden&&!this.reduced.matches){this.el.dataset.blink='true';this.closeTimer=setTimeout(()=>{this.el.dataset.blink='false';},135);}
      this.scheduleBlink();
    },3200+Math.random()*2400);
  }
  stopBlink(){clearTimeout(this.blinkTimer);clearTimeout(this.closeTimer);}
  setStatus(status){this.status=status;this.updatePose();}
  setHearing(value){this.hearing=!!value;this.updatePose();}
  updatePose(){
    this.el.dataset.pose=this.hearing?'listening':['thinking','preparing'].includes(this.status)?'thinking':this.status==='speaking'?'speaking':'idle';
  }
  setSpeech(frame){this.el.dataset.mouth=String(this.motion.update(frame));this.el.dataset.audio=frame.active?'playing':'silent';}
  destroy(){this.stopBlink();this.setSpeech({active:false});}
}
