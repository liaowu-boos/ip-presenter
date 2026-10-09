import test from 'node:test';
import assert from 'node:assert/strict';
import {SpeechGate,pcmWave,recognitionVocabulary} from '../frontend/src/voice-input.js';
import {VoiceDialogue,localVoiceIntent} from '../frontend/src/voice-dialogue.js';
import {Runtime} from '../frontend/src/runtime.js';
import {freshView,clone} from '../frontend/src/core.js';
import {sleep} from '../frontend/src/audio.js';
globalThis.window={speechSynthesis:{cancel(){}}};
function setup(){
 const project={name:'测试',character:{},slides:[{id:'a',title:'总览',script:'主讲一。主讲二。',regions:[]},{id:'b',title:'图表',script:'细节。',regions:[]}],knowledge:[{id:'k',title:'图表',keywords:['图表'],text:'图表依据。颜色说明。',kind:'decision',reviewed:true,slideId:'b'}]};
 const stage={view:freshView('a'),freeze(){},snapshot(){return clone(this.view);},async restore(v){this.view=clone(v);},async apply(a){if(a.type==='show_image')this.view=freshView(a.imageId);}};
 const spoken=[],messages=[];const ui={update(){},waiting(){},toast(){},cancelRecorder(){},message(role,text){messages.push({role,text});return messages.length-1;},updateMessage(){},confirmLecture(){throw Error('voice must not display a confirmation dialog');}};
 const rt=new Runtime(project,stage,ui);rt.settings.audio='system';rt.audio.unlock=async()=>{};rt.audio.stop=()=>{};rt.audio.play=async(text,o)=>{spoken.push(text);o.onStart?.();await sleep(15,o.signal);};
 const voice=new VoiceDialogue(rt,{onStop:()=>voice.stop()});voice.start();return {rt,voice,spoken,stage};
}
async function until(fn){for(let i=0;i<200;i++){if(fn())return;await new Promise(r=>setTimeout(r,2));}throw Error('Timed out');}
test('activity gate ignores short noise and emits speech start before end of turn',()=>{
 let starts=0,ends=[];const gate=new SpeechGate({onStart:()=>starts++,onEnd:e=>ends.push(e)});
 for(let i=0;i<4;i++)gate.push(.05);for(let i=0;i<80;i++)gate.push(.001);assert.equal(starts,0);
 for(let i=0;i<20;i++)gate.push(.05);assert.equal(starts,1);assert.equal(ends.length,0);
 for(let i=0;i<30;i++)gate.push(.001);assert.equal(ends.length,0);
 for(let i=0;i<40;i++)gate.push(.001);assert.equal(ends.length,1);assert.equal(ends[0].valid,true);
});
test('turn gate bounds long input and reports truncated instead of pretending it is complete',()=>{
 let info;const gate=new SpeechGate({maxMs:1000,onEnd:x=>info=x});for(let i=0;i<50;i++)gate.push(.1);assert.equal(info.truncated,true);
});
test('PCM WAV header and samples preserve microphone format',async()=>{
 const blob=pcmWave([new Float32Array([-1,0,1])],48000);const view=new DataView(await blob.arrayBuffer());assert.equal(blob.type,'audio/wav');assert.equal(view.getUint32(24,true),48000);assert.equal(view.getUint32(40,true),6);assert.equal(view.getInt16(44,true),-32768);assert.equal(view.getInt16(48,true),32767);
});
test('spoken commands accept punctuation and Chinese question ordinals but not quoted questions',()=>{
 const {rt}=setup();assert.equal(localVoiceIntent('先回答第二题。',rt).target_id,2);assert.equal(localVoiceIntent('请继续汇报。',rt).intent,'resume_lecture');assert.equal(localVoiceIntent('继续汇报是什么意思？',rt),null);
});
test('first spoken question answers automatically without queue clicks',async()=>{
 const {rt,voice,spoken}=setup();voice.speechStart();await voice.accept('为什么选这个图表？');assert.equal(rt.questions[0].status,'done');assert.ok(spoken.includes('图表依据。'));
});
test('spoken new topic during answer is queued and order is asked aloud',async()=>{
 const {rt,voice,spoken}=setup();voice.speechStart();const answer=voice.accept('图表为什么');await until(()=>rt.status==='speaking');voice.speechStart();await answer;await voice.accept('调研怎么做的');
 assert.equal(rt.questions[0].status,'paused');assert.equal(rt.questions[1].status,'queued');assert.ok(spoken.some(s=>s.includes('先回答第1题')));
 voice.speechStart();await voice.accept('先回答第二题');assert.equal(rt.questions[1].status,'done');assert.equal(rt.questions[0].status,'paused');
 voice.speechStart();await voice.accept('继续回答');assert.equal(rt.questions[0].status,'done');
});
test('spoken continue lecture confirms pending questions orally and never opens a dialog',async()=>{
 const {rt,voice,spoken}=setup();rt.humanControl=true;await voice.accept('图表问题');rt.humanControl=false;
 await voice.accept('继续汇报');assert.equal(voice.awaiting.kind,'main');assert.ok(spoken.at(-1).includes('可以吗'));
 await voice.accept('可以');assert.equal(rt.questions.length,1);assert.equal(rt.questions[0].status,'queued');assert.ok(spoken.includes('主讲一。'));
});
test('repeat and restatement require only spoken input',async()=>{
 const {rt,voice,spoken}=setup();await voice.unclear();assert.equal(rt.questions[0].status,'repeat');assert.ok(spoken.at(-1).includes('请再说一遍'));
 voice.speechStart();await voice.accept('为什么选图表');assert.equal(rt.questions.length,1);assert.equal(rt.questions[0].status,'done');
});
test('acknowledgement restores interrupted lecture instead of adding a question',async()=>{
 const {rt,voice}=setup();const lecture=voice.accept('开始汇报');await until(()=>rt.main&&rt.status==='speaking');voice.speechStart();await lecture;await voice.accept('嗯');assert.equal(rt.questions.length,0);assert.equal(rt.main,false);assert.equal(rt.bookmark,null);
});
test('author takeover keeps listening but does not autonomously answer the next question',async()=>{
 const {rt,voice,spoken}=setup();await voice.accept('我来回答');await voice.accept('图表问题');assert.equal(rt.questions[0].status,'queued');assert.equal(spoken.length,0);
 await voice.accept('先回答第一题');assert.equal(rt.questions[0].status,'done');
});
test('semantic supplement targets the original question without manual classification',async()=>{
 const {rt,voice}=setup();await voice.accept('我来回答');await voice.accept('图表问题');rt.humanControl=false;rt.activeQuestionId=1;rt.questions[0].status='paused';
 voice.online=()=>true;voice.classify=async()=>({intent:'supplement',target_id:1});await voice.accept('也讲讲颜色');assert.equal(rt.questions.length,1);assert.match(rt.questions[0].text,/补充：也讲讲颜色/);assert.equal(rt.questions[0].status,'done');
});
test('late semantic decision after a new utterance cannot execute an action',async()=>{
 const {rt,voice}=setup();let release;voice.online=()=>true;voice.classify=()=>new Promise(r=>release=r);const pending=voice.accept('帮我说说');await until(()=>!!release);voice.speechStart();release({intent:'start_lecture'});assert.equal(await pending,'retry');assert.equal(rt.main,false);
});
test('multiple recognized turns stay ordered and are coordinated aloud',async()=>{
 const {rt,voice,spoken}=setup();await voice.acceptBatch(['图表问题','调研问题']);assert.equal(rt.questions.length,2);assert.ok(rt.questions.every(q=>q.status==='queued'));assert.ok(spoken.at(-1).includes('接连的提问'));
});
test('pause at end of a recognized batch does not automatically start its queued question',async()=>{
 const {rt,voice,spoken}=setup();await voice.acceptBatch(['图表问题','停一下']);assert.equal(rt.questions[0].status,'queued');assert.equal(spoken.length,0);
});
test('spoken end closes the session and prevents late replies',async()=>{
 const {voice}=setup();await voice.accept('结束语音');assert.equal(voice.enabled,false);
});

