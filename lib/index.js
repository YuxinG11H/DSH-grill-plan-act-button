// Host adapter: routes, official DSH lifecycle hooks, prompt and tool registration.
// All session/turn/plan/execution decisions live in SessionCore, never in the UI.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { MODES, DIR, STATE_VERSION, modeStore } from './state.mjs'
import { SessionCore, CORE_BUILD, PROTOCOL_VERSION, isTaskInput } from './session-core.mjs'
import { textFor, denyReason, PROMPTS, isInfoTool, PLAN_READ_LIMIT, questionCardsDisabled } from './inject.mjs'
export const EXECUTION_TEXT = '现在请直接执行任务。'
import { checkRequest } from './request-policy.mjs'

const NAME = 'dsh-mode-widget'
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ASSETS = path.join(ROOT, 'assets')
const WIDGET = path.join(ROOT, 'lib', 'client', 'widget.js')
const FALLBACK_ASSETS = process.env.DSH_MODE_ASSETS || null
const MIME = { '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml' }
const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = []
    req.on('data', c => { size += c.length; if (size > 16384) { reject(new Error('body too large')); req.destroy(); return }; chunks.push(c) })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}
function resolveAsset(name) {
  if (!/^[A-Za-z0-9._\-\u4e00-\u9fa5]+$/.test(name)) return null
  for (const directory of [ASSETS, FALLBACK_ASSETS].filter(Boolean)) {
    const file = path.join(directory, name)
    try { if (fs.statSync(file).isFile()) return file } catch {}
  }
  return null
}
function makeUserMessage() {
  return { id: crypto.randomUUID(), role: 'user', content: [{ type: 'text', text: EXECUTION_TEXT }], source: { kind: 'plugin:' + NAME } }
}
function install(root, store) {
  root.inject(['webServer', 'systemPrompt'], ctx => {
    const webServer = ctx.webServer, disposers = [], subscribers = new Map()
    let lastDiag = null
    const requestPolicies = new WeakMap(), latestPolicies = new Map()
    const core = new SessionCore({ store, onChange: broadcast })
    const runtime = { protocolVersion: PROTOCOL_VERSION, coreBuild: CORE_BUILD, stateSchemaVersion: STATE_VERSION, startedAt: core.startedAt }
    const logRequest = (tag, data) => {
      if (process.env.DSH_MODE_DEBUG !== '1') return
      try { fs.appendFileSync(path.join(DIR, 'requests.log'), new Date().toISOString() + ' ' + tag + ' ' + JSON.stringify(data) + '\n') } catch {}
    }
    const json = (res, status, data) => { res.writeHead(status, JSON_HEADERS); res.end(JSON.stringify(data)) }
    const errorResponse = (res, error) => json(res, /STATE_|UNAVAILABLE/.test(error.code || '') ? 503 : 400,
      { ok: false, code: error.code || 'REQUEST_FAILED', reason: error.message || String(error), ...runtime })
    const registerRoute = route => webServer.register({ ...route, handler(req, res) {
      const failure = checkRequest(req)
      if (failure) { res.writeHead(failure.status, JSON_HEADERS); res.end(JSON.stringify({ ok: false, error: failure.error })); return }
      return Promise.resolve().then(() => route.handler(req, res)).catch(error => {
        if (!res.headersSent) errorResponse(res, error)
        else res.end()
      })
    } })
    const snapshot = sid => ({ ok: true, ...core.snapshot(sid) })
    function broadcast(sid) {
      const listeners = subscribers.get(sid)
      if (!listeners) return
      let status
      try { status = snapshot(sid) } catch (error) { status = { ok: false, ...runtime, code: error.code, reason: error.message, pendingExecution: false } }
      for (const res of listeners) { try { res.write('data: ' + JSON.stringify(status) + '\n\n') } catch { listeners.delete(res) } }
    }
    disposers.push(registerRoute({ kind: 'exact', path: '/dsh-mode/widget.js', handler(_req, res) {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(fs.readFileSync(WIDGET, 'utf8'))
    } }))
    disposers.push(registerRoute({ kind: 'exact', path: '/dsh-mode/asset', handler(req, res) {
      const file = resolveAsset(new URL(req.url, 'http://x').searchParams.get('name') || '')
      if (!file) { res.writeHead(404); res.end('not found'); return }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'max-age=3600' })
      res.end(fs.readFileSync(file))
    } }))
    disposers.push(registerRoute({ kind: 'exact', path: '/dsh-mode/state', async handler(req, res) {
      const sid = new URL(req.url, 'http://x').searchParams.get('session') || null
      if (req.method === 'PUT' || req.method === 'POST') {
        const body = JSON.parse(await readBody(req) || '{}'), target = body.sessionId || null
        if (body.scope && body.scope !== 'per-session') throw Object.assign(new Error('模式已固定按会话隔离'), { code: 'SCOPE_PER_SESSION_ONLY' })
        if (body.attachView === true) {
          const attached = core.attachView(target, body.viewId)
          if (!attached.ok) { json(res, 409, { ...snapshot(target), ...attached }); return }
        }
        if (body.mode !== undefined) {
          const result = core.setMode(target, body.mode, { manualTransition: body.manualTransition === true, viewId: body.viewId })
          if (!result.ok) { json(res, 409, { ...snapshot(target), ...result }); return }
        }
        if (body.prefs) { store.patchConfig({ prefs: body.prefs }); core.refreshConfig() }
        logRequest('state-updated', { sid: target, mode: body.mode })
        json(res, 200, snapshot(target)); return
      }
      json(res, 200, snapshot(sid))
    } }))
    disposers.push(registerRoute({ kind: 'exact', path: '/dsh-mode/plan-events', handler(req, res) {
      const sid = new URL(req.url, 'http://x').searchParams.get('session')
      if (req.method !== 'GET' || !sid) { json(res, 400, { ok: false, code: 'SESSION_REQUIRED' }); return }
      const initial = snapshot(sid)
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
      let listeners = subscribers.get(sid)
      if (!listeners) { listeners = new Set(); subscribers.set(sid, listeners) }
      listeners.add(res); res.write('data: ' + JSON.stringify(initial) + '\n\n')
      const heartbeat = setInterval(() => { try { res.write(': keepalive\n\n') } catch {} }, 15000)
      res.on('close', () => { clearInterval(heartbeat); listeners.delete(res); if (!listeners.size) subscribers.delete(sid) })
    } }))
    const agentFor = sid => ctx.get('agents')?.get?.(sid)
    function checkTarget(sid, agent) {
      if (!agent || agent.id !== sid || typeof agent.followup !== 'function') return { ok: false, code: 'AGENT_UNAVAILABLE', reason: '目标会话未加载，不能执行' }
      const queued = [...(agent.inbox?.nextTurn || []), ...(agent.inbox?.nextStep || [])]
      if (queued.some(isTaskInput)) return { ok: false, code: 'PENDING_INPUT', reason: '目标会话有尚未处理的新任务，请先完成新的规划' }
      const registry = ctx.get('workspaceRegistry')
      if (registry) {
        try {
          let current = agent, visited = new Set()
          while (current && !visited.has(current.id)) {
            visited.add(current.id)
            if (registry.archivedSessionIds.includes(current.id)) return { ok: false, code: 'SESSION_ARCHIVED', reason: '该会话或所属父会话已归档，不能执行' }
            const header = current.session?.header
            if (header?.origin !== 'subagent' || !header.parentSession) break
            current = agentFor(header.parentSession)
            if (!current) return { ok: false, code: 'PARENT_UNAVAILABLE', reason: '无法核对所属父会话状态，不能执行' }
          }
        } catch { return { ok: false, code: 'REGISTRY_UNAVAILABLE', reason: '会话归档状态尚未就绪，不能执行' } }
      }
      return null
    }
    async function executeRequest(req, res, manual) {
      if (req.method !== 'POST') { json(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED' }); return }
      const body = JSON.parse(await readBody(req) || '{}'), sid = body.sessionId
      const agent = agentFor(sid)
      const options = {
        message: makeUserMessage(), check: () => checkTarget(sid, agent), send: message => agent.followup(message),
        wasQueued: id => [...(agent?.inbox?.nextTurn || []), ...(agent?.inbox?.nextStep || [])].some(m => m.id === id),
      }
      const result = manual ? await core.executeManual(sid, body.manualToken, body.viewId, options) : await core.execute(sid, body.planToken, options)
      logRequest(manual ? 'manual-result' : 'execute-result', { sid, code: result.code })
      json(res, result.ok ? 200 : 409, { ...snapshot(sid), ...result })
    }
    disposers.push(registerRoute({ kind: 'exact', path: '/dsh-mode/execute', handler: (req, res) => executeRequest(req, res, false) }))
    disposers.push(registerRoute({ kind: 'exact', path: '/dsh-mode/execute-manual', handler: (req, res) => executeRequest(req, res, true) }))
    disposers.push(registerRoute({ kind: 'exact', path: '/dsh-mode/diag', async handler(req, res) {
      if (req.method === 'POST') {
        const info = JSON.parse(await readBody(req) || '{}')
        lastDiag = { why: String(info.why || '').slice(0, 40), revision: String(info.revision || '').slice(0, 40), ts: Number(info.ts) || Date.now() }
        json(res, 200, { ok: true, runtime }); return
      }
      const sid = new URL(req.url, 'http://x').searchParams.get('session')
      json(res, 200, { ok: true, lastDiag, runtime, ...(sid ? { sessionState: core.snapshot(sid) } : {}) })
    } }))

    disposers.push(ctx.systemPrompt.section({ name: 'mode:active', order: 5000, text(context) {
      const mode = core.promptMode(context)
      const sid = context.agent?.id, state = sid ? core.snapshot(sid) : null
      const prefs = store.read().prefs
      const policy = { mode, disabled: questionCardsDisabled(mode, prefs) }
      if (sid) latestPolicies.set(sid, policy)
      if (context.signal && typeof context.signal === 'object') requestPolicies.set(context.signal, policy)
      return textFor(mode, state?.statusCode === 'TURN_NOT_TRACKED' ? state.statusReason : '', prefs)
    } }))
    disposers.push(ctx.on('tools/pre-execute', (exec, next) => {
      if (!exec?.name) return next()
      if (exec.name === 'mode_config') return Promise.resolve({ kind: 'ask', reason: '此工具修改全局默认模式和偏好，不会改变已有会话。' })
      const stale = core.bindTool(exec)
      if (stale) return Promise.resolve({ kind: 'deny', reason: stale.reason })
      const sid = exec.agent?.id, mode = core.effectiveMode(sid)
      const policy = (exec.signal && requestPolicies.get(exec.signal)) || latestPolicies.get(sid)
      const cardsDisabled = policy?.mode === mode ? policy.disabled : questionCardsDisabled(mode, store.read().prefs)
      if (exec.name === 'ask_user_question' && cardsDisabled) return Promise.resolve({ kind: 'deny', reason: '此模式已禁用问题卡片；请用编号纯文字询问必要的用户决策，不跳过澄清。设置从下一次模型请求生效。' })
      const denied = denyReason(mode, exec.name, exec.arguments)
      if (denied) return Promise.resolve({ kind: 'deny', reason: denied })
      if (sid && mode === 'plan' && isInfoTool(exec.name)) {
        const configured = Number(store.read().prefs.planReadLimit)
        const cap = Number.isFinite(configured) ? configured : PLAN_READ_LIMIT
        if (cap >= 0 && core.readCount(sid) > cap) return Promise.resolve({ kind: 'deny', reason: `计划模式：本轮已达到 ${cap} 次读取预算，请先交付计划。` })
      }
      return next()
    }))
    disposers.push(ctx.on('session/event', (session, event) => {
      if (session?.id) core.onEvent(session.id, event)
    }))
    disposers.push(ctx.on('agent/inbox/inserted', ({ agent, message }) => {
      if (agent?.id) core.queuedInput(agent.id, message)
    }))
    disposers.push(ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
      if (agent?.id) core.claimedInput(agent.id, message, turn)
    }))
    disposers.push(ctx.on('agent/inbox/discarded', ({ agent, message }) => {
      if (agent?.id) core.discardedInput(agent.id, message)
    }))
    disposers.push(ctx.on('session/disposed', session => { if (session?.id) { latestPolicies.delete(session.id); core.release(session.id) } }))

    const tools = ctx.get('tools')
    if (tools) {
      disposers.push(tools.register({ name: 'mode_plan_ready',
        description: '仅在已形成完整、无待决需求的可执行计划时提交。只绑定当前会话和规划轮次；本轮正常结束后才显示执行按钮。讨论、草稿和新需求未落实时不要调用。',
        parameters: { type: 'object', additionalProperties: false, properties: { title: { type: 'string', description: '完整计划的简短标题' } }, required: ['title'] },
        output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, code: { type: 'string' }, reason: { type: 'string' } }, required: ['ok', 'code', 'reason'] },
          render(_args, value) { return [{ type: 'text', text: value.code + ': ' + value.reason }] } },
        async execute(args, exec) { return core.submitExecution(exec, args.title) },
      }))
      disposers.push(tools.register({ name: 'mode_config',
        description: '读取或修改默认模式及全局偏好。模式固定按会话隔离；默认值只影响新会话，不能用此工具改变已有会话。',
        parameters: { type: 'object', additionalProperties: false, properties: {
          action: { type: 'string', enum: ['get', 'set'] }, scope: { type: 'string', enum: ['per-session'] }, defaultMode: { type: 'string', enum: MODES },
          prefs: { type: 'object', additionalProperties: false, properties: { leaveDelay: { type: 'number' }, bounce: { type: 'string', enum: ['none', 'normal', 'strong'] }, labelLang: { type: 'string', enum: ['en', 'zh', 'off'] }, showModeName: { type: 'boolean' }, planRetentionDays: { type: 'number' }, disablePlanQuestionCard: { type: 'boolean' }, disableGrillQuestionCard: { type: 'boolean' } } },
        }, required: ['action'] },
        output: { schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } }, required: ['text'] }, render(_args, value) { return [{ type: 'text', text: value.text }] } },
        async execute(args) {
          const s = args.action === 'set' ? store.patchConfig(args) : store.read()
          if (args.action === 'set') core.refreshConfig()
          return { text: JSON.stringify({ scope: s.scope, defaultMode: s.defaultMode, prefs: s.prefs, runtime, modes: MODES, prompts: Object.fromEntries(Object.entries(PROMPTS).map(([k, v]) => [k, v.length])) }) }
        },
      }))
    }
    ctx.effect(() => () => {
      for (const listeners of subscribers.values()) for (const res of listeners) res.end()
      subscribers.clear()
      for (const dispose of disposers) try { dispose() } catch {}
    })
  })
}
function createPlugin({ store = modeStore } = {}) { return root => install(root, store) }
const apply = createPlugin()
export { NAME as name, apply, createPlugin }
