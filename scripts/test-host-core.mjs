import assert from 'node:assert/strict'
import test from 'node:test'
import http from 'node:http'
import { EventEmitter } from 'node:events'
import { createPlugin } from '../lib/index.js'
import { createMemoryModeStore } from '../lib/state.mjs'

async function harness(t, suppliedStore) {
  const store = suppliedStore || createMemoryModeStore()
  const events = new EventEmitter(), routes = new Map(), tools = new Map(), agents = new Map(), disposers = [], prompts = []
  const registry = { archivedSessionIds: [] }
  const ctx = {
    webServer: { register(row) { routes.set(row.path, row.handler); return () => routes.delete(row.path) } },
    systemPrompt: { section(row) { prompts.push(row); return () => {} } },
    on(name, handler) { events.on(name, handler); return () => events.off(name, handler) },
    effect(fn) { disposers.push(fn()) },
    get(name) { return name === 'agents' ? agents : name === 'workspaceRegistry' ? registry : name === 'tools' ? { register(row) { tools.set(row.name, row); return () => tools.delete(row.name) } } : undefined },
  }
  createPlugin({ store })({ inject(_deps, fn) { fn(ctx) } })
  const server = http.createServer((req, res) => {
    const handler = routes.get(new URL(req.url, 'http://x').pathname)
    if (!handler) { res.statusCode = 404; res.end(); return }
    Promise.resolve(handler(req, res)).catch(error => { res.statusCode = 500; res.end(error.message) })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  t.after(async () => { for (const d of disposers) if (typeof d === 'function') d(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  const api = async (route, body) => {
    const response = await fetch(base + route, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})
    return { status: response.status, body: await response.json() }
  }
  function add(sid) {
    const a = { id: sid, session: { id: sid, header: { origin: 'user' }, events: [], snapshotEvents() { return this.events } }, inbox: { nextTurn: [], nextStep: [] }, sent: [],
      followup(message) { this.sent.push(message); this.inbox.nextTurn.push(message); emit(sid, 'agent/inbox/spliced', { inserted: [message] }); events.emit('agent/inbox/inserted', { agent: this, message }) } }
    agents.set(sid, a); return a
  }
  function emit(sid, type, data = {}) { const a = agents.get(sid); const e = { type, data }; a.session.events.push(e); events.emit('session/event', a.session, e) }
  async function ready(sid, turn = 1) {
    await api('/dsh-mode/state', { sessionId: sid, mode: 'plan' })
    emit(sid, 'turn/start', { turn })
    emit(sid, 'user/message', { id: `request-${sid}-${turn}`, source: { kind: 'user' } })
    emit(sid, 'user/message', { source: { kind: 'runtime-context' } })
    emit(sid, 'user/message', { source: { kind: 'skill-catalog' } })
    const marked = await tools.get('mode_plan_ready').execute({ title: 'Complete plan' }, { agent: agents.get(sid) })
    assert(marked.ok, marked.reason)
    emit(sid, 'turn/end', { turn, reason: { kind: 'completed' } })
    const state = (await api('/dsh-mode/state?session=' + sid)).body
    assert(state.pendingExecution)
    return state.planToken
  }
  return { store, events, registry, agents, add, emit, api, ready, tools, prompts,
    gate: events.listeners('tools/pre-execute')[0] }
}

test('HTTP modes isolate A/B; missing session and obsolete global scope never change defaults or another conversation', async t => {
  const h = await harness(t); h.add('A'); h.add('B')
  await h.api('/dsh-mode/state?session=A'); await h.api('/dsh-mode/state?session=B')
  assert.equal((await h.api('/dsh-mode/state', { sessionId: 'A', mode: 'plan' })).body.mode, 'plan')
  assert.equal((await h.api('/dsh-mode/state?session=B')).body.mode, 'standard')
  assert.equal((await h.api('/dsh-mode/state', { mode: 'limit' })).body.code, 'SESSION_REQUIRED')
  assert.equal((await h.api('/dsh-mode/state', { sessionId: 'A', scope: 'global' })).status, 400)
  await h.tools.get('mode_config').execute({ action: 'set', defaultMode: 'grill' })
  assert.equal((await h.api('/dsh-mode/state?session=A')).body.mode, 'plan')
  assert.equal((await h.api('/dsh-mode/state?session=B')).body.mode, 'standard')
  assert.equal((await h.api('/dsh-mode/state?session=C')).body.mode, 'grill')
})
test('HTTP + prompt + tool gate share frozen turn mode; only next turn applies the newly selected mode', async t => {
  const h = await harness(t), a = h.add('A'), b = h.add('B')
  await h.api('/dsh-mode/state', { sessionId: 'A', mode: 'plan' })
  await h.api('/dsh-mode/state', { sessionId: 'B', mode: 'standard' })
  h.emit('A', 'turn/start', { turn: 1 }); h.emit('B', 'turn/start', { turn: 1 })
  const signal = new AbortController().signal
  assert(h.prompts[0].text({ agent: a, signal }).includes('计划模式'))
  const selected = (await h.api('/dsh-mode/state', { sessionId: 'A', mode: 'standard' })).body
  assert.equal(selected.mode, 'plan'); assert.equal(selected.selectedMode, 'standard'); assert(selected.modePending)
  assert(h.prompts[0].text({ agent: a, signal }).includes('计划模式'))
  assert.equal((await h.gate({ name: 'edit', agent: a, signal }, () => 'allowed')).kind, 'deny')
  assert.equal(await h.gate({ name: 'edit', agent: b }, () => 'allowed'), 'allowed')
  h.emit('A', 'turn/end', { turn: 1, reason: { kind: 'completed' } }); h.emit('A', 'turn/start', { turn: 2 })
  assert.equal(h.prompts[0].text({ agent: a, signal: new AbortController().signal }), '')
  assert.equal(await h.gate({ name: 'edit', agent: a }, () => 'allowed'), 'allowed')
})
test('official queued-input hook revokes a ready plan immediately without waiting for user/message', async t => {
  const h = await harness(t), a = h.add('A'), token = await h.ready('A')
  h.events.emit('agent/inbox/inserted', { agent: a, message: { id: 'context', source: { kind: 'model-selection' } } })
  assert((await h.api('/dsh-mode/state?session=A')).body.pendingExecution)
  const message = { id: 'new-human-input', source: { kind: 'user' } }
  a.inbox.nextTurn.push(message); h.events.emit('agent/inbox/inserted', { agent: a, message })
  assert.equal((await h.api('/dsh-mode/state?session=A')).body.pendingExecution, false)
  assert.equal((await h.api('/dsh-mode/execute', { sessionId: 'A', planToken: token })).body.ok, false)
  assert.equal(a.sent.length, 0)
})
test('execution of A changes only A; duplicate clicks send once; correlated failure does not overwrite a newer user selection', async t => {
  const h = await harness(t), a = h.add('A'); h.add('B')
  const token = await h.ready('A')
  await h.api('/dsh-mode/state', { sessionId: 'B', mode: 'grill' })
  const submitted = await h.api('/dsh-mode/execute', { sessionId: 'A', planToken: token })
  assert(submitted.body.ok); assert.equal(submitted.body.mode, 'standard')
  assert.equal((await h.api('/dsh-mode/state?session=B')).body.mode, 'grill')
  assert.equal((await h.api('/dsh-mode/execute', { sessionId: 'A', planToken: token })).body.ok, false)
  assert.equal(a.sent.length, 1)
  assert.equal(a.sent[0].content[0].text, '现在请直接执行任务。')
  assert.equal(submitted.body.pendingManual, false, 'blue automatic mode switch never grants manual')
  h.emit('A', 'turn/start', { turn: 2 }); const message = a.inbox.nextTurn.shift()
  h.events.emit('agent/inbox/claimed', { agent: a, message, turn: 2 }); h.emit('A', 'user/message', message)
  const change = (await h.api('/dsh-mode/state', { sessionId: 'A', mode: 'limit' })).body
  assert.equal(change.mode, 'standard'); assert.equal(change.selectedMode, 'limit')
  h.emit('A', 'turn/end', { turn: 2, reason: { kind: 'error', error: { message: 'failed to write result' } } })
  const failed = (await h.api('/dsh-mode/state?session=A')).body
  assert.equal(failed.statusCode, 'EXECUTION_FAILED'); assert.equal(failed.mode, 'limit'); assert(!failed.pendingExecution)
  assert.equal((await h.api('/dsh-mode/state?session=B')).body.mode, 'grill')
})
test('archived, unloaded, or pending-input targets reject execution before token consumption or mode mutation', async t => {
  const h = await harness(t), a = h.add('A'), token = await h.ready('A')
  h.registry.archivedSessionIds = ['A']
  assert.equal((await h.api('/dsh-mode/execute', { sessionId: 'A', planToken: token })).body.code, 'SESSION_ARCHIVED')
  assert.equal(h.store.modeFor('A'), 'plan'); assert.equal(a.sent.length, 0)
  h.registry.archivedSessionIds = []; a.inbox.nextStep.push({ id: 'new', source: { kind: 'user' } })
  assert.equal((await h.api('/dsh-mode/execute', { sessionId: 'A', planToken: token })).body.code, 'PENDING_INPUT')
  a.inbox.nextStep = []; h.agents.delete('A')
  assert.equal((await h.api('/dsh-mode/execute', { sessionId: 'A', planToken: token })).body.code, 'AGENT_UNAVAILABLE')
  assert.equal(h.store.modeFor('A'), 'plan'); assert.equal(a.sent.length, 0)
})
test('canceling queued human work clears pending state, and canceling an unclaimed execution does not lock the session', async t => {
  const h = await harness(t), a = h.add('A')
  const input = { id: 'cancel-me', source: { kind: 'user' } }
  h.events.emit('agent/inbox/inserted', { agent: a, message: input })
  h.events.emit('agent/inbox/discarded', { agent: a, message: input })
  const token = await h.ready('A')
  assert((await h.api('/dsh-mode/execute', { sessionId: 'A', planToken: token })).body.ok)
  const own = a.inbox.nextTurn.shift()
  h.events.emit('agent/inbox/discarded', { agent: a, message: own })
  const status = (await h.api('/dsh-mode/state?session=A')).body
  assert.equal(status.mode, 'plan'); assert.equal(status.statusCode, 'EXECUTION_DISCARDED')
  assert(!status.pendingExecution)
  assert((await h.api('/dsh-mode/state', { sessionId: 'A', mode: 'limit' })).body.ok)
})
test('runtime disposal preserves selected mode and invalidates tokens; diagnostic exposes the actual protocol/build', async t => {
  const h = await harness(t), a = h.add('A'), token = await h.ready('A')
  h.events.emit('session/disposed', a.session)
  const state = (await h.api('/dsh-mode/state?session=A')).body
  assert.equal(state.mode, 'plan'); assert(!state.pendingExecution)
  assert.equal((await h.api('/dsh-mode/execute', { sessionId: 'A', planToken: token })).body.ok, false)
  const diagnostic = (await h.api('/dsh-mode/diag?session=A')).body
  assert.equal(diagnostic.runtime.protocolVersion, 3); assert.equal(diagnostic.runtime.stateSchemaVersion, 2)
  assert.equal(diagnostic.sessionState.statusCode, 'SESSION_UNLOADED')
  assert(!('agents' in diagnostic)); assert(!('sessions' in diagnostic))
})
test('question card defaults, independent preferences, and next-request guard agree with the prompt', async t => {
 const h=await harness(t),a=h.add('A'),b=h.add('B')
 await h.api('/dsh-mode/state',{sessionId:'A',mode:'plan'});await h.api('/dsh-mode/state',{sessionId:'B',mode:'grill'})
 h.emit('A','turn/start',{turn:1});h.emit('B','turn/start',{turn:1})
 const first=new AbortController().signal
 assert(h.prompts[0].text({agent:a,signal:first}).includes('本模式问题卡已禁用'))
 assert.equal((await h.gate({name:'ask_user_question',agent:a,signal:first},()=> 'allowed')).kind,'deny')
 h.prompts[0].text({agent:b});assert.equal(await h.gate({name:'ask_user_question',agent:b},()=> 'allowed'),'allowed')
 await h.api('/dsh-mode/state',{sessionId:'A',prefs:{disablePlanQuestionCard:false,disableGrillQuestionCard:true}})
 assert.equal((await h.gate({name:'ask_user_question',agent:a,signal:first},()=> 'allowed')).kind,'deny','in-flight request retains captured setting')
 const next=new AbortController().signal
 h.prompts[0].text({agent:a,signal:next});assert.equal(await h.gate({name:'ask_user_question',agent:a,signal:next},()=> 'allowed'),'allowed')
 h.prompts[0].text({agent:b});assert.equal((await h.gate({name:'ask_user_question',agent:b},()=> 'allowed')).kind,'deny')
 assert.equal(h.store.modeFor('A'),'plan');assert.equal(h.store.modeFor('B'),'grill')
 assert(h.tools.get('mode_config').parameters.properties.prefs.properties.disablePlanQuestionCard)
})
test('manual HTTP transition attaches a view, retires missing-plan status, and sends once without approving a plan', async t => {
 const h=await harness(t),a=h.add('A');h.add('B')
 const viewId='view-A-001'
 assert.equal((await h.api('/dsh-mode/state',{sessionId:'A',viewId,attachView:true})).body.viewId,viewId)
 await h.api('/dsh-mode/state',{sessionId:'A',mode:'grill'})
 h.emit('A','turn/start',{turn:1});h.emit('A','turn/end',{turn:1,reason:{kind:'completed'}})
 const missing=(await h.api('/dsh-mode/state?session=A')).body
 assert.equal(missing.statusCode,'PLAN_NOT_SUBMITTED');assert(!missing.pendingManual);assert(!missing.pendingExecution)
 const selected=(await h.api('/dsh-mode/state',{sessionId:'A',viewId,manualTransition:true,mode:'standard'})).body
 assert(selected.pendingManual);assert(!selected.pendingExecution);assert.equal(selected.planToken,null)
 assert.equal((await h.api('/dsh-mode/execute',{sessionId:'A',planToken:selected.manualToken})).body.code,'STALE_PLAN')
 assert.equal((await h.api('/dsh-mode/execute-manual',{sessionId:'A',viewId:'wrong-view',manualToken:selected.manualToken})).body.code,'STALE_MANUAL')
 const payload={sessionId:'A',viewId,manualToken:selected.manualToken}
 assert((await h.api('/dsh-mode/execute-manual',payload)).body.ok)
 assert.equal((await h.api('/dsh-mode/execute-manual',payload)).body.ok,false)
 assert.equal(a.sent.length,1);assert.equal(a.sent[0].content[0].text,'现在请直接执行任务。')
 assert.equal((await h.api('/dsh-mode/state?session=B')).body.pendingManual,false)
})
test('page reload and manual dispatch errors fail closed, without implicit retry or restoring manual tokens', async t=>{
 const h=await harness(t),a=h.add('A'),viewId='view-A-001'
 const transition=async()=>{await h.api('/dsh-mode/state',{sessionId:'A',mode:'plan'});return(await h.api('/dsh-mode/state',{sessionId:'A',mode:'standard',viewId,manualTransition:true})).body}
 await h.api('/dsh-mode/state',{sessionId:'A',viewId,attachView:true})
 const old=await transition()
 await h.api('/dsh-mode/state',{sessionId:'A',viewId:'view-A-002',attachView:true})
 assert.equal((await h.api('/dsh-mode/execute-manual',{sessionId:'A',viewId,manualToken:old.manualToken})).body.code,'STALE_MANUAL')
 await h.api('/dsh-mode/state',{sessionId:'A',viewId,attachView:true})
 const fresh=await transition();let sends=0;a.followup=()=>{sends++;throw Error('transport failed')}
 const payload={sessionId:'A',viewId,manualToken:fresh.manualToken}
 assert.equal((await h.api('/dsh-mode/execute-manual',payload)).body.code,'HANDOFF_FAILED')
 assert.equal((await h.api('/dsh-mode/execute-manual',payload)).body.code,'STALE_MANUAL');assert.equal(sends,1)
})