test('manual takeover invalidates an in-flight semantic plan even without a new voice event',async()=>{
 const {rt,voice}=setup();let release;voice.online=()=>true;voice.classify=()=>new Promise(r=>release=r);const pending=voice.accept('介绍一下');await until(()=>!!release);rt.takeover();release({intent:'start_lecture'});await pending;assert.equal(rt.humanControl,true);assert.equal(rt.main,false);
});
test('an unfinished sentence cannot swallow an explicit stop command',async()=>{
 const {rt,voice}=setup();voice.fragment='我想问的是';await voice.accept('停一下');assert.equal(voice.fragment,'');assert.equal(rt.questions.length,0);assert.equal(rt.status,'paused');
});

test('clear standalone questions avoid an extra model round trip, queued and compound turns still classify',async()=>{
 const {rt,voice}=setup();let routed=0;voice.online=()=>true;voice.classify=async()=>{routed++;return {intent:'new'};};
 await voice.accept('为什么选这个图表？');assert.equal(routed,0);assert.equal(rt.questions[0].status,'done');
 await voice.accept('为什么选图表，还有调研怎么做？');assert.equal(routed,1);
 rt.questions.push({id:++rt.questionSequence,text:'待回答',status:'queued',parts:[],delivered:[]});
 await voice.accept('为什么选这个颜色？');assert.equal(routed,2);
});

