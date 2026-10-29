// Focused policy/store contracts. All persistence IO is an in-memory fake filesystem.
import assert from 'node:assert/strict'
import path from 'node:path'
import { PROMPTS, textFor, questionCardsDisabled, denyReason, isReadOnlyCommand } from '../lib/inject.mjs'
import { DEFAULTS, STATE_VERSION, createModeStore, createMemoryModeStore } from '../lib/state.mjs'

let checks = 0
function test(name, fn) {
  fn()
  checks++
  console.log(`ok ${checks} - ${name}`)
}
function virtualIO() {
  const files = new Map()
  const missing = () => Object.assign(new Error('missing'), { code: 'ENOENT' })
  return {
    files,
    mkdirSync() {},
    readFileSync(file) { if (!files.has(file)) throw missing(); return files.get(file) },
    writeFileSync(file, value, options) {
      if (options?.flag === 'wx' && files.has(file)) throw Object.assign(new Error('exists'), { code: 'EEXIST' })
      files.set(file, value)
    },
    renameSync(from, to) { if (!files.has(from)) throw missing(); files.set(to, files.get(from)); files.delete(from) },
    unlinkSync(file) { if (!files.delete(file)) throw missing() },
  }
}

for (const mode of ['plan', 'grill']) {
  test(`${mode}: all domains produce planning, not finished work`, () => {
    const prompt = textFor(mode)
    for (const domain of ['代码', '研究', '分析', '写作', '创作', '设计', '问答', '其他任务']) assert.ok(prompt.includes(domain), domain)
    assert.match(prompt, /适用于所有任务领域/)
    assert.match(prompt, /没有非代码例外/)
    assert.match(prompt, /不得直接交付成品分析、文章、故事或其他最终成果/)
    assert.match(prompt, /完整可执行计划应覆盖目标、成功标准/)
  })
  test(`${mode}: submission is mandatory, distinct from approval and execution`, () => {
    const prompt = textFor(mode)
    assert.match(prompt, /必须在最终回复之前调用 mode_plan_ready/)
    assert.match(prompt, /最终回复中给出完整计划并停止/)
    assert.match(prompt, /仅等待用户执行批准不属于待决需求/)
    assert.match(prompt, /mode_plan_ready 仅标记计划已就绪，不是执行授权/)
    assert.match(prompt, /不得调用后直接动手/)
    assert.match(prompt, /澄清、讨论、草稿或确有未决需求时不得提交/)
  })
  test(`${mode}: research facts, ask only necessary decisions`, () => {
    const prompt = textFor(mode)
    assert.match(prompt, /事实问题必须先用可用的只读工具研究/)
    assert.match(prompt, /只向用户询问无法自行查明、确实影响方案的决策/)
    assert.match(prompt, /不要编造问题/)
    assert.match(prompt, /无法查证的事实应说明限制/)
  })
}
test('PLAN clarifies only if needed, then submits a complete actionable plan', () => {
  assert.match(PROMPTS.plan, /必要澄清结束后一次给出决策完备、可交接执行的完整计划/)
  assert.match(PROMPTS.plan, /信息已经充分就直接写完整可执行计划/)
})
test('GRILL rounds follow dependencies and finish with shared understanding plus plan', () => {
  assert.match(PROMPTS.grill, /prerequisites are already settled/)
  assert.match(PROMPTS.grill, /belongs to a _later_ round/)
  assert.match(PROMPTS.grill, /总结共同理解和已定决策，并给出完整可执行计划/)
  assert.match(PROMPTS.grill, /没有必要问题时直接收束/)
})
test('standard always has exactly zero prompt, even with extra and prefs', () => {
  assert.equal(PROMPTS.standard, '')
  assert.equal(textFor('standard'), '')
  assert.equal(textFor('standard', 'extra', { disablePlanQuestionCard: false }), '')
  assert.equal(textFor('limit'), PROMPTS.limit)
})
test('mode-specific defaults and boolean overrides', () => {
  assert.equal(DEFAULTS.prefs.disablePlanQuestionCard, true)
  assert.equal(DEFAULTS.prefs.disableGrillQuestionCard, false)
  for (const mode of ['plan', 'grill']) {
    const key = mode === 'plan' ? 'disablePlanQuestionCard' : 'disableGrillQuestionCard'
    assert.equal(questionCardsDisabled(mode), mode === 'plan')
    assert.equal(questionCardsDisabled(mode, null), mode === 'plan')
    for (const value of [true, false]) assert.equal(questionCardsDisabled(mode, { [key]: value }), value)
    for (const value of ['false', 'true', 0, 1, null, undefined, {}, []]) assert.equal(questionCardsDisabled(mode, { [key]: value }), mode === 'plan')
  }
  for (const mode of ['standard', 'limit', 'unknown']) assert.equal(questionCardsDisabled(mode, { disablePlanQuestionCard: true, disableGrillQuestionCard: true }), false)
})
test('question-card prompts toggle per mode without manufacturing questions', () => {
  for (const mode of ['plan', 'grill']) {
    const key = mode === 'plan' ? 'disablePlanQuestionCard' : 'disableGrillQuestionCard'
    const off = textFor(mode, 'EXTRA', { [key]: true })
    assert.match(off, /绝不调用 ask_user_question/)
    assert.match(off, /使用编号纯文本/)
    assert.match(off, /不要为提问而提问/)
    assert.ok(off.includes('EXTRA'))
    const on = textFor(mode, '', { [key]: false })
    assert.match(on, /确有必要的决策问题必须使用 ask_user_question/)
    assert.match(on, /不要只为了使用工具而提问/)
    assert.match(on, /工具不可用时，向用户说明不可用并退回编号纯文本提问/)
  }
  assert.match(textFor('plan'), /本模式问题卡已禁用/)
  assert.match(textFor('grill'), /本模式问题卡已启用/)
})

