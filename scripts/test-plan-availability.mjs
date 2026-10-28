import assert from 'node:assert/strict'
import test from 'node:test'
import { PlanAvailability } from '../lib/plan-availability.mjs'
const start=(p,sid,turn,mode='plan')=>p.onEvent(sid,{type:'turn/start',data:{turn}},mode)
const end=(p,sid,turn,kind='completed')=>p.onEvent(sid,{type:'turn/end',data:{turn,reason:{kind}}},'plan')
const user=(p,sid)=>p.onEvent(sid,{type:'user/message',data:{source:{kind:'user'},content:[{type:'text',text:'User request'}]}},'plan')
function setup(){let n=0;return new PlanAvailability({token:()=>`plan-${++n}`})}
function ready(p,sid,turn,title='完整计划'){start(p,sid,turn);user(p,sid);assert(p.submit(sid,title,'plan').ok);assert.equal(p.snapshot(sid).pendingExecution,false);end(p,sid,turn);return p.snapshot(sid).planToken}

test('real DSH context injections do not invalidate plans, but a subsequent human message does',()=>{
 const p=setup();start(p,'s',1);user(p,'s')
 const inject=kind=>p.onEvent('s',{type:'user/message',data:{source:{kind},content:[{type:'text',text:'context only'}]}},'plan')
 inject('runtime-context');inject('skill-catalog')
 assert(p.submit('s','A','plan').ok);end(p,'s',1)
 const token=p.snapshot('s').planToken;assert(token)
 inject('runtime-context');inject('skill-catalog');assert.equal(p.snapshot('s').planToken,token)
 user(p,'s');assert.equal(p.snapshot('s').pendingExecution,false)
 start(p,'s',2);user(p,'s');inject('runtime-context');inject('skill-catalog');p.onEvent('s',{type:'assistant/message',data:{}},'plan');user(p,'s')
 assert.equal(p.submit('s','late B','plan').ok,false)
 end(p,'s',2);assert.equal(p.snapshot('s').pendingExecution,false)
})
test('A complete -> new demand -> long discussion of B: A disappears and B is not yet executable',()=>{
 const p=setup(),tokenA=ready(p,'s',1,'A')
 assert(p.snapshot('s').pendingExecution)
 user(p,'s')
 assert.equal(p.snapshot('s').pendingExecution,false)
 assert.equal(p.consume('s',tokenA).ok,false)
 start(p,'s',2)
 p.onEvent('s',{type:'assistant/message',data:{content:'B 的讨论，尚未决策。'.repeat(100)}},'plan')
 end(p,'s',2)
 assert.equal(p.snapshot('s').pendingExecution,false)
 const tokenB=ready(p,'s',3,'B')
 assert.notEqual(tokenA,tokenB)
 assert.equal(p.consume('s',tokenA).ok,false)
 assert(p.consume('s',tokenB).ok)
 assert.equal(p.consume('s',tokenB).ok,false)
})
test('turn/start alone invalidates; other sessions never overwrite or invalidate this plan',()=>{
 const p=setup(),a=ready(p,'a',1),b=ready(p,'b',1)
 assert.equal(p.snapshot('a').planToken,a)
 assert.equal(p.snapshot('b').planToken,b)
 assert.equal(p.snapshot(null).pendingExecution,false)
 assert.equal(p.consume('b',a).ok,false)
 start(p,'a',2,'standard')
 assert.equal(p.snapshot('a').pendingExecution,false)
 assert.equal(p.snapshot('b').planToken,b)
})
test('submission only becomes ready on the matching successful end; errors and new input cancel it',()=>{
 for(const reason of ['error','aborted','blocked','max-tokens','interrupted']){
  const p=setup();start(p,'s',1);assert(p.submit('s','A','plan').ok);end(p,'s',1,reason)
  assert.equal(p.snapshot('s').pendingExecution,false)
 }
 const p=setup();start(p,'s',1);assert(p.submit('s','A','plan').ok)
 end(p,'s',0);assert.equal(p.snapshot('s').pendingExecution,false)
 user(p,'s');end(p,'s',1);assert.equal(p.snapshot('s').pendingExecution,false)
})
test('late A completion marker cannot re-arm the turn after an intervening user demand',()=>{
 const p=setup();start(p,'s',1);user(p,'s');p.onEvent('s',{type:'assistant/message',data:{}},'plan');user(p,'s')
 assert.equal(p.submit('s','late A','plan').ok,false)
 end(p,'s',1)
 assert.equal(p.snapshot('s').pendingExecution,false)
 start(p,'s',2);user(p,'s');assert(p.submit('s','B','plan').ok);end(p,'s',2)
 assert(p.snapshot('s').pendingExecution)
})
test('no completion marker in plain chat, no marks outside a planning turn, TTL and preference fail closed',()=>{
 let now=1000;const p=new PlanAvailability({now:()=>now,ttl:100,token:()=> 'id'})
 assert.equal(p.submit('s','A','plan').ok,false)
 start(p,'s',1,'standard');assert.equal(p.submit('s','A','standard').ok,false)
 const id=ready(p,'s',2)
 assert.equal(p.snapshot('s',false).pendingExecution,false)
 assert.equal(p.consume('s',id,false).ok,false)
 now+=101
 assert.equal(p.snapshot('s').pendingExecution,false)
 assert.equal(p.consume('s',id).ok,false)
})
test('revisions increase on every change, and a consumed plan is not resurrected by later failure',()=>{
 const p=setup(),revisions=[];p.onChange=sid=>revisions.push(p.snapshot(sid).planRevision)
 const token=ready(p,'s',1);p.consume('s',token);start(p,'s',2,'standard');end(p,'s',2,'error')
 assert.equal(p.snapshot('s').pendingExecution,false)
 assert(revisions.every((n,i)=>i===0||n>revisions[i-1]))
 p.forget('s');assert.equal(p.snapshot('s').pendingExecution,false)
})

