import test from 'node:test';
import assert from 'node:assert/strict';
import {makeDemo} from '../frontend/src/demo.js';
import {installDemoAvatar} from '../frontend/src/demo-avatar.js';
import {validateProject} from '../frontend/src/core.js';

test('public entry yields valid editable project without private material',()=>{
 const old=globalThis.document;
 const context=new Proxy({}, {get:()=>()=>{}});
 globalThis.document={createElement:()=>({getContext:()=>context,toDataURL:()=> 'data:image/png;base64,AAAA'})};
 try {
  const project=installDemoAvatar(makeDemo());
  validateProject(project);
  assert.equal(project.slides.length,3);
  assert.ok(project.avatarRig.atlas.length<20000);
  assert.ok(project.knowledge.every(k=>k.kind==='unknown'));
  assert.ok(!JSON.stringify(project).includes('figma.com'));
 } finally {globalThis.document=old;}
});
