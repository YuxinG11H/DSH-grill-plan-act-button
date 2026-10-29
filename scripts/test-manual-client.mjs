// Run the shipped functions directly, with only DOM/network/timer boundaries stubbed.
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import vm from 'node:vm'
const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const between = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)))
const reducer = between('  function applyPlanState(', '  function paint()')
const actions = between('  function clearManual()', '  // 偏好面板')
const api = between('  function api(', '  function applyPlanState(')
const mode = between('  function setMode(', '  function syncPanel(')
const paint = between('  function paint()', '  function setMode(')
const flush = async () => { await new Promise(resolve => setImmediate(resolve)) }
function fixture() {
  const classes = new Set(), attrs = new Map(), errors = [], calls = []
  const scope = {
    EXPECTED_PROTOCOL: 3, viewId: 'local-view', viewAttached: true,
    attemptedManualTokens: new Set(), attemptedPlanTokens: new Set(), executeInFlight: false,
    state: { mode: 'standard', prefs: {}, planRevision: -1, pending: false, planToken: null },
    disposed: false, streamDisconnected: false, streamEpoch: null, planEpoch: null,
    retiredPlanEpochs: new Set(), httpSequence: 0, acceptedHttpSequence: 0, planExpiryTimer: null,
    sessionId: 'session', location: { href: 'http://fixture/' },
    badge: { title: '', querySelectorAll: () => [] },
    arrowEl: { title: '', setAttribute: (k, v) => attrs.set(k, v), removeAttribute: k => attrs.delete(k) },
    statusHelp: {}, manualHelp: { id: 'manual-help' }, errorEl: { hidden: true },
    nameEl: {}, slot: { style: {} }, wheel: { querySelectorAll: () => [] },
    root: { classList: { remove: c => classes.delete(c) } },
    pill: { classList: { toggle: (c, on) => on ? classes.add(c) : classes.delete(c) } },
    ZH: { standard: '标准', plan: '计划' }, EN: { standard: 'BASE', plan: 'PLAN' },
    MANUAL_WARNING: 'manual warning', syncPanel() {},
    reportError: message => errors.push(message), setTimeout: () => 1, clearTimeout() {}, Date,
    fetch: (url, opts) => { calls.push({ url, opts }); return Promise.resolve({ ok: true, json: async () => snapshot() }) },
  }
  vm.createContext(scope)
  vm.runInContext(reducer + actions + api + mode + paint, scope)
  return { s: scope, classes, attrs, errors, calls }
}
function snapshot(overrides = {}) {
  return {
    ok: true, protocolVersion: 3, planEpoch: 'epoch', planRevision: 1,
    mode: 'standard', selectedMode: 'standard', modePending: false,
    pendingExecution: false, planToken: null, prefs: {}, viewId: 'local-view',
    pendingManual: true, manualToken: 'manual-A', manualViewId: 'local-view',
    statusCode: 'manual-ready', statusReason: '未提交完整计划标记', ...overrides,
  }
}
test('manual requires attached matching view, standard, settled mode, and no blue', () => {
  const { s } = fixture()
  s.applyPlanState(snapshot(), true)
  assert(s.manualEligible())
  for (const change of [
    { manualViewId: 'old' }, { viewId: 'new-owner' }, { mode: 'plan' },
    { modePending: true }, { pendingManual: false },
    { pendingExecution: true, planToken: 'blue-A' },
  ]) {
    s.applyPlanState(snapshot(change), true)
    assert.equal(s.manualEligible(), false, JSON.stringify(change))
  }
  s.applyPlanState(snapshot(), true)
  s.viewAttached = false
  assert.equal(s.manualEligible(), false)
})
test('manual click is one shot; same-revision delayed snapshot cannot restore nonce', async () => {
  const { s, calls, classes, attrs } = fixture()
  s.applyPlanState(snapshot(), true)
  assert(classes.has('manual')); assert.equal(attrs.get('aria-label'), '手动继续')
  s.fireExecute(); s.fireExecute()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, '/dsh-mode/execute-manual')
  assert.deepEqual(JSON.parse(calls[0].opts.body), { sessionId: 'session', manualToken: 'manual-A', viewId: 'local-view' })
  await flush()
  s.applyPlanState(snapshot(), true)
  assert.equal(s.manualEligible(), false)
  assert(!classes.has('manual')); assert.equal(s.state.silent, true)
  s.fireExecute(); assert.equal(calls.length, 1)
})
test('normal blue retains exact endpoint/payload and wins over manual', async () => {
  const { s, calls } = fixture()
  s.fetch = (url, opts) => { calls.push({ url, opts }); return Promise.resolve({ ok: true, json: async () => snapshot({ pendingManual: false, manualToken: null }) }) }
  s.applyPlanState(snapshot({ pendingExecution: true, planToken: 'blue-A' }), true)
  s.fireExecute(); s.fireExecute(); await flush()
  assert.equal(calls.length, 1); assert.equal(calls[0].url, '/dsh-mode/execute')
  assert.deepEqual(JSON.parse(calls[0].opts.body), { sessionId: 'session', planToken: 'blue-A' })
  s.applyPlanState(snapshot({ pendingExecution: true, planToken: 'blue-A' }), true)
  s.fireExecute(); assert.equal(calls.length, 1)
})
test('manual network and server errors remain visible and never retry nonce', async () => {
  for (const serverError of [false, true]) {
    const { s, errors } = fixture(); let requests = 0
    s.fetch = () => {
      requests++
      return serverError ? Promise.resolve({ ok: false, json: async () => snapshot({ ok: false, reason: 'server denied' }) }) : Promise.reject(new Error('offline'))
    }
    s.applyPlanState(snapshot(), true); s.fireExecute(); await flush()
    assert.equal(errors.length, 1)
    s.applyPlanState(snapshot(), true); s.fireExecute(); await flush()
    assert.equal(requests, 1); assert.equal(s.manualEligible(), false)
  }
})
test('late blue/manual transport failure preserves newer manual eligibility without obsolete error', async () => {
  for (const initialBlue of [false, true]) {
    for (const newEpoch of [false, true]) {
      const { s, errors } = fixture()
      let reject
      s.fetch = () => new Promise((_resolve, fail) => { reject = fail })
      s.applyPlanState(snapshot(initialBlue ? { pendingExecution: true, planToken: 'blue-A' } : {}), true)
      s.fireExecute()
      s.applyPlanState(snapshot({ planEpoch: newEpoch ? 'new-epoch' : 'epoch', planRevision: 2, manualToken: 'manual-B' }), true)
      reject(new Error('late offline'))
      await flush()
      assert.equal(s.state.manualToken, 'manual-B')
      assert(s.state.pendingManual); assert(s.manualEligible())
      assert.equal(errors.length, 0); assert.equal(s.executeInFlight, false)
    }
  }
})
test('late same-token failure from an old epoch cannot alter current epoch', async () => {
  const { s, errors } = fixture()
  let reject
  s.fetch = () => new Promise((_resolve, fail) => { reject = fail })
  s.applyPlanState(snapshot(), true); s.fireExecute()
  s.applyPlanState(snapshot({ planEpoch: 'new-epoch', planRevision: 0 }), true)
  reject(new Error('old epoch offline')); await flush()
  assert.equal(s.state.manualToken, 'manual-A')
  assert.equal(errors.length, 0)
})
test('epochs/revisions fence stale HTTP and protocol mismatch clears manual', () => {
  const { s } = fixture()
  s.applyPlanState(snapshot({ planRevision: 8 }), true)
  assert.equal(s.applyState(snapshot({ planRevision: 7, manualToken: 'old' })), false)
  assert.equal(s.applyState(snapshot({ planEpoch: 'old-epoch', planRevision: 90 })), false)
  assert.equal(s.state.manualToken, 'manual-A')
  s.applyPlanState(snapshot({ protocolVersion: 2 }), true)
  assert.equal(s.state.pendingManual, false); assert.equal(s.state.manualToken, null)
  assert.equal(s.manualEligible(), false)
})
test('wheel cannot transition before attach; only mode transition carries flag', async () => {
  const { s, calls } = fixture()
  s.applyPlanState(snapshot(), true)
  s.viewAttached = false; s.setMode('plan'); assert.equal(calls.length, 0)
  s.viewAttached = true; s.setMode('plan'); await flush()
  let payload = JSON.parse(calls[0].opts.body)
  assert.equal(payload.manualTransition, true); assert.equal(payload.viewId, 'local-view')
  await s.api({ sessionId: 'session', prefs: { disablePlanQuestionCard: false } })
  payload = JSON.parse(calls[1].opts.body)
  assert.equal(payload.viewId, 'local-view'); assert.equal(payload.manualTransition, undefined)
  assert.equal(payload.mode, undefined)
})
test('initial attach uses POST and build marker, labeled boolean preferences are present', () => {
  assert(source.includes('var EXPECTED_PROTOCOL = 3'))
  assert(source.includes("method: attach ? 'POST' : 'PUT'"))
  assert(source.includes('attachView: true }, true)'))
  assert(source.includes('composer-slot-v1/session-core-v3'))
  assert(source.includes('crypto.randomUUID()'))
  assert(source.includes('禁用 PLAN 问题卡片<input data-k="disablePlanQuestionCard" type="checkbox" checked>'))
  assert(source.includes('禁用 GRILL 问题卡片<input data-k="disableGrillQuestionCard" type="checkbox">'))
  assert(source.includes("e.target.type === 'checkbox' ? e.target.checked"))
})
test('ordinary status never opens an extra dark popup; manual risk help is retained',()=>{
 assert(!source.includes("helpOnFocusAndHover(badge, 'badge-help')"))
 assert(!source.includes('.dm-root.badge-help .dm-status-help{display:block}'))
 assert(source.includes('.dm-root.manual-help .dm-manual-help{display:block}'))
 assert(source.includes("helpOnFocusAndHover(arrowEl, 'manual-help', manualEligible)"))
})
