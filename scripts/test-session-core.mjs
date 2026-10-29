import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SessionCore, isTaskInput } from '../lib/session-core.mjs'
import { createMemoryModeStore, createModeStore } from '../lib/state.mjs'

// No default durable store is read or written: all filesystem fixtures live here.
const scripts = path.dirname(fileURLToPath(import.meta.url))
function temporaryStore(t) {
  const directory = fs.mkdtempSync(path.join(scripts, 'session-core-test-'))
  t.after(() => {
    // Fail closed rather than recursively removing an unexpected directory.
    assert.equal(path.dirname(directory), scripts)
    assert.match(path.basename(directory), /^session-core-test-/)
    fs.rmSync(directory, { recursive: true, force: true })
  })
  return { directory, file: path.join(directory, 'state.json'), store: createModeStore({ directory }) }
}
function setup(options = {}) {
  let sequence = 0
  const store = createMemoryModeStore()
  const core = new SessionCore({ store, token: () => `token-${++sequence}`, ...options })
  return { core, store: core.store }
}
const start = (core, sid = 'a', turn = 1) => core.onEvent(sid, { type: 'turn/start', data: { turn } })
const end = (core, sid = 'a', turn = 1, kind = 'completed') => core.onEvent(sid, { type: 'turn/end', data: { turn, reason: { kind, error: { message: 'turn failed' } } } })
const message = (id, kind = 'user') => ({ id, source: { kind }, content: [{ type: 'text', text: id }] })
const admit = (core, sid, input) => core.onEvent(sid, { type: 'user/message', data: { message: input } })
const queue = (core, sid, inputs) => core.onEvent(sid, { type: 'agent/inbox/spliced', data: { inserted: inputs } })
const ownMessage = (id = 'execute-1') => message(id, 'plugin:dsh-mode-widget')
function ready(core, sid = 'a', turn = 1) {
  assert.equal(core.setMode(sid, 'plan').ok, true)
  start(core, sid, turn)
  admit(core, sid, message(`request-${turn}`))
  assert.equal(core.submit(sid, `Complete plan ${turn}`).ok, true)
  assert.equal(core.snapshot(sid).pendingExecution, false, 'submission is not readiness before completion')
  end(core, sid, turn)
  const token = core.snapshot(sid).planToken
  assert.ok(token)
  return token
}

test('selected modes are session-owned; changing the default affects only newly discovered sessions', () => {
  const { core, store } = setup()
  assert.equal(core.selectedMode('a'), 'standard')
  assert.equal(core.setMode('a', 'plan').ok, true)
  assert.equal(core.setMode('b', 'grill').ok, true)
  store.patchConfig({ defaultMode: 'limit' })
  core.refreshConfig()
  assert.equal(core.selectedMode('a'), 'plan')
  assert.equal(core.selectedMode('b'), 'grill')
  assert.equal(core.selectedMode('new'), 'limit')
  assert.equal(store.read().defaultMode, 'limit')
  assert.equal(core.snapshot('a').scope, 'per-session')
  for (const sid of [undefined, '', '__proto__', 'constructor', 'prototype']) {
    assert.throws(() => core.setMode(sid, 'standard'), { code: 'SESSION_REQUIRED' })
  }
  assert.equal(core.setMode('a', 'not-a-mode').code, 'INVALID_MODE')
  assert.equal(store.read().defaultMode, 'limit', 'session selection cannot mutate the global default')
})

test('user mode selection is deferred to the next turn and cannot weaken the active turn', () => {
  const { core } = setup()
  core.setMode('a', 'limit')
  start(core)
  core.setMode('a', 'plan')
  let status = core.snapshot('a')
  assert.equal(status.mode, 'limit')
  assert.equal(status.selectedMode, 'plan')
  assert.equal(status.modePending, true)
  assert.equal(core.submit('a', 'not a planning turn').code, 'NOT_PLANNING')
  end(core)
  start(core, 'a', 2)
  assert.equal(core.effectiveMode('a'), 'plan')
  core.setMode('a', 'standard')
  assert.equal(core.effectiveMode('a'), 'plan')
  assert.equal(core.submit('a', 'still a planning turn').code, 'MODE_CHANGED', 'frozen mode does not restore eligibility after a new user mode selection')
  end(core, 'a', 2)
  start(core, 'a', 3)
  assert.equal(core.effectiveMode('a'), 'standard')
})

