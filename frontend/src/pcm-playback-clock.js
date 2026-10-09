/** Source-sample clock for presentation cues. Network arrival and wall timers
 * never advance it: only scheduled Web Audio spans and completed sources do. */
export class PcmPlaybackClock {
 constructor(context,playbackId,{schedule=(fn,ms)=>setTimeout(fn,ms),unschedule=id=>clearTimeout(id)}={}){
  Object.assign(this,{context,playbackId,schedule,unschedule});
  this.spans=[];this.waiters=[];this.heard=0;this.closed=false;this.error=null;
 }
 add(offset,length,start){
  if(this.closed)return;
  this.spans.push({offset,length,start,end:start+length/24000});this.poll();
 }
 ended(sample){if(!this.closed){this.heard=Math.max(this.heard,sample);this.poll();}}
 position(){
  if(this.context.state==='running'){
   const now=this.context.currentTime;
   while(this.spans.length&&this.spans[0].end<=now){const span=this.spans.shift();this.heard=Math.max(this.heard,span.offset+span.length);}
   const span=this.spans[0];
   if(span&&now>=span.start)this.heard=Math.max(this.heard,span.offset+Math.min(span.length,Math.floor((now-span.start)*24000+1e-6)));
  }
  return this.heard;
 }
 snapshot(sampleCount){return {playbackId:this.playbackId,sampleCount,playedSamples:this.position(),audioTime:this.context.currentTime};}
 wait(sampleCount){
  if(this.error)return Promise.reject(this.error);
  if(this.position()>=sampleCount)return Promise.resolve(this.snapshot(sampleCount));
  if(this.closed)return Promise.reject(Error('声音已经结束，未到达请求的图片位置。'));
  return new Promise((resolve,reject)=>{this.waiters.push({sampleCount,resolve,reject});this.poll();});
 }
 poll(){
  this.unschedule(this.timer);this.timer=null;
  const position=this.position(),pending=[];
  for(const waiter of this.waiters){
   if(position>=waiter.sampleCount)waiter.resolve(this.snapshot(waiter.sampleCount));else pending.push(waiter);
  }
  this.waiters=pending;
  if(pending.length&&!this.closed)this.timer=this.schedule(()=>this.poll(),16);
 }
 finish(error){
  if(this.closed)return;this.closed=true;this.error=error||null;this.unschedule(this.timer);this.timer=null;
  const position=this.position();
  for(const waiter of this.waiters){
   if(error)waiter.reject(error);
   else if(position>=waiter.sampleCount)waiter.resolve(this.snapshot(waiter.sampleCount));
   else waiter.reject(Error('声音结束前没有播放到请求的图片位置。'));
  }
  this.waiters=[];this.spans=[];
 }
}
