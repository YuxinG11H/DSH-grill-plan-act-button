import { randomUUID } from 'node:crypto'
import { createMemoryModeStore, isMode, requireSessionId } from './state.mjs'

export const PROTOCOL_VERSION = 3
export const CORE_BUILD = 'session-core-v3-planning-manual'
const PLANNING = new Set(['plan', 'grill'])
const outstanding = e => e && ['dispatching', 'queued', 'running'].includes(e.phase)
export function isTaskInput(message) {
  const kind = message?.source?.kind
  // Explicit legacy policy: an untagged old message is a request. Tagged context is not.
  return kind === undefined || kind === 'user' || kind === 'parent' || kind === 'hook' || (typeof kind === 'string' && kind.startsWith('plugin:'))
}
const failure = (code, reason) => ({ ok: false, code, reason })

export class SessionCore {
  constructor({ store = createMemoryModeStore(), now = Date.now, token = randomUUID,
    ttl = 10 * 60 * 1000, onChange = () => {} } = {}) {
    this.store = store; this.now = now; this.token = token; this.ttl = ttl
    this.epoch = randomUUID(); this.startedAt = now(); this.onChange = onChange
    this.sessions = new Map()
    this.promptBindings = new WeakMap()
    this.toolBindings = new WeakMap()
  }
  entry(sid) {
    requireSessionId(sid)
    let s = this.sessions.get(sid)
    if (!s) {
      this.store.ensureSession(sid)
      s = { revision: 0, modeRevision: 0, inputRevision: 0, active: null, ready: null, manual: null, viewId: null,
        execution: null, reason: '尚无完整计划', code: 'NO_PLAN', inputs: new Set(), queued: new Set(), unknownTurn: null }
      this.sessions.set(sid, s)
    }
    return s
  }
  publish(sid, s) { s.revision++; this.onChange(sid) }
  selectedMode(sid) { this.entry(sid); return this.store.modeFor(sid) }
  effectiveMode(sid) {
    if (!sid) return 'standard'
    const s = this.entry(sid)
    return s.active?.mode || (s.unknownTurn !== null ? 'limit' : this.store.modeFor(sid))
  }
  observeSession(session) {
    if (!session?.id) return
    const s = this.entry(session.id)
    if (s.active) return
    const events = typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : session.events
    if (!Array.isArray(events)) return
    const boundary = events.findLast(e => e.type === 'turn/start' || e.type === 'turn/end')
    if (boundary?.type === 'turn/start' && s.unknownTurn !== boundary.data?.turn) {
      s.unknownTurn = boundary.data?.turn
      s.ready = null; s.code = 'TURN_NOT_TRACKED'; s.reason = '插件在本轮中途加载，无法确认轮次模式；请结束本轮后重新发起'
      this.publish(session.id, s)
    }
  }
  promptMode(context) {
    const sid = context?.agent?.id
    if (!sid) return 'standard'
    this.observeSession(context.agent.session)
    const s = this.entry(sid)
    if (context.signal && typeof context.signal === 'object') this.promptBindings.set(context.signal, { sid, active: s.active })
    return this.effectiveMode(sid)
  }
  bindTool(exec) {
    if (!exec?.agent?.id) return null
    const sid = exec.agent.id
    this.observeSession(exec.agent.session)
    const s = this.entry(sid)
    let binding = this.toolBindings.get(exec)
    if (!binding) {
      binding = exec.signal && this.promptBindings.get(exec.signal) || { sid, active: s.active }
      this.toolBindings.set(exec, binding)
    }
    if (exec.signal?.aborted || binding.sid !== sid || !binding.active || binding.active !== s.active) {
      return failure('STALE_TOOL_TURN', '工具所属轮次已结束或未被当前插件跟踪，请在新轮次重试')
    }
    return null
  }
  submitExecution(exec, title) {
    const stale = this.bindTool(exec)
    if (stale) return stale
    return this.submit(exec?.agent?.id, title)
  }
  attachView(sid, viewId) {
    const s = this.entry(sid)
    if (typeof viewId !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(viewId)) return failure('VIEW_REQUIRED', '需要当前页面实例标识')
    if (s.viewId !== viewId) {
      if (s.manual) { s.manual = null; s.code = 'MANUAL_CLEARED'; s.reason = '页面已重新加载，手动继续资格已清除' }
      s.viewId = viewId; this.publish(sid, s)
    }
    return { ok: true }
  }
  setMode(sid, mode, { manualTransition = false, viewId } = {}) {
    const s = this.entry(sid)
    if (!isMode(mode)) return failure('INVALID_MODE', '无效模式')
    if (manualTransition && (!viewId || s.viewId !== viewId)) return failure('STALE_VIEW', '当前页面实例已失效，请重新加载后切换')
    if (outstanding(s.execution) && s.execution.phase !== 'running') return failure('HANDOFF_IN_PROGRESS', '执行请求正在交接，稍后再切换模式')
    const previousMode = this.store.modeFor(sid)
    try { this.store.setMode(sid, mode) }
    catch (error) { return this.recordError(sid, s, error.code || 'STATE_WRITE_FAILED', error.message) }
    s.modeRevision++; s.ready = null; s.manual = null
    if (manualTransition && PLANNING.has(previousMode) && mode === 'standard' && !outstanding(s.execution) && !s.queued.size && s.unknownTurn === null) {
      s.manual = { token: this.token(), viewId, fromMode: previousMode, inputRevision: s.inputRevision }
    }
    s.code = s.active && s.active.mode !== mode ? 'MODE_DEFERRED' : s.manual ? 'MANUAL_READY' : 'MODE_SELECTED'
    s.reason = s.code === 'MODE_DEFERRED' ? '本轮模式保持不变；新模式从下一轮开始生效' : s.manual ? '手动继续：未验证存在完整计划，不代表计划批准' : '已切换当前会话模式'
    this.publish(sid, s)
    return { ok: true }
  }
  refreshConfig() { for (const [sid, s] of this.sessions) this.publish(sid, s) }
  recordError(sid, s, code, reason) {
    s.code = code; s.reason = reason; this.publish(sid, s)
    return failure(code, reason)
  }
  matchesExecution(s, message) {
    return s.execution && message?.id === s.execution.messageId && message?.source?.kind === 'plugin:dsh-mode-widget'
  }
  remember(s, message) {
    if (!message?.id) return false
    if (s.inputs.has(message.id)) return true
    s.inputs.add(message.id)
    if (s.inputs.size > 2048) s.inputs.delete(s.inputs.values().next().value)
    return false
  }
  queuedInput(sid, message) {
    if (!isTaskInput(message)) return
    const s = this.entry(sid)
    if (this.matchesExecution(s, message)) { s.execution.enqueued = true; return }
    if (this.remember(s, message)) return
    if (message?.id) s.queued.add(message.id)
    s.inputRevision++; s.ready = null; s.manual = null
    if (s.active) s.active.invalidated = true
    s.code = 'NEW_INPUT'; s.reason = '有新的任务输入，旧计划已失效'
    this.publish(sid, s)
  }
  claimedInput(sid, message, turn) {
    const s = this.entry(sid)
    if (message?.id) s.queued.delete(message.id)
    if (this.matchesExecution(s, message)) {
      const e = s.execution
      e.turn = turn ?? s.active?.turn; e.claimed = true; e.phase = 'running'
      if (s.active?.turn === e.turn) s.active.executionId = e.id
      s.code = 'EXECUTION_STARTED'; s.reason = '本会话已开始执行所选计划'
      this.publish(sid, s)
    }
  }
  discardedInput(sid, message) {
    if (!message?.id) return
    const s = this.sessions.get(sid)
    if (!s) return
    const removed = s.queued.delete(message.id)
    s.inputs.delete(message.id)
    if (this.matchesExecution(s, message) && outstanding(s.execution) && !s.execution.claimed) {
      const e = s.execution
      e.phase = 'failed'; e.code = 'EXECUTION_DISCARDED'
      this.rollbackMode(sid, s, e)
      s.code = e.code; s.reason = '排队的执行请求已取消；旧执行资格不会恢复'
      this.publish(sid, s)
    } else if (removed) {
      s.code = 'INPUT_DISCARDED'; s.reason = '排队的新任务已取消；旧计划不会自动恢复'
      this.publish(sid, s)
    }
  }
  admittedInput(sid, message) {
    if (!isTaskInput(message)) return
    const s = this.entry(sid)
    if (message?.id) s.queued.delete(message.id)
    if (this.matchesExecution(s, message)) { this.claimedInput(sid, message, s.active?.turn); return }
    if (this.remember(s, message)) return
    s.inputRevision++; s.ready = null; s.manual = null
    // Multiple messages in the initial input batch are one turn's starting context.
    // New queued input is handled earlier by queuedInput, even before admission.
    if (s.active) {
      if (s.active.workStarted || s.active.submission) s.active.invalidated = true
      s.active.inputSeen = true
    }
    s.code = 'NEW_INPUT'; s.reason = '新任务输入已撤销旧计划'
    this.publish(sid, s)
  }
  onEvent(sid, event, capturedMode) {
    if (!sid || !event) return
    const type = event.type
    if (type === 'agent/inbox/spliced') {
      for (const message of event.data?.inserted || []) this.queuedInput(sid, message)
      return
    }
    if (type === 'user/message') { this.admittedInput(sid, event.data?.message || event.data); return }
    if (!['turn/start', 'turn/end', 'assistant/message'].includes(type)) return
    const s = this.entry(sid)
    if (type === 'turn/start') {
      const turn = event.data?.turn
      if (s.active?.turn === turn) return
      const e = s.execution
      const mode = outstanding(e) && !e.claimed ? 'standard' : capturedMode || this.store.modeFor(sid)
      s.active = { turn, mode, modeRevision: s.modeRevision, workStarted: false, inputSeen: false, invalidated: false, submission: null, reads: 0, executionId: null }
      s.unknownTurn = null; s.ready = null; s.manual = null
      s.code = 'TURN_STARTED'; s.reason = PLANNING.has(mode) ? '正在形成新计划' : '当前轮次正在处理'
      this.publish(sid, s)
    } else if (type === 'assistant/message') {
      if (s.active) s.active.workStarted = true
    } else if (type === 'turn/end') {
      if (!s.active || s.active.turn !== event.data?.turn) {
        if (s.unknownTurn === event.data?.turn) { s.unknownTurn = null; this.publish(sid, s) }
        return
      }
      const a = s.active, reason = event.data?.reason
      s.active = null
      s.ready = reason?.kind === 'completed' && !a.invalidated && a.modeRevision === s.modeRevision && a.submission && !s.manual
        ? { ...a.submission, turn: a.turn, at: this.now() } : null
      s.code = s.ready ? 'PLAN_READY' : s.manual ? 'MANUAL_READY' : a.invalidated ? 'PLAN_SUPERSEDED' : reason?.kind !== 'completed' ? 'TURN_NOT_COMPLETED' : PLANNING.has(a.mode) ? 'PLAN_NOT_SUBMITTED' : 'NO_COMPLETE_PLAN'
      s.reason = s.ready ? '当前完整计划可以执行' : s.manual ? '手动继续：未验证存在完整计划，不代表计划批准' : a.invalidated ? '本轮已被后续需求替代，请形成新的完整计划' : reason?.kind !== 'completed' ? '本轮未正常结束，没有生成执行资格' : PLANNING.has(a.mode) ? '本轮未调用 mode_plan_ready 提交完整计划；讨论中不显示执行按钮，已完成的计划需明确提交' : '当前没有已提交的完整计划'
      if (a.executionId && s.execution?.id === a.executionId) {
        const e = s.execution
        e.phase = reason?.kind === 'completed' ? 'completed' : 'failed'
        if (e.phase === 'failed') {
          this.rollbackMode(sid, s, e)
          s.code = 'EXECUTION_FAILED'; s.reason = String(reason?.error?.message || reason?.kind || '执行轮次失败')
        } else { s.code = 'EXECUTION_COMPLETED'; s.reason = '执行轮次已完成' }
      }
      this.publish(sid, s)
    }
  }
  submit(sid, title, mode) {
    if (!sid) return failure('SESSION_REQUIRED', '提交计划需要明确会话 ID')
    const s = this.entry(sid), a = s.active
    if (!a) return failure(s.unknownTurn !== null ? 'TURN_NOT_TRACKED' : 'NO_ACTIVE_TURN', '没有可核对的规划轮次，请在新的计划轮次提交')
    if (a.invalidated) return failure('PLAN_SUPERSEDED', '本轮已收到新的任务需求，不能提交旧计划；请在下一轮完成新计划')
    if (!PLANNING.has(a.mode) || (mode !== undefined && !PLANNING.has(mode))) return failure('NOT_PLANNING', '本轮不是计划/审问模式')
    if (a.modeRevision !== s.modeRevision) return failure('MODE_CHANGED', '本轮期间模式已重新选择，不能恢复旧执行资格')
    if (outstanding(s.execution)) return failure('EXECUTION_IN_PROGRESS', '执行尚未结束，不能提交新的执行资格')
    const label = String(title || '').trim()
    if (!label) return failure('PLAN_TITLE_REQUIRED', '计划标题不能为空')
    a.submission = { token: this.token(), title: label }; a.workStarted = true
    s.ready = null; s.code = 'PLAN_SUBMITTED'; s.reason = '完整计划已提交，本轮正常结束后可执行'
    this.publish(sid, s)
    return { ok: true, code: 'PLAN_SUBMITTED', reason: s.reason }
  }
  snapshot(sid, enabled) {
    const s = sid ? this.entry(sid) : null, config = this.store.read()
    const allowed = enabled ?? config.prefs.autoStart !== false
    const p = s?.ready, selectedMode = sid ? this.store.modeFor(sid) : config.defaultMode
    const valid = !!(allowed && p && !s.active && !outstanding(s.execution) && this.now() - p.at < this.ttl)
    const manual = s?.manual
    const validManual = !!(manual && !s.active && s.unknownTurn === null && !outstanding(s.execution) && !s.queued.size && selectedMode === 'standard' && manual.viewId === s.viewId && manual.inputRevision === s.inputRevision)
    const mode = s?.active?.mode || (s?.unknownTurn !== null && s?.unknownTurn !== undefined ? 'limit' : selectedMode)
    return {
      protocolVersion: PROTOCOL_VERSION, coreBuild: CORE_BUILD, mode, selectedMode,
      modePending: mode !== selectedMode, scope: 'per-session', prefs: config.prefs,
      pendingExecution: valid, planToken: valid ? p.token : null, planTitle: valid ? p.title : null,
      viewId: s?.viewId || null, pendingManual: validManual,
      manualToken: validManual ? manual.token : null, manualViewId: validManual ? manual.viewId : null,
      planExpiresAt: valid ? p.at + this.ttl : null, planRevision: s?.revision || 0, planEpoch: this.epoch,
      turn: s?.active?.turn ?? null,
      phase: outstanding(s?.execution) ? s.execution.phase : s?.active ? (PLANNING.has(mode) ? 'planning' : 'responding') : valid ? 'ready' : validManual ? 'manual-ready' : 'idle',
      statusCode: p && !valid && this.now() - p.at >= this.ttl ? 'PLAN_EXPIRED' : s?.code || 'NO_PLAN',
      statusReason: p && !valid && this.now() - p.at >= this.ttl ? '计划执行资格已过期，请重新确认完整计划' : s?.reason || '尚无完整计划',
      execution: s?.execution ? { id: s.execution.id, phase: s.execution.phase, turn: s.execution.turn, code: s.execution.code || null } : null,
    }
  }
  consume(sid, token, enabled) {
    const status = this.snapshot(sid, enabled)
    if (!sid || !token || !status.pendingExecution || token !== status.planToken) return failure('STALE_PLAN', '这份计划已失效、已消费或已有新任务，请等待新的完整计划')
    const s = this.entry(sid), plan = s.ready
    if (s.queued.size) return failure('PENDING_INPUT', '会话还有未处理的新任务，旧计划不能执行')
    s.ready = null; s.code = 'PLAN_CONSUMED'; s.reason = '计划执行资格已消费'
    this.publish(sid, s)
    return { ok: true, plan }
  }
  consumeManual(sid, token, viewId) {
    const status = this.snapshot(sid)
    if (!token || !viewId || !status.pendingManual || status.manualToken !== token || status.manualViewId !== viewId || status.viewId !== viewId) return failure('STALE_MANUAL', '手动继续资格已失效；请在当前页面重新从计划/审问切到标准')
    const s = this.entry(sid), manual = s.manual
    s.manual = null; s.ready = null; s.code = 'MANUAL_CONSUMED'; s.reason = '手动继续资格已消费；未确认存在完整计划'
    this.publish(sid, s)
    return { ok: true, manual }
  }
  rollbackMode(sid, s, e) {
    // Only undo our own unchanged mode write. Never clobber a later user choice/turn.
    if (s.execution !== e || s.modeRevision !== e.modeRevision || this.store.modeFor(sid) !== 'standard' || (s.active && s.active.turn !== e.turn)) return
    try { this.store.setMode(sid, e.previousMode); s.modeRevision++ } catch (error) { e.rollbackError = error.code || 'STATE_WRITE_FAILED' }
  }
  async execute(sid, token, options = {}) {
    return this.dispatch(sid, () => this.consume(sid, token), options)
  }
  async executeManual(sid, token, viewId, options = {}) {
    return this.dispatch(sid, () => this.consumeManual(sid, token, viewId), options)
  }
  async dispatch(sid, consume, { message, send, check = () => null, wasQueued = () => false } = {}) {
    requireSessionId(sid)
    const s = this.entry(sid)
    const blocked = check()
    if (blocked) return blocked
    if (!message?.id || message.source?.kind !== 'plugin:dsh-mode-widget' || typeof send !== 'function') return failure('INVALID_HANDOFF', '执行交接消息缺少标识或发送通道')
    const consumed = consume()
    if (!consumed.ok) return consumed
    const e = { id: this.token(), messageId: message.id, kind: consumed.manual ? 'manual' : 'plan', plan: consumed.plan || null, previousMode: this.store.modeFor(sid),
      modeRevision: s.modeRevision, phase: 'dispatching', turn: null, claimed: false, enqueued: false }
    s.execution = e
    try {
      this.store.setMode(sid, 'standard'); s.modeRevision++; e.modeRevision = s.modeRevision
      s.code = 'EXECUTION_DISPATCHING'; s.reason = '正在向当前会话提交执行请求'; this.publish(sid, s)
      await send(message)
      if (s.execution === e && e.phase === 'dispatching') { e.phase = 'queued'; s.code = 'EXECUTION_QUEUED'; s.reason = '执行请求已提交，等待会话开始'; this.publish(sid, s) }
      return { ok: true, code: 'EXECUTION_ACCEPTED', reason: '执行请求已提交给当前会话' }
    } catch (error) {
      if (s.execution !== e) return failure('HANDOFF_SUPERSEDED', '该交接已被后续会话状态替代；未修改新状态')
      // A throw after enqueue may already have delivered the request: never resend it.
      const accepted = e.enqueued || e.claimed || wasQueued(message.id)
      if (accepted) {
        if (e.phase === 'dispatching') e.phase = 'queued'
        e.code = 'HANDOFF_ACCEPTED_WITH_ERROR'; s.code = e.code; s.reason = '执行消息已入队，但提交通道报错；请勿重复执行'
        this.publish(sid, s)
        return { ok: true, code: e.code, reason: s.reason }
      }
      e.phase = 'failed'; e.code = error.code || 'HANDOFF_FAILED'
      this.rollbackMode(sid, s, e)
      return this.recordError(sid, s, e.code, String(error.message || error))
    }
  }
  readCount(sid) {
    const s = this.entry(sid)
    if (!s.active) return 0
    return ++s.active.reads
  }
  release(sid) {
    const s = this.sessions.get(sid)
    if (!s) return
    s.active = null; s.ready = null; s.manual = null; s.viewId = null; s.unknownTurn = null
    s.execution = null; s.queued.clear(); s.inputs.clear()
    s.code = 'SESSION_UNLOADED'; s.reason = '会话已卸载；模式保留，执行资格已清除'
    this.publish(sid, s)
    // Keep a revision tombstone for connected clients. Persistent mode is not deleted.
  }
  forget(sid) { this.release(sid) }
}