test('spoken clarification followed by a named image resolves the clarification and keeps the lecture bookmark',async()=>{
 const {rt,voice,stage,spoken}=setup();rt.project.slides[1].regions=[{id:'puzzled',name:'示例图表'}];
 const lecture=voice.accept('开始汇报');await until(()=>rt.main&&rt.status==='speaking');voice.speechStart();await lecture;
 const bookmark=clone(rt.bookmark);await voice.accept('把那个放大一下');assert.equal(voice.awaiting.kind,'clarify');assert.equal(stage.view.main.imageId,'a');
 const actions=[];stage.apply=async a=>{actions.push(a);if(a.imageId)stage.view=freshView(a.imageId);};
 await voice.accept('不是示例插图，我说的是示例图表，把它放大');
 assert.equal(actions.at(-1).regionId,'puzzled');assert.equal(voice.awaiting,null);assert.deepEqual(rt.bookmark,bookmark);assert.equal(rt.questions.length,0);
 const resumed=voice.accept('继续汇报');await until(()=>rt.main&&stage.view.main.imageId==='a');assert.equal(rt.position.sentence,bookmark.sentence);voice.speechStart();await resumed;voice.stop();
});

test('quiet short words are captured, a brief consonant gap does not discard their start',()=>{
 let starts=0;const ends=[];const gate=new SpeechGate({onStart:()=>starts++,onEnd:x=>ends.push(x)});
 for(const level of [.008,.008,.008,.001,.008,.008,.008,.008,.008,.008])gate.push(level);
 assert.equal(starts,1);for(let i=0;i<35;i++)gate.push(.001);
 assert.equal(ends.length,1);assert.equal(ends[0].valid,true);assert.equal(ends[0].silenceMs,700);
});

test('recognition vocabulary contains bounded names and never lecture or question content',()=>{
 const project={slides:[{script:'不要发送的讲稿',regions:[{name:'示例图表'},{name:'示例图表'},{name:'非法\n名称'},{name:'x'.repeat(25)}]}],history:['私人问答']};
 const words=recognitionVocabulary(project);assert.ok(words.includes('数据图表'));assert.equal(words.filter(x=>x==='示例图表').length,1);
 assert.ok(!words.some(x=>/讲稿|私人|非法|xxx/.test(x)));
 assert.equal(recognitionVocabulary({slides:[{regions:Array.from({length:60},(_,i)=>({name:'表情'+i}))}]}).length,40);
});

test('misheard picture name is confirmed by voice once, rejected names never move the scene',async()=>{
 const {rt,voice,stage,spoken}=setup();rt.project.slides[1].regions=[{id:'puzzled',name:'示例图表'}];
 const actions=[];stage.apply=async a=>actions.push(a);rt.bookmark={slide:0,sentence:1,view:stage.snapshot()};const bookmark=clone(rt.bookmark);
 voice.online=()=>true;voice.classify=()=>{throw Error('picture uncertainty must not go to model');};
 await voice.accept('把示意图表放大');assert.equal(actions.length,0);assert.equal(voice.awaiting.kind,'picture');assert.match(spoken.at(-1),/示例图表/);
 await voice.accept('对');assert.equal(actions.length,1);assert.equal(actions[0].regionId,'puzzled');assert.equal(voice.awaiting,null);assert.deepEqual(rt.bookmark,bookmark);
 await voice.accept('对');assert.equal(actions.length,1);
 await voice.accept('把示意图表放大');await voice.accept('不是');assert.equal(actions.length,1);assert.equal(voice.awaiting,null);assert.equal(rt.questions.length,0);
 await voice.accept('把以后射速上大');assert.equal(actions.length,1);assert.match(spoken.at(-1),/再说一下名称/);voice.stop();
});

test('common spoken pause and start phrases do not need semantic classification',()=>{
 const {rt}=setup();for(const text of ['开始吧','你开始讲','可以开始了'])assert.equal(localVoiceIntent(text,rt).intent,'start_lecture');
 for(const text of ['等一下','先别说了','暂停一下'])assert.equal(localVoiceIntent(text,rt).intent,'pause');
 for(const text of ['不要开始','如果开始会怎么样','等一下是什么意思'])assert.equal(localVoiceIntent(text,rt),null);
 rt.bookmark={sentence:1};assert.equal(localVoiceIntent('你继续讲吧',rt).intent,'resume_lecture');
});