for (const kind of ['durable', 'memory']) {
  test(`${kind} store: normalized preferences preserve session ownership`, () => {
    const io = virtualIO()
    const options = { directory: path.resolve('virtual-planning-policy'), io }
    const store = kind === 'durable' ? createModeStore(options) : createMemoryModeStore()
    assert.equal(store.read().prefs.disablePlanQuestionCard, true)
    assert.equal(store.read().prefs.disableGrillQuestionCard, false)
    store.ensureSession('existing')
    store.setMode('other', 'grill')
    store.patchConfig({ defaultMode: 'plan', prefs: { disablePlanQuestionCard: false, disableGrillQuestionCard: true, leaveDelay: 450 } })
    assert.equal(store.modeFor('existing'), 'standard')
    assert.equal(store.modeFor('other'), 'grill')
    assert.equal(store.ensureSession('new'), 'plan')
    assert.equal(store.read().prefs.disablePlanQuestionCard, false)
    assert.equal(store.read().prefs.disableGrillQuestionCard, true)
    assert.equal(store.read().prefs.leaveDelay, 450)
    store.patchConfig({ prefs: { showModeName: false } })
    assert.equal(store.read().prefs.disablePlanQuestionCard, false)
    assert.equal(store.read().prefs.disableGrillQuestionCard, true)
    const snapshot = store.read()
    snapshot.prefs.disablePlanQuestionCard = true
    assert.equal(store.read().prefs.disablePlanQuestionCard, false)
    if (kind === 'durable') {
      const reopened = createModeStore(options)
      assert.equal(reopened.read().prefs.disablePlanQuestionCard, false)
      assert.equal(reopened.read().prefs.disableGrillQuestionCard, true)
      assert.equal(reopened.modeFor('existing'), 'standard')
      assert.equal(reopened.modeFor('new'), 'plan')
    }
    for (const value of ['false', 'true', 0, 1, null, undefined, {}, []]) {
      store.patchConfig({ prefs: { disablePlanQuestionCard: value, disableGrillQuestionCard: value } })
      assert.equal(store.read().prefs.disablePlanQuestionCard, true)
      assert.equal(store.read().prefs.disableGrillQuestionCard, false)
    }
  })
}
test('durable reads normalize legacy/malformed preference data without changing sessions', () => {
  const io = virtualIO(), directory = path.resolve('virtual-planning-policy')
  const file = path.join(directory, 'state.json')
  io.files.set(file, JSON.stringify({ version: STATE_VERSION, defaultMode: 'grill', sessions: { owned: 'plan' }, prefs: { disablePlanQuestionCard: 'false', disableGrillQuestionCard: 1 } }))
  const store = createModeStore({ directory, io })
  assert.equal(store.modeFor('owned'), 'plan')
  assert.equal(store.read().prefs.disablePlanQuestionCard, true)
  assert.equal(store.read().prefs.disableGrillQuestionCard, false)
  store.patchConfig({ prefs: { disablePlanQuestionCard: false, disableGrillQuestionCard: true } })
  const saved = JSON.parse(io.files.get(file))
  assert.equal(saved.prefs.disablePlanQuestionCard, false)
  assert.equal(saved.prefs.disableGrillQuestionCard, true)
  assert.equal(saved.scope, 'per-session')
  assert.equal(saved.sessions.owned, 'plan')
})
test('existing safety classifier retains representative restrictions', () => {
  assert.equal(isReadOnlyCommand('git status --short'), true)
  assert.equal(isReadOnlyCommand('git status; write bad'), false)
  assert.equal(denyReason('plan', 'ops_bash', { command: 'pwd' }), null)
  assert.ok(denyReason('plan', 'ops_bash', { command: 'npm install' }))
  assert.ok(denyReason('plan', 'write'))
  assert.ok(denyReason('plan', 'subagent'))
  assert.equal(denyReason('grill', 'subagent'), null)
  assert.ok(denyReason('grill', 'ops_bash', { command: 'pwd' }))
  assert.equal(denyReason('standard', 'write'), null)
})
console.log(`PASS ${checks} planning-policy checks (in-memory IO only)`)
