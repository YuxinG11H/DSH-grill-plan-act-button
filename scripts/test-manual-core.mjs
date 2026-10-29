import assert from 'node:assert/strict'
import test from 'node:test'
import { SessionCore } from '../lib/session-core.mjs'
import { createMemoryModeStore } from '../lib/state.mjs'
const input=(id,kind='user')=>({id,source:{kind}})
const start=(c,s='A',turn=1)=>c.onEvent(s,{type:'turn/start',data:{turn}})
const end=(c,s='A',turn=1,kind='completed')=>c.onEvent(s,{type:'turn/end',data:{turn,reason:{kind}}})
function setup(){let n=0;return new SessionCore({store:createMemoryModeStore(),token:()=>`token-${++n}`})}
function manual(c,s='A',from='plan',view='view-A-001'){
 assert(c.attachView(s,view).ok);assert(c.setMode(s,from).ok)
 assert(c.setMode(s,'standard',{manualTransition:true,viewId:view}).ok)
 const state=c.snapshot(s);assert(state.pendingManual);assert(!state.pendingExecution)
 return state.manualToken
}
const message=id=>({id,source:{kind:'plugin:dsh-mode-widget'},content:[{type:'text',text:'现在请直接执行任务。'}]})

test('no marker ends with a visible diagnostic, not blue; only explicit planning-to-BASE UI transition grants manual',()=>{
 const c=setup();c.setMode('A','grill');start(c);end(c)
 assert.equal(c.snapshot('A').statusCode,'PLAN_NOT_SUBMITTED');assert(c.snapshot('A').statusReason.includes('mode_plan_ready'))
 assert(!c.snapshot('A').pendingExecution);assert(!c.snapshot('A').pendingManual)
 assert.equal(c.setMode('A','standard',{manualTransition:true,viewId:'unattached'}).code,'STALE_VIEW')
 c.attachView('A','view-A-001');c.setMode('A','standard');assert(!c.snapshot('A').pendingManual)
 c.setMode('A','limit');c.setMode('A','standard',{manualTransition:true,viewId:'view-A-001'});assert(!c.snapshot('A').pendingManual)
 manual(c)
})
test('manual grants are per session, page and transition; no default-mode mutation',()=>{
 const c=setup(),a=manual(c),b=manual(c,'B','grill','view-B-001')
 assert.notEqual(a,b)
 assert.equal(c.consumeManual('B',a,'view-B-001').code,'STALE_MANUAL')
 assert.equal(c.consumeManual('A',a,'view-B-001').code,'STALE_MANUAL')
 assert(c.consumeManual('A',a,'view-A-001').ok)
 assert.equal(c.consumeManual('A',a,'view-A-001').code,'STALE_MANUAL')
 assert.equal(c.snapshot('B').manualToken,b);assert.equal(c.store.read().defaultMode,'standard')
})
test('genuine input revokes manual before admission; context injections do not',()=>{
 for(const kind of ['user','parent','hook','plugin:another']){
  const c=setup(),token=manual(c)
  c.queuedInput('A',input('context','runtime-context'));assert(c.snapshot('A').pendingManual)
  c.onEvent('A',{type:'user/message',data:input('catalog','skill-catalog')});assert(c.snapshot('A').pendingManual)
  c.queuedInput('A',input('new',kind));assert(!c.snapshot('A').pendingManual)
  assert.equal(c.consumeManual('A',token,'view-A-001').code,'STALE_MANUAL')
 }
 const c=setup();manual(c);c.onEvent('A',{type:'user/message',data:input('direct')});assert(!c.snapshot('A').pendingManual)
})
test('new turn, any next mode selection, page reload and unload clear manual eligibility',()=>{
 for(const revoke of [c=>start(c),c=>c.setMode('A','standard'),c=>c.setMode('A','limit'),c=>c.attachView('A','view-A-002'),c=>c.release('A')]){
  const c=setup(),token=manual(c);revoke(c)
  assert(!c.snapshot('A').pendingManual)
  assert.equal(c.consumeManual('A',token,'view-A-001').code,'STALE_MANUAL')
 }
})
test('switching mid-turn keeps frozen mode; manual appears only after turn closes, never resurrects blue',()=>{
 const c=setup();c.attachView('A','view-A-001');c.setMode('A','plan');start(c)
 assert(c.setMode('A','standard',{manualTransition:true,viewId:'view-A-001'}).ok)
 assert.equal(c.snapshot('A').mode,'plan');assert(!c.snapshot('A').pendingManual)
 assert.equal(c.submit('A','late plan').code,'MODE_CHANGED')
 end(c);assert.equal(c.snapshot('A').mode,'standard');assert(c.snapshot('A').pendingManual);assert(!c.snapshot('A').pendingExecution)
})
test('queued new input and unknown ongoing turns do not grant manual execution',()=>{
 const c=setup();c.attachView('A','view-A-001');c.setMode('A','plan');c.queuedInput('A',input('waiting'))
 c.setMode('A','standard',{manualTransition:true,viewId:'view-A-001'});assert(!c.snapshot('A').pendingManual)
 const d=setup();d.attachView('A','view-A-001');d.setMode('A','plan')
 d.observeSession({id:'A',events:[{type:'turn/start',data:{turn:7}}]})
 d.setMode('A','standard',{manualTransition:true,viewId:'view-A-001'});assert(!d.snapshot('A').pendingManual)
})
test('manual handoff sends once without inventing a plan and failure never re-arms or retries',async()=>{
 for(const fail of [false,true]){
  const c=setup(),token=manual(c);let sends=0
  const options={message:message('once'),send:()=>{sends++;if(fail)throw Error('offline')}}
  const result=await c.executeManual('A',token,'view-A-001',options)
  assert.equal(result.ok,!fail);assert.equal(sends,1);assert(!c.snapshot('A').pendingManual);assert(!c.snapshot('A').pendingExecution)
  assert.equal(c.entry('A').execution.plan,null);assert.equal(c.entry('A').execution.kind,'manual')
  assert.equal((await c.executeManual('A',token,'view-A-001',options)).code,'STALE_MANUAL');assert.equal(sends,1)
  assert.equal(c.selectedMode('A'),'standard')
 }
})
test('normal blue handoff auto-switch never produces manual; explicit manual switch retires old blue token',async()=>{
 const c=setup();c.attachView('A','view-A-001');c.setMode('A','plan');start(c);c.submit('A','complete');end(c)
 const blue=c.snapshot('A').planToken
 assert((await c.execute('A',blue,{message:message('blue'),send:()=>{}})).ok)
 assert(!c.snapshot('A').pendingManual)
 const d=setup();d.attachView('A','view-A-001');d.setMode('A','plan');start(d);d.submit('A','complete');end(d)
 const old=d.snapshot('A').planToken
 d.setMode('A','standard',{manualTransition:true,viewId:'view-A-001'})
 assert(d.snapshot('A').pendingManual);assert.equal(d.consume('A',old).code,'STALE_PLAN')
})
test('manual queued-with-error is accepted once and does not create a retry token',async()=>{
 const c=setup(),token=manual(c),m=message('accepted');let sends=0
 const result=await c.executeManual('A',token,'view-A-001',{message:m,send:()=>{sends++;c.queuedInput('A',m);throw Error('after enqueue')}})
 assert.equal(result.code,'HANDOFF_ACCEPTED_WITH_ERROR');assert.equal(sends,1);assert(!c.snapshot('A').pendingManual)
})