test('real host routes + tool + SSE: new input revokes A, stale HTTP clicks rejected, only finished B executes',async()=>{
 const fs=await import('node:fs'),path=await import('node:path'),http=await import('node:http'),{EventEmitter}=await import('node:events')
 const home=fs.mkdtempSync(path.join(import.meta.dirname,'plan-test-home-'))
 const {createPlugin}=await import('../lib/index.js')
 const {createModeStore}=await import('../lib/state.mjs')
 const store=createModeStore({directory:home})
 const apply=createPlugin({store})
 const setMode=(sid,mode)=>store.setMode(sid,mode)
 const events=new EventEmitter(),routes=new Map(),tools=new Map(),disposers=[],sent=[]
 const agent={id:'s',followup(message){sent.push(message)}}
 const ctx={
  webServer:{register(r){routes.set(r.path,r.handler);return()=>routes.delete(r.path)}},
  systemPrompt:{section(){return()=>{}}},
  on(name,fn){events.on(name,fn);return()=>events.off(name,fn)},
  get(name){return name==='agents'?new Map([['s',agent]]):name==='tools'?{register(t){tools.set(t.name,t);return()=>tools.delete(t.name)}}:undefined},
  effect(fn){disposers.push(fn())},
 }
 apply({inject(_deps,fn){fn(ctx)}})
 const server=http.createServer((req,res)=>{
  const handler=routes.get(new URL(req.url,'http://x').pathname)
  if(handler)Promise.resolve(handler(req,res)).catch(e=>{res.statusCode=500;res.end(String(e))})
  else{res.statusCode=404;res.end()}
 })
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
 const base=`http://127.0.0.1:${server.address().port}`
 const emit=(type,data={})=>events.emit('session/event',{id:'s'},{type,data})
 const get=()=>fetch(base+'/dsh-mode/state?session=s').then(r=>r.json())
 const execute=token=>fetch(base+'/dsh-mode/execute',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:'s',planToken:token})}).then(r=>r.json())
 let reader
 try{
  assert.equal((await fetch(base+'/dsh-mode/state?session=s',{headers:{Origin:'https://untrusted.example'}})).status,403)
  assert.equal((await fetch(base+'/dsh-mode/execute',{method:'POST',headers:{'Content-Type':'text/plain'},body:'{}'})).status,415)
  const diagnostic=await fetch(base+'/dsh-mode/diag').then(r=>r.json())
  assert(!('agents' in diagnostic));assert(!('sessions' in diagnostic));assert(!('resolvedId' in diagnostic))
  setMode('s','plan')
  emit('turn/start',{turn:1});emit('user/message',{source:{kind:'user'}})
  emit('user/message',{source:{kind:'runtime-context'}});emit('user/message',{source:{kind:'skill-catalog'}})
  assert((await tools.get('mode_plan_ready').execute({title:'A'},{agent})).ok)
  assert.equal((await get()).pendingExecution,false)
  emit('turn/end',{turn:1,reason:{kind:'completed'}})
  const a=await get();assert(a.pendingExecution)
  const stream=await fetch(base+'/dsh-mode/plan-events?session=s');reader=stream.body.getReader()
  await reader.read()
  emit('user/message')
  const update=new TextDecoder().decode((await reader.read()).value)
  assert(update.includes('"pendingExecution":false'))
  assert.equal((await execute(a.planToken)).ok,false);assert.equal(sent.length,0)
  emit('turn/start',{turn:2});emit('assistant/message',{content:'讨论B'.repeat(100)})
  emit('turn/end',{turn:2,reason:{kind:'completed'}})
  assert.equal((await get()).pendingExecution,false)
  emit('turn/start',{turn:3});emit('user/message')
  await tools.get('mode_plan_ready').execute({title:'B'},{agent})
  emit('turn/end',{turn:3,reason:{kind:'completed'}})
  const b=await get();assert(b.pendingExecution);assert.notEqual(b.planToken,a.planToken)
  assert.equal((await execute(a.planToken)).ok,false)
  assert((await execute(b.planToken)).ok)
  assert.equal((await execute(b.planToken)).ok,false)
  assert.equal(sent.length,1);assert.equal(sent[0].source.kind,'plugin:dsh-mode-widget')
 } finally {
  if(reader)await reader.cancel()
  for(const d of disposers)if(typeof d==='function')d()
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve))
  assert(home.startsWith(path.join(import.meta.dirname,'plan-test-home-')))
  fs.rmSync(home,{recursive:true,force:true})
 }
})
