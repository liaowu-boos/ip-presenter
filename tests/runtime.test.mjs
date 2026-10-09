import test from 'node:test';
import assert from 'node:assert/strict';
import {Runtime} from '../frontend/src/runtime.js';
import {clone,freshView} from '../frontend/src/core.js';
import {sleep} from '../frontend/src/audio.js';
globalThis.window={speechSynthesis:{cancel(){}}};
function setup(){
 const project={name:'test',character:{x:.8,y:.5,scale:1},slides:[{id:'a',title:'A',script:'第一句。第二句。',regions:[]},{id:'b',title:'B',script:'第三句。',regions:[]}],knowledge:[{id:'k',title:'理由',keywords:['理由'],text:'这是有依据的回答。',kind:'decision',reviewed:true,slideId:'b'}]};
 const stage={view:freshView('a'),freeze(){},snapshot(){return clone(this.view);},async restore(v,p,signal){await sleep(3,signal);this.view=clone(v);},async apply(a,p,signal){await sleep(8,signal);if(a.type==='show_image')this.view=freshView(a.imageId);else if(a.type==='adjust_view')this.view.main.scale*=a.factor;}};
 const messages=[];const ui={update(){},message(role,text){messages.push({role,text});return messages.length-1;},updateMessage(id,text){messages[id].text=text;},waiting(){},toast(){},cancelRecorder(){}};
 const rt=new Runtime(project,stage,ui);rt.settings.audio='silent';rt.audio.unlock=async()=>{};rt.audio.stop=()=>{};rt.audio.play=async(text,o)=>{o.onCaption?.();await sleep(70,o.signal);};return {rt,stage,project,messages};
}
async function waitUntil(fn){for(let i=0;i<100;i++){if(fn())return;await new Promise(r=>setTimeout(r,2));}throw Error('test wait timed out');}
test('interruption saves main bookmark, follow-up does not overwrite it',async()=>{const {rt}=setup();const playing=rt.startLecture();await waitUntil(()=>rt.status==='captioning');rt.cancel();const mark=clone(rt.bookmark);await rt.ask('理由是什么');assert.deepEqual(rt.bookmark,mark);await rt.ask('为什么这个理由');assert.deepEqual(rt.bookmark,mark);rt.takeover();await playing;});
test('resume returns to bookmarked scene and sentence',async()=>{const {rt,stage}=setup();const playing=rt.startLecture();await waitUntil(()=>rt.status==='captioning');rt.cancel();await playing;await rt.ask('理由');assert.equal(stage.view.main.imageId,'b');const resumed=rt.resume();await waitUntil(()=>rt.main&&stage.view.main.imageId==='a');assert.equal(rt.position.sentence,0);rt.takeover();await resumed;});
test('takeover blocks old queued speech from advancing to next page',async()=>{const {rt,stage}=setup();const playing=rt.startLecture();await waitUntil(()=>rt.status==='captioning');rt.takeover();await playing;await new Promise(r=>setTimeout(r,100));assert.equal(rt.status,'takeover');assert.equal(stage.view.main.imageId,'a');});
test('picture transforms leave character transform untouched',async()=>{const {rt,project}=setup();const before=clone(project.character);await rt.manual([{type:'adjust_view',factor:2}]);assert.equal(rt.view.main.scale,2);assert.deepEqual(project.character,before);});
test('newer manual command invalidates the earlier one',async()=>{const {rt,stage}=setup();const first=rt.manual([{type:'show_image',imageId:'b'}]);const second=rt.manual([{type:'show_image',imageId:'a'}]);await Promise.all([first,second]);assert.equal(stage.view.main.imageId,'a');});
test('completed lecture clears its bookmark',async()=>{const {rt}=setup();await rt.startLecture();assert.equal(rt.status,'idle');assert.equal(rt.bookmark,null);});