test('prompt signals bind tools to the exact active turn; stale, aborted and cross-session bindings fail closed', () => {
  const { core } = setup()
  core.setMode('a', 'plan')
  start(core)
  const signal = new AbortController().signal
  assert.equal(core.promptMode({ agent: { id: 'a' }, signal }), 'plan')
  const exec = { agent: { id: 'a' }, signal }
  assert.equal(core.bindTool(exec), null)
  assert.equal(core.submitExecution(exec, 'bound plan').ok, true)
  end(core)
  start(core, 'a', 2)
  assert.equal(core.bindTool(exec).code, 'STALE_TOOL_TURN')
  assert.equal(core.bindTool({ agent: { id: 'a' }, signal }).code, 'STALE_TOOL_TURN')
  start(core, 'b')
  assert.equal(core.bindTool({ agent: { id: 'b' }, signal }).code, 'STALE_TOOL_TURN')
  const aborted = new AbortController()
  aborted.abort()
  assert.equal(core.bindTool({ agent: { id: 'a' }, signal: aborted.signal }).code, 'STALE_TOOL_TURN')
  assert.equal(core.bindTool({ agent: { id: 'idle' } }).code, 'STALE_TOOL_TURN')
})

test('mid-turn plugin load uses a restrictive unknown-turn mode and refuses readiness until a new tracked turn', () => {
  const { core } = setup()
  const agent = { id: 'a', session: { id: 'a', snapshotEvents: () => [{ type: 'turn/start', data: { turn: 7 } }] } }
  assert.equal(core.promptMode({ agent }), 'limit')
  assert.equal(core.submit('a', 'unknown plan').code, 'TURN_NOT_TRACKED')
  end(core, 'a', 7)
  assert.equal(core.effectiveMode('a'), 'standard')
})

test('known context injections are ignored in both queued and admitted paths, including after plan completion', () => {
  const { core } = setup()
  const token = ready(core)
  const revision = core.entry('a').inputRevision
  for (const kind of ['runtime-context', 'skill-catalog', 'model-selection', 'ptc-mode', 'tool-context']) {
    const input = message(`context-${kind}`, kind)
    assert.equal(isTaskInput(input), false)
    queue(core, 'a', [input])
    core.claimedInput('a', input, 1)
    admit(core, 'a', input)
  }
  assert.equal(core.entry('a').inputRevision, revision)
  assert.equal(core.snapshot('a').planToken, token)
  for (const kind of ['user', 'parent', 'hook', 'plugin:another-plugin']) assert.equal(isTaskInput(message(kind, kind)), true)
  assert.equal(isTaskInput({ id: 'legacy' }), true)
})

test('official queued + claimed + admitted message lifecycle deduplicates IDs, including the initial multi-message batch', () => {
  const { core } = setup()
  core.setMode('a', 'plan')
  const batch = [message('first'), message('second', 'parent')]
  queue(core, 'a', batch)
  start(core)
  for (const input of batch) {
    core.claimedInput('a', input, 1)
    admit(core, 'a', input)
    admit(core, 'a', input)
  }
  assert.equal(core.entry('a').inputRevision, 2)
  assert.equal(core.entry('a').queued.size, 0)
  assert.equal(core.submit('a', 'batch plan').ok, true)
  // Repeated delivery of an already admitted request is not newer input.
  queue(core, 'a', batch)
  for (const input of batch) admit(core, 'a', input)
  end(core)
  assert.equal(core.snapshot('a').pendingExecution, true)
})

test('un-queued initial admitted batch is one starting context, not a later demand', () => {
  const { core } = setup()
  core.setMode('a', 'grill')
  start(core)
  admit(core, 'a', message('initial-one'))
  admit(core, 'a', message('initial-two'))
  assert.equal(core.submit('a', 'complete initial batch').ok, true)
  end(core)
  assert.equal(core.snapshot('a').pendingExecution, true)
})

