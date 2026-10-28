// Exercise the exact shipped state reducer/action code, not a separately reimplemented client.
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import vm from 'node:vm'
const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const reducer = source.slice(source.indexOf('  function applyPlanState('), source.indexOf('  function paint()'))
const execute = source.slice(source.indexOf('  function fireExecute()'), source.indexOf('  // 偏好面板'))
function fixture() {
  const timers = new Map(); let next = 1
  const scope = {
    state: { mode: 'standard', selectedMode: 'standard', protocolVersion: null, planRevision: -1, pending: false, planToken: null, prefs: {} },
    disposed: false, EXPECTED_PROTOCOL: 2, planEpoch: null, retiredPlanEpochs: new Set(),
    streamEpoch: null, streamDisconnected: false, httpSequence: 0, acceptedHttpSequence: 0, planExpiryTimer: null,
    badge: { title: '' }, arrowEl: { title: '', disabled: false }, ZH: { plan: '计划', standard: '标准' },
    sessionId: 'a', paint() {}, syncPanel() {}, Date,
    setTimeout(fn) { const id = next++; timers.set(id, fn); return id }, clearTimeout(id) { timers.delete(id) },
    fetch() { throw new Error('Unexpected HTTP request') },
  }
  vm.createContext(scope); vm.runInContext(reducer + '\n' + execute, scope)
  return { s: scope, timers }
}
const status = (epoch, revision, mode = 'plan', token = 'token') => ({
  ok: true, protocolVersion: 2, coreBuild: 'test', planEpoch: epoch, planRevision: revision,
  mode, selectedMode: mode, modePending: false, pendingExecution: !!token, planToken: token,
  planTitle: token, planExpiresAt: Date.now() + 60000, prefs: {}, scope: 'per-session',
})
const flush = () => new Promise(resolve => setImmediate(resolve))

test('mode and eligibility share revision fencing: old mode response cannot overwrite current SSE mode', () => {
  const { s } = fixture()
  assert(s.applyPlanState(status('host', 5, 'plan', 'A'), true))
  assert.equal(s.applyState(status('host', 4, 'standard', null)), false)
  assert.equal(s.state.mode, 'plan'); assert.equal(s.state.planToken, 'A')
  assert(s.applyPlanState(status('host', 6, 'plan', null), true))
  assert.equal(s.applyState(status('host', 5, 'plan', 'A')), false)
  assert.equal(s.state.pending, false)
})
test('unseen old HTTP epoch cannot retire the first authoritative new SSE epoch', () => {
  const { s } = fixture()
  assert(s.applyPlanState(status('new', 10, 'limit', null), true))
  assert.equal(s.applyState({ ...status('old', 1, 'standard', 'A'), clientRequestSequence: 1 }), false)
  assert(s.applyPlanState(status('new', 11, 'limit', null), true))
  assert.equal(s.planEpoch, 'new'); assert.equal(s.state.mode, 'limit')
})
test('without a stream, stale earlier HTTP requests cannot switch an unseen host epoch backwards', () => {
  const { s } = fixture()
  assert(s.applyState({ ...status('new', 1), clientRequestSequence: 2 }))
  assert.equal(s.applyState({ ...status('old', 90), clientRequestSequence: 1 }), false)
  assert.equal(s.planEpoch, 'new')
})
test('a new stream epoch resets revision; prior epoch updates and old error envelopes cannot disable it', () => {
  const { s } = fixture()
  s.applyPlanState(status('A', 90), true)
  assert(s.applyPlanState(status('B', 0, 'standard', null), true))
  assert.equal(s.applyPlanState(status('A', 91), true), false)
  assert.equal(s.applyState({ ok: false, protocolVersion: 1, planEpoch: 'A' }), false)
  assert.equal(s.planEpoch, 'B'); assert.equal(s.state.protocolVersion, 2)
})
test('protocol mismatch fails closed and gives an actionable restart reason', () => {
  const { s } = fixture()
  assert.equal(s.applyState({ ok: true, mode: 'plan', pendingExecution: true, planToken: 'old' }), false)
  assert.equal(s.state.protocolVersion, null); assert.equal(s.state.pending, false)
  assert(s.badge.title.includes('重启'))
})
test('mode-deferred state displays frozen mode and describes next-turn selection without optimistic mutation', () => {
  const { s } = fixture()
  s.applyPlanState({ ...status('A', 1), selectedMode: 'standard', modePending: true }, true)
  assert.equal(s.state.mode, 'plan'); assert.equal(s.state.selectedMode, 'standard')
  assert(s.badge.title.includes('下一轮生效'))
})
test('expiry and stream disconnect cannot be undone by a delayed ready GET', () => {
  const { s, timers } = fixture()
  s.applyPlanState(status('A', 1), true)
  for (const expire of timers.values()) expire()
  assert.equal(s.state.pending, false)
  assert(s.applyState({ ...status('A', 1), planExpiresAt: Date.now() - 1 }))
  assert.equal(s.state.pending, false)
  s.streamDisconnected = true
  assert.equal(s.applyState(status('A', 2)), false)
  assert.equal(s.state.pending, false)
})
test('late failed execute A transport does not clear newer eligible B or overwrite its state', async () => {
  const { s } = fixture()
  let reject
  s.fetch = () => new Promise((_resolve, fail) => { reject = fail })
  s.applyPlanState(status('host', 1, 'plan', 'A'), true)
  s.fireExecute()
  s.applyPlanState(status('host', 2, 'plan', null), true)
  s.applyPlanState(status('host', 3, 'plan', 'B'), true)
  reject(new Error('network failure')); await flush(); await flush()
  assert.equal(s.state.planToken, 'B'); assert(s.state.pending); assert.equal(s.arrowEl.disabled, false)
})
test('failed execute transport clears only its own unchanged eligibility', async () => {
  const { s } = fixture()
  s.fetch = () => Promise.reject(new Error('network failure'))
  s.applyPlanState(status('host', 1, 'plan', 'A'), true)
  s.fireExecute(); await flush(); await flush()
  assert.equal(s.state.pending, false); assert.equal(s.state.planToken, null)
  assert(s.badge.title.includes('连接失败'))
})