test('second question pauses the first and queues without dropping its answer',async()=>{
 const {rt,project}=setup();project.knowledge[0].text='第一段依据。第二段解释。第三段结论。';
 const first=rt.ask('理由');await waitUntil(()=>rt.questions[0]?.delivered.length===1);
 await rt.ask('调研怎么做的');await first;
 assert.equal(rt.questions.length,2);assert.equal(rt.questions[0].status,'paused');assert.equal(rt.questions[1].status,'queued');
 assert.deepEqual(rt.questions[0].delivered,['第一段依据。']);assert.equal(rt.questions[0].complete,true);
 assert.match(rt.history.at(-1).content,/第一段依据/);assert.doesNotMatch(rt.history.at(-1).content,/第二段解释/);
 await rt.answerQuestion(2);assert.equal(rt.questions[1].status,'done');
 const played=[];rt.audio.play=async(text,o)=>{played.push(text);o.onCaption?.();};await rt.answerQuestion(1);
 assert.deepEqual(played,['第二段解释。','第三段结论。']);assert.equal(rt.questions[0].status,'done');assert.equal(rt.history.at(-2).content,'理由');
});
test('acknowledgement does not interrupt an answer or create a question',async()=>{
 const {rt}=setup();const first=rt.ask('理由');await waitUntil(()=>rt.status==='captioning');const epoch=rt.epoch.number;
 await rt.ask('嗯');assert.equal(rt.epoch.number,epoch);assert.equal(rt.questions.length,1);await first;assert.equal(rt.questions[0].status,'done');
});
test('repeat coordination retains the question and never invents an answer',async()=>{
 const {rt}=setup();const first=rt.ask('理由');await waitUntil(()=>rt.status==='captioning');rt.requestRepeat();await first;
 const before=clone(rt.view);rt.requestRepeat();assert.equal(rt.questions.length,2);assert.equal(rt.questions[1].status,'repeat');assert.deepEqual(rt.view,before);
 await rt.answerQuestion(2);assert.equal(rt.questions[1].status,'repeat');
 await rt.ask('用户调研',{},{kind:'repeat',targetId:2});assert.equal(rt.questions[1].status,'queued');assert.equal(rt.questions[1].text,'用户调研');
});
test('correction invalidates cached answer and supplement stays on selected question',async()=>{
 const {rt}=setup();const first=rt.ask('理由');await waitUntil(()=>rt.status==='captioning');
 await rt.ask('标题为什么这样设计',performance.now(),{kind:'correction',targetId:1});await first;
 const q=rt.questions[0];assert.equal(q.status,'queued');assert.equal(q.complete,false);assert.deepEqual(q.parts,[]);
 await rt.ask('也解释颜色',performance.now(),{kind:'supplement',targetId:1});assert.equal(rt.questions.length,1);assert.match(q.text,/标题.*\n补充：也解释颜色/);
});
test('takeover latches across pause and prevents automatic replies to new questions',async()=>{
 const {rt}=setup();rt.takeover();rt.cancel('listening');await rt.ask('理由');assert.equal(rt.questions[0].status,'queued');
 await rt.answerQuestion(1);assert.equal(rt.questions[0].status,'done');assert.equal(rt.humanControl,false);
});
test('lecture asks before leaving pending questions and retains the queue',async()=>{
 const {rt}=setup();rt.takeover();await rt.ask('理由');rt.ui.confirmLecture=()=>false;await rt.resume();assert.equal(rt.main,false);
 rt.ui.confirmLecture=()=>true;const playing=rt.resume();await waitUntil(()=>rt.main);rt.takeover();await playing;assert.equal(rt.questions[0].status,'queued');
});
test('explicit order and skip work without starting the next question automatically',async()=>{
 const {rt}=setup();rt.takeover();await rt.ask('理由');await rt.ask('调研');await rt.ask('先回答第2题');
 assert.equal(rt.questions[1].status,'done');assert.equal(rt.questions[0].status,'queued');rt.skipQuestion(1);assert.equal(rt.questions[0].status,'skipped');
});
test('ambiguous topic selection cannot silently choose between two questions',async()=>{
 const {rt}=setup();rt.takeover();await rt.ask('图表颜色');await rt.ask('图表款式');const before=rt.epoch.number;
 await rt.ask('先回答图表的问题');assert.equal(rt.epoch.number,before);assert.equal(rt.questions.every(q=>q.status==='queued'),true);
});
test('late online stream cannot mutate questions or move the stage after takeover',async()=>{
 const {rt,stage}=setup();rt.settings.mode='online';const oldFetch=globalThis.fetch;let release;
 globalThis.fetch=()=>new Promise(resolve=>{release=()=>resolve(new Response('data: '+JSON.stringify({type:'meta',actions:[{type:'show_image',imageId:'b'}]})+'\n\ndata: '+JSON.stringify({type:'text',text:'旧回答。'})+'\n\n'));});
 try{const first=rt.ask('理由');await waitUntil(()=>!!release);rt.takeover();release();await first;
 assert.equal(stage.view.main.imageId,'a');assert.equal(rt.questions[0].status,'paused');assert.deepEqual(rt.questions[0].parts,[]);assert.equal(rt.status,'takeover');
 }finally{globalThis.fetch=oldFetch;}
});
test('incomplete online answer resumes with heard context and discards unplayed fragment',async()=>{
 const {rt}=setup();rt.settings.mode='online';const oldFetch=globalThis.fetch;let controller,payload;
 globalThis.fetch=async()=>new Response(new ReadableStream({start(c){controller=c;c.enqueue(new TextEncoder().encode('data: '+JSON.stringify({type:'meta',actions:[]})+'\n\ndata: '+JSON.stringify({type:'text',text:'已经说完。还没说完'})+'\n\n'));}}));
 try{const first=rt.ask('理由');await waitUntil(()=>rt.questions[0]?.delivered.length===1);rt.cancel();controller.close();await first;
 assert.equal(rt.questions[0].complete,false);assert.match(rt.history.at(-1).content,/已经说完/);assert.doesNotMatch(rt.history.at(-1).content,/还没说完/);
 globalThis.fetch=async(url,opts)=>{payload=JSON.parse(opts.body);return new Response('data: '+JSON.stringify({type:'meta',actions:[]})+'\n\ndata: '+JSON.stringify({type:'text',text:'补充说明。'})+'\n\n');};
 await rt.answerQuestion(1);assert.match(payload.context.history.at(-1).content,/已经说完/);assert.equal(payload.question,'理由');assert.equal(rt.questions[0].status,'done');assert.match(rt.history.at(-1).content,/已经说完。补充说明。/);
 }finally{globalThis.fetch=oldFetch;}
});