test('newer queued input revokes readiness before user/message is logged and supersedes an active submitted plan', () => {
  const { core } = setup()
  const old = ready(core)
  queue(core, 'a', [message('newer')])
  assert.equal(core.snapshot('a').pendingExecution, false)
  assert.equal(core.consume('a', old).code, 'STALE_PLAN')
  start(core, 'a', 2)
  core.claimedInput('a', message('newer'), 2)
  admit(core, 'a', message('newer'))
  assert.equal(core.submit('a', 'new plan').ok, true)
  queue(core, 'a', [message('even-newer')])
  assert.equal(core.submit('a', 'late marker').code, 'PLAN_SUPERSEDED')
  end(core, 'a', 2)
  assert.equal(core.snapshot('a').pendingExecution, false)
})

test('readiness requires a matching normal completion; error/abort and missing or invalid submissions cannot arm it', () => {
  for (const kind of ['error', 'aborted', 'blocked', 'interrupted', 'max-tokens']) {
    const { core } = setup()
    core.setMode('a', 'plan')
    start(core)
    assert.equal(core.submit('a', 'complete').ok, true)
    end(core, 'a', 99)
    assert.equal(core.snapshot('a').pendingExecution, false)
    end(core, 'a', 1, kind)
    assert.equal(core.snapshot('a').pendingExecution, false, kind)
  }
  const { core } = setup()
  assert.equal(core.submit('a', 'no turn').code, 'NO_ACTIVE_TURN')
  core.setMode('a', 'plan')
  start(core)
  assert.equal(core.submit('a', '   ').code, 'PLAN_TITLE_REQUIRED')
  end(core)
  assert.equal(core.snapshot('a').pendingExecution, false)
})

test('stale/cross-session tokens, disabled preference and expiration fail closed; a valid token is consumed once', () => {
  let now = 1000
  const { core, store } = setup({ now: () => now, ttl: 100 })
  const first = ready(core)
  const other = ready(core, 'b')
  assert.equal(core.consume('b', first).code, 'STALE_PLAN')
  assert.equal(core.consume('a', 'wrong').code, 'STALE_PLAN')
  store.patchConfig({ prefs: { autoStart: false } })
  assert.equal(core.consume('a', first).code, 'STALE_PLAN')
  store.patchConfig({ prefs: { autoStart: true } })
  assert.equal(core.consume('a', first).ok, true)
  assert.equal(core.consume('a', first).code, 'STALE_PLAN')
  now += 100
  assert.equal(core.snapshot('b').statusCode, 'PLAN_EXPIRED')
  assert.equal(core.consume('b', other).code, 'STALE_PLAN')
})

for (const asynchronous of [false, true]) {
  test(`execute ${asynchronous ? 'asynchronous rejection' : 'synchronous throw'} rolls back only its own mode write and never restores a consumed token`, async () => {
    const { core } = setup()
    const token = ready(core)
    let calls = 0
    const fail = () => { calls++; throw new Error('transport failed') }
    const result = await core.execute('a', token, { message: ownMessage(), send: asynchronous ? async () => fail() : fail })
    assert.equal(result.code, 'HANDOFF_FAILED')
    assert.equal(calls, 1)
    assert.equal(core.selectedMode('a'), 'plan')
    assert.equal(core.snapshot('a').execution.phase, 'failed')
    assert.equal(core.snapshot('a').planToken, null)
    assert.equal((await core.execute('a', token, { message: ownMessage(), send: fail })).code, 'STALE_PLAN')
    assert.equal(calls, 1)
  })
}

