// Durable preferences and session-owned selected modes. Runtime turns/plans are never persisted.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export const MODES = ['standard', 'plan', 'grill', 'limit']
export const MODE_LABEL_ZH = { standard: '标准', plan: '计划', grill: '审问', limit: '限制' }
export const MODE_LABEL_EN = { standard: 'BASE', plan: 'PLAN', grill: 'GRILL', limit: 'LIMIT' }
export const SCOPES = ['per-session']
export const STATE_VERSION = 2
export const DIR = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'dsh-mode-widget')
export const DEFAULTS = {
  version: STATE_VERSION,
  scope: 'per-session',
  defaultMode: 'standard',
  sessions: {},
  prefs: { leaveDelay: 300, bounce: 'normal', labelLang: 'en', showModeName: true,
    planRetentionDays: 30, planReadLimit: 10, autoStart: true,
    disablePlanQuestionCard: true, disableGrillQuestionCard: false },
}
export const isMode = mode => MODES.includes(mode)
export function requireSessionId(sid) {
  if (typeof sid !== 'string' || !sid.trim() || sid.length > 256 || ['__proto__', 'constructor', 'prototype'].includes(sid)) {
    throw Object.assign(new Error('需要明确的会话 ID，不能修改全局模式或猜测其他会话'), { code: 'SESSION_REQUIRED' })
  }
  return sid
}
function normalizePrefs(prefs) {
  const next = { ...DEFAULTS.prefs, ...(prefs || {}) }
  for (const key of ['disablePlanQuestionCard', 'disableGrillQuestionCard']) {
    if (typeof next[key] !== 'boolean') next[key] = DEFAULTS.prefs[key]
  }
  return next
}
function normalize(raw) {
  if (raw && (!Number.isInteger(raw.version) || raw.version > STATE_VERSION || raw.version < 1)) {
    throw Object.assign(new Error('不支持的模式状态版本'), { code: 'STATE_VERSION_UNSUPPORTED' })
  }
  const s = { ...DEFAULTS, defaultMode: isMode(raw?.defaultMode) ? raw.defaultMode : 'standard',
    prefs: normalizePrefs(raw?.prefs), sessions: {} }
  // V1's active implementation ignored sessions entirely. Those mappings can be stale:
  // do not resurrect them; keep the original file in a V1 backup on the first V2 write.
  if (raw?.version === STATE_VERSION) {
    for (const [id, mode] of Object.entries(raw.sessions || {})) {
      try { requireSessionId(id) } catch { continue }
      if (isMode(mode)) s.sessions[id] = mode
    }
  }
  return s
}
export function createModeStore({ directory = DIR, io = fs } = {}) {
  const file = path.join(directory, 'state.json')
  let lastWriteOk = true
  function read() {
    try {
      return normalize(JSON.parse(io.readFileSync(file, 'utf8')))
    } catch (error) {
      if (error.code === 'ENOENT') return normalize(null)
      throw Object.assign(new Error('无法读取会话模式状态；未退回标准模式以免放宽权限', { cause: error }), { code: 'STATE_READ_FAILED' })
    }
  }
  function write(next) {
    const s = normalize({ ...next, version: STATE_VERSION })
    const temp = file + '.' + randomUUID() + '.tmp'
    try {
      io.mkdirSync(directory, { recursive: true })
      let previous
      try { previous = io.readFileSync(file, 'utf8') } catch (error) { if (error.code !== 'ENOENT') throw error }
      if (previous && JSON.parse(previous).version === 1) {
        // Exclusive creation: never overwrite an earlier migration backup.
        try { io.writeFileSync(file + '.v1.bak', previous, { encoding: 'utf8', flag: 'wx' }) }
        catch (error) { if (error.code !== 'EEXIST') throw error }
      }
      io.writeFileSync(temp, JSON.stringify(s, null, 2), 'utf8')
      io.renameSync(temp, file)
      lastWriteOk = true
      return s
    } catch (error) {
      lastWriteOk = false
      try { io.unlinkSync(temp) } catch {}
      throw Object.assign(new Error('会话模式保存失败；本次切换未生效', { cause: error }), { code: 'STATE_WRITE_FAILED' })
    }
  }
  function modeFor(sid, s = read()) {
    if (!sid) return s.defaultMode
    requireSessionId(sid)
    return Object.hasOwn(s.sessions, sid) ? s.sessions[sid] : s.defaultMode
  }
  function ensureSession(sid) {
    requireSessionId(sid)
    let s = read()
    if (!Object.hasOwn(s.sessions, sid)) s = write({ ...s, sessions: { ...s.sessions, [sid]: s.defaultMode } })
    return s.sessions[sid]
  }
  function setMode(sid, mode) {
    requireSessionId(sid)
    if (!isMode(mode)) throw Object.assign(new Error('无效模式'), { code: 'INVALID_MODE' })
    const s = read()
    return write({ ...s, sessions: { ...s.sessions, [sid]: mode } })
  }
  function patchConfig({ scope, defaultMode, prefs } = {}) {
    if (scope && scope !== 'per-session') throw Object.assign(new Error('模式现已固定按会话隔离；全局仅保留默认值和偏好'), { code: 'SCOPE_PER_SESSION_ONLY' })
    if (defaultMode !== undefined && !isMode(defaultMode)) throw Object.assign(new Error('无效默认模式'), { code: 'INVALID_MODE' })
    const s = read(), nextPrefs = { ...s.prefs }
    for (const [key, value] of Object.entries(prefs || {})) if (key in DEFAULTS.prefs) nextPrefs[key] = value
    return write({ ...s, defaultMode: defaultMode ?? s.defaultMode, prefs: nextPrefs })
  }
  function forgetSession(sid) {
    requireSessionId(sid)
    const s = read(), sessions = { ...s.sessions }
    delete sessions[sid]
    return write({ ...s, sessions })
  }
  return { read, write, modeFor, ensureSession, setMode, patchConfig, forgetSession,
    lastWriteSucceeded: () => lastWriteOk }
}
export function createMemoryModeStore({ defaultMode = 'standard' } = {}) {
  let state = normalize({ version: STATE_VERSION, defaultMode })
  return {
    read: () => structuredClone(state),
    modeFor: sid => state.sessions[sid] || state.defaultMode,
    ensureSession(sid) { requireSessionId(sid); return state.sessions[sid] ||= state.defaultMode },
    setMode(sid, mode) { requireSessionId(sid); if (!isMode(mode)) throw new Error('Invalid mode'); state.sessions[sid] = mode; return this.read() },
    patchConfig(patch = {}) { if (patch.defaultMode) state.defaultMode = patch.defaultMode; state.prefs = normalizePrefs({ ...state.prefs, ...patch.prefs }); return this.read() },
  }
}
export const modeStore = createModeStore()
export const read = () => modeStore.read()
export const write = next => modeStore.write(next)
export const modeFor = (sid, s) => modeStore.modeFor(sid, s)
export const setMode = (sid, mode) => modeStore.setMode(sid, mode)
export const patchPrefs = prefs => modeStore.patchConfig({ prefs })
export const forgetSession = sid => modeStore.forgetSession(sid)
export const lastWriteSucceeded = () => modeStore.lastWriteSucceeded()