test('incomplete question restores its own visual context before requesting a new answer',async()=>{
 const {rt,stage}=setup();rt.takeover();await rt.ask('这个为什么这样');
 await rt.manual([{type:'show_image',imageId:'b'}]);assert.equal(stage.view.main.imageId,'b');
 const oldFetch=globalThis.fetch;let payload;rt.settings.mode='online';
 globalThis.fetch=async(url,opts)=>{payload=JSON.parse(opts.body);return new Response('data: '+JSON.stringify({type:'meta',actions:[]})+'\n\ndata: '+JSON.stringify({type:'text',text:'依据。'})+'\n\n');};
 try{await rt.answerQuestion(1);assert.equal(payload.context.view.main.imageId,'a');}finally{globalThis.fetch=oldFetch;}
});
test('cached answer resume times out safely if audio never starts',async()=>{
 const {rt}=setup();const first=rt.ask('理由');await waitUntil(()=>rt.questions[0]?.complete);rt.cancel();await first;
 rt.settings.audio='cloud';rt.settings.hardTimeout=.02;rt.audio.play=async(text,opts)=>sleep(1000,opts.signal);
 await rt.answerQuestion(1);assert.equal(rt.status,'takeover');assert.equal(rt.questions[0].status,'paused');assert.equal(rt.questions[0].delivered.length,0);
});
test('overlong supplement is rejected without cancelling or mutating the target',async()=>{
 const {rt}=setup();rt.takeover();await rt.ask('长'.repeat(1999));const epoch=rt.epoch.number;
 await rt.ask('补充内容',performance.now(),{kind:'supplement',targetId:1});assert.equal(rt.questions[0].text.length,1999);assert.equal(rt.epoch.number,epoch);
});

test('answer preempts a waiting cue without losing the question or delaying real speech',async()=>{
 const {rt}=setup();rt.settings.mode='online';rt.settings.audio='cloud';rt.settings.hardTimeout=10;rt.voiceMode=true;
 const original=globalThis.fetch;let cueStarted=false,cueAborted=false;const played=[];
 globalThis.fetch=async()=>new Response(new ReadableStream({start(c){
  setTimeout(()=>{c.enqueue(new TextEncoder().encode('data: {"type":"meta","sources":["k"],"actions":[]}\n\ndata: {"type":"text","text":"真实回答。"}\n\n'));c.close();},3100);
 }}));
 rt.audio.play=async(text,o)=>{played.push(text);if(text==='稍等，我确认一下。'){cueStarted=true;try{await sleep(8000,o.signal);}catch(e){cueAborted=true;throw e;}}else{o.onStart?.();await sleep(5,o.signal);}};
 try{const start=performance.now();await rt.ask('请解释理由');assert.ok(cueStarted&&cueAborted);assert.equal(rt.questions[0].status,'done');assert.deepEqual(rt.questions[0].delivered,['真实回答。']);assert.deepEqual(played,['稍等，我确认一下。','真实回答。']);assert.ok(performance.now()-start<5000);assert.ok(rt.metric>=3000&&rt.metric<5000);}finally{globalThis.fetch=original;rt.cancel();}
});