for (const choice of ['limit', 'standard']) {
test(`CAS rollback preserves a later user choice of ${choice}${choice === 'standard' ? ' even when unchanged from the handoff mode' : ''}`, async () => {
  const { core } = setup()
  const token = ready(core)
  const input = ownMessage()
  const result = await core.execute('a', token, { message: input, send: async () => {
    queue(core, 'a', [input])
    start(core, 'a', 2)
    core.claimedInput('a', input, 2)
    admit(core, 'a', input)
    assert.equal(core.setMode('a', choice).ok, true)
    throw new Error('late sender rejection')
  } })
  assert.equal(result.code, 'HANDOFF_ACCEPTED_WITH_ERROR')
  assert.equal(core.effectiveMode('a'), 'standard', 'execution turn stays frozen')
  assert.equal(core.selectedMode('a'), choice)
  end(core, 'a', 2, 'error')
  assert.equal(core.selectedMode('a'), choice, 'failed own turn must preserve the newer user choice')
  assert.equal(core.snapshot('a').execution.phase, 'failed')
})
}

test('only the correlated own execution turn error triggers rollback; unrelated session/turn errors do not', async () => {
  const { core } = setup()
  const token = ready(core)
  const input = ownMessage()
  let sends = 0
  assert.equal((await core.execute('a', token, { message: input, send: () => { sends++; queue(core, 'a', [input]) } })).ok, true)
  assert.equal(core.setMode('a', 'grill').code, 'HANDOFF_IN_PROGRESS')
  end(core, 'a', 999, 'error')
  start(core, 'b', 2)
  end(core, 'b', 2, 'error')
  assert.equal(core.selectedMode('a'), 'standard')
  assert.equal(core.snapshot('a').execution.phase, 'queued')
  start(core, 'a', 2)
  core.claimedInput('a', input, 2)
  admit(core, 'a', input)
  assert.equal(core.entry('a').inputRevision, 1, 'own execute input is not a new human demand')
  end(core, 'a', 2, 'error')
  assert.equal(core.selectedMode('a'), 'plan')
  assert.equal(core.snapshot('a').statusCode, 'EXECUTION_FAILED')
  assert.equal(core.snapshot('a').pendingExecution, false)
  assert.equal(sends, 1)
})

test('a throw after enqueue is accepted exactly once and does not roll back the executing mode', async () => {
  const { core } = setup()
  const token = ready(core)
  const input = ownMessage()
  let sends = 0
  const send = () => { sends++; queue(core, 'a', [input]); throw new Error('after enqueue') }
  assert.equal((await core.execute('a', token, { message: input, send })).code, 'HANDOFF_ACCEPTED_WITH_ERROR')
  assert.equal(core.selectedMode('a'), 'standard')
  assert.equal((await core.execute('a', token, { message: input, send })).code, 'STALE_PLAN')
  assert.equal(sends, 1)
})

test('failed mode persistence sends zero execution messages and exposes the write failure', async () => {
  const store = createMemoryModeStore()
  const { core } = setup({ store })
  const token = ready(core)
  store.setMode = () => { throw Object.assign(new Error('disk unavailable'), { code: 'STATE_WRITE_FAILED' }) }
  let sends = 0
  const result = await core.execute('a', token, { message: ownMessage(), send: () => { sends++ } })
  assert.equal(result.code, 'STATE_WRITE_FAILED')
  assert.equal(sends, 0)
  assert.equal(core.selectedMode('a'), 'plan')
  assert.equal(core.snapshot('a').pendingExecution, false)
})

test('durable rename failure dispatches zero messages, preserves the previous mode and cleans partial writes', async t => {
  const { directory } = temporaryStore(t)
  let rejectRename = false
  const store = createModeStore({ directory, io: {
    ...fs,
    renameSync(...args) {
      if (rejectRename) throw Object.assign(new Error('simulated atomic rename failure'), { code: 'EIO' })
      return fs.renameSync(...args)
    },
  } })
  const { core } = setup({ store })
  const token = ready(core)
  rejectRename = true
  let sends = 0
  const result = await core.execute('a', token, { message: ownMessage(), send: () => { sends++ } })
  assert.equal(result.code, 'STATE_WRITE_FAILED')
  assert.equal(sends, 0)
  assert.equal(store.lastWriteSucceeded(), false)
  assert.equal(createModeStore({ directory }).modeFor('a'), 'plan')
  assert.deepEqual(fs.readdirSync(directory), ['state.json'])
})

