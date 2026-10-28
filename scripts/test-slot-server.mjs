// Isolated browser fixture: real host adapter + real state core, memory-only storage.
// The tiny React lifecycle adapter tests native DOM behavior, not full DSH rendering.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { createPlugin } from '../lib/index.js'
import { createMemoryModeStore } from '../lib/state.mjs'
const root = path.resolve(import.meta.dirname, '..')
const page = `<!doctype html><html><head><meta charset="utf-8"><title>Mode widget slot regression fixture</title>
<style>body{margin:0;font:16px system-ui;background:#fff;color:#111}main{height:12000px;background:repeating-linear-gradient(#fff 0 200px,#ddd 200px 201px)}#composer{position:sticky;bottom:12px;margin:0 auto;width:850px;border:1px solid #ccc;border-radius:22px;background:white;padding:12px;z-index:1}#tools{display:flex;align-items:center;gap:12px}#spacer{flex:1}button{cursor:pointer}#overlay{position:fixed;inset:0;z-index:100;background:#555;display:none;color:white}#overlay.on{display:block}</style>
</head><body><main>Scroll regression fixture</main><section id="composer"><textarea aria-label="Message"></textarea><div id="tools"><button>+</button><button>工作区内修改</button><span id="seat"></span><span id="spacer"></span><button id="reference">&lt;/&gt; ON</button></div></section><div id="overlay">Image preview must cover both input controls</div>
<script>
window.effects=[];window.cleanups=[];window.errors=[];
window.addEventListener('error',e=>errors.push(e.message));
const React={useRef:()=>({current:null}),useEffect:fn=>effects.push(fn),createElement:(tag,p)=>{const e=document.createElement(tag);if(p.ref)p.ref.current=e;Object.assign(e.style,p.style||{});for(const[k,v]of Object.entries(p))if(k.startsWith('data-'))e.setAttribute(k,v);return e}};
window.__ModuleLoader__={load(row){window.plugin=row.factory(n=>{if(n==='react')return React;throw Error(n)})}};
window.mountSession=function(id){for(const c of cleanups.splice(0))c();effects=[];document.querySelector('#seat').replaceChildren();let component,spec;const ctx={slots:{inject(name,fn){if(name!=='conversation.input.left')throw Error('wrong slot');return fn()},register(s,c){if(!s.id)throw Error('list registration requires id');spec=s;component=c;return()=>{}}}};plugin.apply(ctx);document.querySelector('#seat').appendChild(component(spec.inject(id)));for(const f of effects){const c=f();if(c)cleanups.push(c)}};
</script><script src="/client.js"></script><script>mountSession('session-fixture-A')</script></body></html>`
const events = new EventEmitter(), routes = new Map(), tools = new Map(), agents = new Map(), disposers = [], requests = []
const store = createMemoryModeStore(); store.patchConfig({ prefs: { labelLang: 'zh' } })
function emit(sid, type, data) { const a = agents.get(sid), e = { type, data }; a.session.log.push(e); events.emit('session/event', a.session, e) }
for (const sid of ['session-fixture-A', 'session-fixture-B']) agents.set(sid, {
  id: sid, session: { id: sid, header: {}, log: [], snapshotEvents() { return this.log } }, inbox: { nextTurn: [], nextStep: [] },
  followup(message) { this.inbox.nextTurn.push(message); emit(sid, 'agent/inbox/spliced', { inserted: [message] }); events.emit('agent/inbox/inserted', { agent: this, message }) },
})
const ctx = {
  webServer: { register(r) { routes.set(r.path, r.handler); return () => routes.delete(r.path) } },
  systemPrompt: { section() { return () => {} } },
  on(name, fn) { events.on(name, fn); return () => events.off(name, fn) }, effect(fn) { disposers.push(fn()) },
  get(name) { return name === 'agents' ? agents : name === 'tools' ? { register(r) { tools.set(r.name, r); return () => tools.delete(r.name) } } : undefined },
}
createPlugin({ store })({ inject(_deps, fn) { fn(ctx) } })
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://local'); res.setHeader('Cache-Control', 'no-store')
  if (u.pathname === '/') { res.setHeader('Content-Type', 'text/html;charset=utf-8'); res.end(page); return }
  if (u.pathname === '/client.js') { res.setHeader('Content-Type', 'application/javascript'); res.end(fs.readFileSync(path.join(root, 'lib/client.js'))); return }
  if (u.pathname === '/requests') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(requests)); return }
  if (u.pathname.startsWith('/test/')) {
    let raw = ''; for await (const c of req) raw += c
    const b = JSON.parse(raw), sid = b.sessionId || 'session-fixture-A', agent = agents.get(sid)
    if (u.pathname === '/test/event') emit(sid, b.type, b.data || {})
    if (u.pathname === '/test/submit') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(await tools.get('mode_plan_ready').execute({ title: b.title || 'Plan' }, { agent }))); return }
    if (u.pathname === '/test/claim') {
      const message = agent.inbox.nextTurn.shift()
      if (message) { events.emit('agent/inbox/claimed', { agent, message, turn: b.turn }); emit(sid, 'user/message', message) }
    }
    if (u.pathname === '/test/input') {
      const message = { id: crypto.randomUUID(), source: { kind: 'user' }, role: 'user', content: [{ type: 'text', text: 'New request' }] }
      agent.inbox.nextTurn.push(message); events.emit('agent/inbox/inserted', { agent, message })
    }
    res.end('{}'); return
  }
  const handler = routes.get(u.pathname)
  if (!handler) { res.writeHead(404); res.end(); return }
  requests.push({ method: req.method, path: u.pathname, session: u.searchParams.get('session') })
  try { await handler(req, res) } catch (e) { if (!res.headersSent) res.writeHead(500); res.end(e.message) }
})
server.listen(19491, '127.0.0.1', () => console.log('Slot regression fixture: http://127.0.0.1:19491'))
