import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
// Extracted read-only from the installed desktop 0.2.0-rc.2 archive.
import { SlotCore } from '../test/fixtures/dsh-slot-core.js'
const core = new SlotCore()
core.register({ name: 'root', children: { 'conversation.input.left': { kind: 'list', scope: 'session' } } }, () => null)
assert.throws(() => core.register({ name: 'conversation.input.left' }, () => null), /requires options.id/)
const root = new URL('../', import.meta.url)
const manifest = JSON.parse(fs.readFileSync(new URL('package.json', root), 'utf8'))
const source = fs.readFileSync(new URL('lib/client.js', root), 'utf8')
const host = fs.readFileSync(new URL('lib/index.js', root), 'utf8')
assert.equal(manifest.dsh.client.platform, 'web')
assert.equal(manifest.exports['./client'], './lib/client.js')
let entry
vm.runInNewContext(source, { window: { __ModuleLoader__: { load(row) { entry = row } } } })
assert.equal(entry.id, manifest.name)
const plugin = entry.factory(name => { assert.equal(name, 'react'); return {} })
assert.deepEqual(Array.from(plugin.inject), ['slots'])
let declaration, component, disposed = 0
const ctx = { slots: {
 inject(name, fn) { assert.equal(name, 'conversation.input.left'); return fn() },
 register(spec, C) { declaration = spec; component = C; return core.register(spec, C) }
} }
plugin.apply(ctx)
assert.equal(declaration.name, 'conversation.input.left')
assert.equal(declaration.id, 'dsh-mode-widget')
assert.equal(core.entriesOfSlot('conversation.input.left').length, 1)
assert.equal(declaration.inject('session-A').boundSessionId, 'session-A')
assert.equal(declaration.inject('session-B').boundSessionId, 'session-B')
assert.equal(typeof component, 'function')
for (const re of [/position:\s*fixed/, /MutationObserver\s*\(/, /document\.body\.appendChild/, /showPopover\s*\(/, /sessionFromFiber/, /locateSoon/, /root\.style\.(left|top)/, /addEventListener\(['"]scroll/]) {
 assert(!re.test(source), 'Forbidden legacy layout mechanism: ' + re)
}
assert(!/\.dm-badge:hover\s*\{[^}]*transform/.test(source), 'The avatar must not scale on hover')
assert(!/\.dm-badge\s*\{[^}]*transition:\s*transform/.test(source), 'The avatar must not animate its geometry')
assert(source.includes('.dm-wheel{position:absolute;left:18px;top:calc(100% - 210px)'), 'Wheel must align horizontally with the avatar and vertically with the button bottom')
assert(source.includes('transform-origin:50% 210px'), 'Wheel scales around its actual SVG circle center')
assert(source.includes('if (event) setHot(sectorAt(event.clientX, event.clientY))'), 'Opening must initialize hover without pointer movement')
assert(!host.includes('webserver/index-inject'))
assert(!host.includes('tapIndex('))
assert(!source.includes("pill.addEventListener('mouseleave'"))
assert(source.includes('hotMode = null; root.classList.remove'))
assert(source.includes("document.removeEventListener('keydown', onKeyDown)"))
assert(source.includes("document.removeEventListener('pointerdown', onOutsidePointer)"))
assert(source.includes('clearInterval(stateTimer)'))
console.log('PASS official client manifest/export, deferred slot registration, real session injection, no viewport tracking, event/timer cleanup and wheel hover regressions')