test('V1 migration preserves defaults/preferences, discards stale sessions, backs up exact original, and is idempotent across V2 restart', t => {
  const { directory, file, store } = temporaryStore(t)
  const original = JSON.stringify({ version: 1, scope: 'global', defaultMode: 'grill', sessions: { stale: 'limit' }, prefs: { leaveDelay: 712, bounce: 'strong', autoStart: false } }, null, 2)
  fs.writeFileSync(file, original)
  assert.equal(store.read().defaultMode, 'grill')
  assert.deepEqual(store.read().sessions, {})
  assert.equal(store.read().prefs.leaveDelay, 712)
  assert.equal(fs.existsSync(file + '.v1.bak'), false, 'reading alone does not mutate V1')
  assert.equal(store.ensureSession('fresh'), 'grill')
  store.setMode('fresh', 'plan')
  assert.equal(fs.readFileSync(file + '.v1.bak', 'utf8'), original)
  const firstV2 = fs.readFileSync(file, 'utf8')
  const restarted = createModeStore({ directory })
  assert.equal(restarted.ensureSession('fresh'), 'plan')
  assert.equal(fs.readFileSync(file, 'utf8'), firstV2, 'existing V2 sessions do not trigger migration writes')
  assert.equal(restarted.read().version, 2)
  assert.equal(restarted.read().scope, 'per-session')
  assert.equal(restarted.read().prefs.autoStart, false)
  assert.equal(restarted.read().prefs.bounce, 'strong')
  assert.deepEqual(restarted.read().sessions, { fresh: 'plan' })
  restarted.patchConfig({ defaultMode: 'limit' })
  assert.equal(restarted.modeFor('fresh'), 'plan')
  assert.equal(restarted.ensureSession('new'), 'limit')
  assert.equal(fs.readFileSync(file + '.v1.bak', 'utf8'), original)
  assert.throws(() => restarted.patchConfig({ scope: 'global' }), { code: 'SCOPE_PER_SESSION_ONLY' })
})

test('corrupt or unsupported durable state fails closed without overwriting data or dispatching a message', async t => {
  const { file, store } = temporaryStore(t)
  for (const corrupt of ['{broken', JSON.stringify({ version: 999, defaultMode: 'standard' })]) {
    fs.writeFileSync(file, corrupt)
    assert.throws(() => store.read(), { code: 'STATE_READ_FAILED' })
    assert.throws(() => store.setMode('a', 'standard'), { code: 'STATE_READ_FAILED' })
    const { core } = setup({ store })
    let sends = 0
    await assert.rejects(core.execute('a', 'unknown', { message: ownMessage(), send: () => { sends++ } }), { code: 'STATE_READ_FAILED' })
    assert.equal(sends, 0)
    assert.equal(fs.readFileSync(file, 'utf8'), corrupt)
  }
})

test('release/disposal retains the durable selected mode but clears active turns, bindings and execution tokens across restart', t => {
  const { directory, store } = temporaryStore(t)
  const { core } = setup({ store })
  const token = ready(core)
  core.release('a')
  assert.equal(core.selectedMode('a'), 'plan')
  assert.equal(core.snapshot('a').planToken, null)
  assert.equal(core.snapshot('a').statusCode, 'SESSION_UNLOADED')
  assert.equal(core.consume('a', token).code, 'STALE_PLAN')
  start(core, 'a', 2)
  const signal = new AbortController().signal
  core.promptMode({ agent: { id: 'a' }, signal })
  core.forget('a')
  assert.equal(core.bindTool({ agent: { id: 'a' }, signal }).code, 'STALE_TOOL_TURN')
  const restarted = new SessionCore({ store: createModeStore({ directory }) })
  assert.equal(restarted.selectedMode('a'), 'plan')
  assert.equal(restarted.snapshot('a').pendingExecution, false)
  assert.equal(restarted.consume('a', token).code, 'STALE_PLAN')
  const persisted = JSON.parse(fs.readFileSync(path.join(directory, 'state.json'), 'utf8'))
  assert.deepEqual(persisted.sessions, { a: 'plan' })
  assert.equal(JSON.stringify(persisted).includes(token), false)
})
