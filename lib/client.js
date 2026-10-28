// Official DSH client module. Registered in the session-scoped composer slot.
window.__ModuleLoader__.load({
  id: 'dsh-mode-widget',
  factory: function (require) {
    const React = require('react')
    function mountWidget(container, boundSessionId) {
  var MODES = ['grill', 'plan', 'standard', 'limit']
  var EN = { standard: 'BASE', plan: 'PLAN', grill: 'GRILL', limit: 'LIMIT' }
  var ZH = { standard: '标准', plan: '计划', grill: '审问', limit: '限制' }
  var ASSET = function (n) { return '/dsh-mode/asset?name=' + encodeURIComponent(n) }

  var EXPECTED_PROTOCOL = 2
  var state = { mode: 'standard', selectedMode: 'standard', modePending: false, protocolVersion: null, scope: 'per-session', pending: false, planToken: null, planRevision: -1, silent: false, tight: false, prefs: { leaveDelay: 300, bounce: 'normal', labelLang: 'en', showModeName: true } }

  // Session identity is supplied by the official session-scoped slot.
  var sessionId = boundSessionId
  var disposed = false
  var planEpoch = null
  var retiredPlanEpochs = new Set()
  var planExpiryTimer = null
  var streamDisconnected = false
  var streamEpoch = null
  var httpSequence = 0
  var acceptedHttpSequence = 0

  // ---------- CSS ----------
  var CSS = [
    '.dm-root{position:relative;display:inline-flex;align-items:center;flex:0 0 auto;width:auto;height:36px;user-select:none;-webkit-user-select:none}',
    '.dm-badge{width:34px;height:34px;flex:0 0 34px;padding:0;border:0;background:none;cursor:pointer;position:relative;border-radius:17px;overflow:hidden}',
    '.dm-badge img{position:absolute;inset:0;width:34px;height:34px;border-radius:17px;opacity:0;transition:opacity .18s ease;pointer-events:none}',
    '.dm-badge img.on{opacity:1}',
    '.dm-pill{position:relative;box-sizing:border-box;display:inline-flex;align-items:center;height:36px;border-radius:18px;border:1px solid var(--dsw-alias-border-l2-darkmode-thin,#2A3546);background:var(--dsw-specific-input-major,#151C26);overflow:hidden;transition:border-color .15s ease,background .15s ease}',
    '.dm-pill.act{border-color:#2F6FE0;background:#2F6FE0;box-shadow:0 3px 12px rgba(47,111,224,.35)}',
    '.dm-slot{display:inline-flex;align-items:center;justify-content:center;height:34px;width:40px;padding:0;border:0;background:none;cursor:pointer;font:inherit}',
    '.dm-name{font-size:10.5px;letter-spacing:0;color:var(--dsw-alias-label-secondary,#8FA2B8);white-space:nowrap;transition:color .15s ease}',
    '.dm-pill.act .dm-name{color:#E4EEFF}',
    '.dm-arw{position:absolute;left:34px;top:1px;display:none;align-items:center;justify-content:center;width:40px;height:34px;padding:0;border:0;border-radius:0 17px 17px 0;background:#2F6FE0;color:#FFFFFF;font-size:12px;line-height:1;cursor:pointer;transition:background .12s ease}',
    '.dm-pill.act .dm-arw{display:flex}',
    '.dm-arw:hover{background:#3D7AEA}',
    '.dm-root.open .dm-pill{opacity:0;pointer-events:none}',
    '.dm-pill, .dm-root.open .dm-pill{transition:opacity .12s ease,border-color .15s ease,background .15s ease}',
    // Keep the horizontal center on the avatar; align the visible SVG baseline (y=210)
    // with the button bottom, so a second click at the avatar's original center selects BASE.
    '.dm-wheel{position:absolute;left:18px;top:calc(100% - 210px);width:380px;height:220px;transform:translateX(-50%) scale(.86) translateY(8px);transform-origin:50% 210px;opacity:0;pointer-events:none;z-index:5;transition:opacity .15s ease,transform .18s cubic-bezier(.2,.9,.3,1)}',
    '.dm-root.open .dm-wheel{opacity:1;pointer-events:auto;transform:translateX(-50%) scale(1) translateY(0)}',
    '.dm-mask{width:380px;height:220px;mask-image:linear-gradient(to top,#0000 0,#000 26px);-webkit-mask-image:linear-gradient(to top,#0000 0,#000 26px)}',
    '.dm-mask svg{display:block;width:380px;height:220px;overflow:visible}',
    '.dm-tip{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);font-size:27px;font-weight:900;line-height:1;letter-spacing:4px;text-transform:uppercase;background-image:linear-gradient(180deg,#FFFFFF 0%,#B9D4F6 55%,#7FA9E4 100%);-webkit-background-clip:text;background-clip:text;color:transparent;filter:drop-shadow(0 2px 5px rgba(6,14,28,.8)) drop-shadow(0 0 16px rgba(120,180,255,.4));opacity:0;transition:opacity .18s ease;pointer-events:none;white-space:nowrap;z-index:9}',
    '.dm-tip.show{opacity:.82}',
    '.dm-wheel .sector{fill:url(#dmPanelGrad);stroke:none;cursor:pointer;transition:fill .16s ease}',
    '.dm-wheel g[data-mode]{transform-box:view-box;transform-origin:190px 210px;transition:transform .22s cubic-bezier(.22,.9,.3,1),filter .22s ease}',
    '.dm-wheel g[data-mode].hot{transform:scale(1.085);animation:dmPop .3s cubic-bezier(.25,.9,.35,1) both;filter:drop-shadow(0 8px 18px rgba(20,40,90,.32))}',
    '@keyframes dmPop{0%{transform:scale(1)}40%{transform:scale(1.135)}72%{transform:scale(1.075)}100%{transform:scale(1.085)}}',
    '.dm-wheel g.hot .sector{fill:#E8F2FF}',
    '.dm-wheel image{pointer-events:none;opacity:.42;filter:saturate(.68) contrast(.95);transition:opacity .18s ease,filter .18s ease;mix-blend-mode:multiply}',
    '.dm-wheel g.sel image{opacity:1;filter:none}',
    '.dm-panel{position:absolute;right:0;bottom:48px;width:260px;background:#141922;border:1px solid #232B38;border-radius:12px;padding:10px 12px;box-shadow:0 12px 30px rgba(0,0,0,.5);display:none;z-index:10;color:#D8E2EA;font-size:12px}',
    '.dm-panel.show{display:block}',
    '.dm-row{display:flex;align-items:center;justify-content:space-between;padding:5px 0}',
    '.dm-row label{color:#A8B6C2}',
    '.dm-row select,.dm-row input[type=number]{background:#0E1116;color:#D8E2EA;border:1px solid #2A3444;border-radius:6px;padding:3px 6px;font-size:12px}',
    '.dm-k{width:96px}',
    '.dm-foot{display:flex;gap:8px;margin-top:8px}',
    '.dm-btn{flex:1;background:#1B2A4A;color:#CFE0FF;border:1px solid #2C405E;border-radius:8px;padding:6px;cursor:pointer;font-size:12px}',
    // —— 浅色主题：跟随 DSH 的明暗设定（root 上由 JS 打 dm-light）——
    '.dm-root.dm-light .dm-pill{background:#FFFFFF;border-color:#D5DEE9}',
    '.dm-root.dm-light .dm-name{color:#5A6B7D}',
    '.dm-root.dm-light .dm-pill.act{background:#2F6FE0;border-color:#2F6FE0;box-shadow:0 4px 14px rgba(47,111,224,.3)}',
    '.dm-root.dm-light .dm-panel{background:#FFFFFF;border-color:#DDE4ED;color:#26313D;box-shadow:0 12px 30px rgba(20,35,60,.14)}',
    '.dm-root.dm-light .dm-row label{color:#5A6B7D}',
    '.dm-root.dm-light .dm-row select,.dm-root.dm-light .dm-row input[type=number]{background:#F3F6FA;color:#26313D;border-color:#D5DEE9}',
    '.dm-root.dm-light .dm-btn{background:#EEF3FA;color:#2F5FA8;border-color:#CBD8E8}',
    '.dm-btn:hover{background:#22345C}',
  ].join('\n')

  var style = document.createElement('style')
  style.textContent = CSS
  document.head.appendChild(style)

  // ---------- DOM ----------
  var root = document.createElement('div')
  root.className = 'dm-root'

  var tip = document.createElement('div')
  tip.className = 'dm-tip'

  var wheel = document.createElement('div')
  wheel.className = 'dm-wheel'
  wheel.innerHTML = [
    '<div class="dm-mask">',
    '<svg viewBox="0 0 380 220" xmlns="http://www.w3.org/2000/svg">',
    '<defs>',
    '<clipPath id="dmCpLimit"><path d="M100,210 L10,210 A180,180 0 0 1 100,54.1 L145,132.1 A90,90 0 0 0 100,210 Z"/></clipPath>',
    '<clipPath id="dmCpPlan"><path d="M100,54.1 A180,180 0 0 1 280,54.1 L235,132.1 A90,90 0 0 0 145,132.1 Z"/></clipPath>',
    '<clipPath id="dmCpGrill"><path d="M280,210 L370,210 A180,180 0 0 0 280,54.1 L235,132.1 A90,90 0 0 1 280,210 Z"/></clipPath>',
    '<clipPath id="dmCpStd"><path d="M100,210 A90,90 0 0 1 280,210 Z"/></clipPath>',
    '<linearGradient id="dmPanelGrad" x1="0" y1="0" x2="0" y2="1">',
    '<stop offset="0" stop-color="#FFFFFF"/><stop offset="0.55" stop-color="#FBFDFF"/><stop offset="1" stop-color="#E8F1FB"/>',
    '</linearGradient>',
    '<radialGradient id="dmHalo" cx="0.5" cy="0.5" r="0.5">',
    '<stop offset="0.45" stop-color="#3E7BD6" stop-opacity="0.22"/><stop offset="1" stop-color="#3E7BD6" stop-opacity="0"/>',
    '</radialGradient>',
    '</defs>',
    '<ellipse cx="190" cy="176" rx="215" ry="158" fill="url(#dmHalo)"/>',
    '<path d="M10,210 A180,180 0 0 1 370,210" fill="none" stroke="#16233F" stroke-width="8" opacity="0.5"/>',
    '<path d="M14.5,210 A175.5,175.5 0 0 1 365.5,210" fill="none" stroke="#E5C36B" stroke-width="1.2" opacity="0.8"/>',
    '<g data-mode="limit"><path class="sector" d="M150,210 L10,210 A180,180 0 0 1 100,54.1 L170,175.4 A40,40 0 0 0 150,210 Z"/>',
    '<image href="' + ASSET('限制模式.png') + '" x="10" y="100" width="124.6" height="102.2" clip-path="url(#dmCpLimit)" preserveAspectRatio="xMidYMid meet"/></g>',
    '<g data-mode="grill"><path class="sector" d="M230,210 L370,210 A180,180 0 0 0 280,54.1 L210,175.4 A40,40 0 0 1 230,210 Z"/>',
    '<image href="' + ASSET('grill模式.png') + '" x="241" y="102" width="131.4" height="97" clip-path="url(#dmCpGrill)" preserveAspectRatio="xMidYMid meet"/></g>',
    '<g data-mode="plan"><path class="sector" d="M100,54.1 A180,180 0 0 1 280,54.1 L210,175.4 A40,40 0 0 0 170,175.4 Z"/>',
    '<image href="' + ASSET('plan模式.png') + '" x="124" y="28" width="132.8" height="96" clip-path="url(#dmCpPlan)" preserveAspectRatio="xMidYMid meet"/></g>',
    '<g data-mode="standard"><path class="sector" d="M100,210 A90,90 0 0 1 280,210 Z"/>',
    '<image href="' + ASSET('标准模式.png') + '" x="124" y="108" width="131.4" height="97" clip-path="url(#dmCpStd)" preserveAspectRatio="xMidYMid meet"/></g>',
    '<g fill="none" stroke="#4A7BC8" stroke-width="1.2" opacity="0.5" stroke-linecap="round">',
    '<path d="M10,210 A180,180 0 0 1 370,210"/><path d="M100,210 A90,90 0 0 1 280,210"/>',
    '<path d="M145,132.1 L100,54.1"/><path d="M235,132.1 L280,54.1"/><path d="M10,210 L370,210"/>',
    '</g>',
    '</svg>',
    '</div>',
  ].join('')
  wheel.appendChild(tip)

  var nameEl = document.createElement('span')
  nameEl.className = 'dm-name'
  nameEl.textContent = '标准'

  // 执行键：独立的一段，不顶替模式名。
  // 全局模式下"模式名"和"有计划可执行"会同时成立，必须各占各的位置。
  var arrowEl = document.createElement('button')
  arrowEl.className = 'dm-arw'
  arrowEl.type = 'button'
  arrowEl.textContent = '▶'
  arrowEl.title = '执行刚才的这份计划'

  var badge = document.createElement('button')
  badge.className = 'dm-badge'
  badge.type = 'button'
  badge.title = '模式轮盘（右键打开偏好）'
  ;[['grill', 'grill模式激活中.png'], ['plan', 'plan模式激活中.png'], ['standard', '标准模式激活中.png'], ['limit', '限制模式激活中.png']].forEach(function (p) {
    var img = document.createElement('img')
    img.dataset.m = p[0]
    img.src = ASSET(p[1])
    img.alt = p[0]
    badge.appendChild(img)
  })

  // 胶囊三段：头像（左端圆弧）｜模式名｜执行键（有计划时才出现）
  var slot = document.createElement('button')
  slot.className = 'dm-slot'
  slot.type = 'button'
  slot.appendChild(nameEl)

  var pill = document.createElement('div')
  pill.className = 'dm-pill'
  pill.appendChild(badge)
  pill.appendChild(slot)
  pill.appendChild(arrowEl)

  function fireExecute() {
    if (state.protocolVersion !== EXPECTED_PROTOCOL || arrowEl.disabled || !state.pending || !state.planToken) return
    var token = state.planToken
    var requestEpoch = planEpoch
    var requestRevision = state.planRevision
    var requestSequence = ++httpSequence
    arrowEl.disabled = true
    fetch('/dsh-mode/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: sessionId, planToken: token }),
    })
      .then(function (r) { return r.json() })
      .then(function (d) {
        if (disposed || !d) return
        d.clientRequestSequence = requestSequence
        var accepted = applyState(d)
        if (d.ok && accepted && !state.pending) {
          state.silent = true
          paint()
        } else if (!d.ok && accepted) {
          badge.title = d.reason || d.error || '计划已失效，请等待新的完整计划'
          arrowEl.title = badge.title
        }
      })
      .catch(function () {
        if (disposed || planEpoch !== requestEpoch || state.planRevision !== requestRevision || state.planToken !== token) return
        state.pending = false; state.planToken = null
        badge.title = '执行请求连接失败，请检查会话状态后重试'
        paint()
      })
      .then(function () { arrowEl.disabled = false })
  }

  // 偏好面板（改的是默认配置）
  var panel = document.createElement('div')
  panel.className = 'dm-panel'
  panel.innerHTML = [
    '<div class="dm-row"><label>作用域</label>',
    '<span style="font-size:11.5px">每个会话独立</span></div>',
    '<div class="dm-row"><label>退出延迟</label>',
    '<input data-k="leaveDelay" type="number" min="0" max="2000" step="50" style="width:76px"></div>',
    '<div class="dm-row"><label>标签</label>',
    '<select data-k="labelLang"><option value="en">英文</option><option value="zh">中文</option><option value="off">关闭</option></select></div>',
    '<div class="dm-row"><label>模式名</label><input data-k="showModeName" type="checkbox"></div>',
    '<div class="dm-foot"><button class="dm-btn" data-act="close">关闭</button></div>',
  ].join('')

  // All widget DOM stays inside the official input slot.
  root.appendChild(wheel)
  root.appendChild(pill)
  root.appendChild(panel)
  container.appendChild(root)
  // One lifecycle marker lets the host verify the real desktop loaded the new client.
  // No page content, storage, geometry polling or host-DOM discovery is collected.
  fetch('/dsh-mode/diag', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ why: 'slot-mounted', revision: 'composer-slot-v1/session-core-v2', sessionId: sessionId, ts: Date.now() })
  }).catch(function () {})

  // ---------- 主题：跟随 DSH 的明暗设定 ----------
  // DSH 有深色/浅色两套，插件不能写死底色。这里读页面实际的背景色判明暗，
  // 再在 root 上打 dm-light，让 CSS 换一套颜色。
  function themeOf() {
    try {
      var el = document.body || document.documentElement
      var bg = getComputedStyle(el).backgroundColor || ''
      var m = /rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?\)/.exec(bg)
      if (m) {
        var a = m[4] === undefined ? 1 : parseFloat(m[4])
        if (a > 0.2) {
          var lum = 0.299 * +m[1] + 0.587 * +m[2] + 0.114 * +m[3]
          return lum < 128 ? 'dark' : 'light'
        }
      }
    } catch (e) {}
    try { return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light' } catch (e) { return 'dark' }
  }
  var lastTheme = ''
  function syncTheme() {
    var t = themeOf()
    if (t === lastTheme) return
    lastTheme = t
    root.classList.toggle('dm-light', t === 'light')
  }

  // No viewport positioning, scroll listener, MutationObserver or geometry polling.
  syncTheme()

  // ---------- 状态 ----------
  function api(body) {
    var payload = body ? Object.assign({}, body, { href: location.href }) : null
    var opts = payload
      ? { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }
      : {}
    var q = sessionId ? ('?session=' + encodeURIComponent(sessionId)) : ''
    var requestSequence = ++httpSequence
    return fetch('/dsh-mode/state' + q, opts).then(function (r) { return r.json() }).then(function (d) {
      d.clientRequestSequence = requestSequence
      return d
    })
  }
  function applyPlanState(d, fromStream) {
    if (disposed || !d || (!fromStream && streamDisconnected)) return false
    // An ordered live stream owns the host epoch. A previously unseen old HTTP reply
    // cannot retire that epoch, even on the first mount after a host restart.
    if (!fromStream && streamEpoch && d.planEpoch !== streamEpoch) return false
    if (!fromStream && Number.isInteger(d.clientRequestSequence) && d.clientRequestSequence < acceptedHttpSequence && d.planEpoch !== planEpoch) return false
    if (d.protocolVersion !== EXPECTED_PROTOCOL) {
      state.protocolVersion = null
      state.pending = false; state.planToken = null
      badge.title = '客户端与状态核心版本不一致，请完整重启 DSH'
      paint()
      return false
    }
    if (d.ok === false && !d.mode) {
      state.pending = false; state.planToken = null
      badge.title = d.reason || d.error || '会话状态读取失败，操作已暂停'
      paint()
      return false
    }
    if (typeof d.planEpoch === 'string' && d.planEpoch !== planEpoch) {
      if (retiredPlanEpochs.has(d.planEpoch)) return false
      if (planEpoch) retiredPlanEpochs.add(planEpoch)
      planEpoch = d.planEpoch
      state.planRevision = -1
    }
    var revision = Number.isSafeInteger(d.planRevision) ? d.planRevision : -1
    // A delayed GET must not resurrect A after the stream has invalidated it.
    if (revision < state.planRevision) return false
    state.planRevision = revision
    if (fromStream) streamEpoch = d.planEpoch
    else if (Number.isInteger(d.clientRequestSequence)) acceptedHttpSequence = Math.max(acceptedHttpSequence, d.clientRequestSequence)
    state.protocolVersion = d.protocolVersion
    if (d.mode) state.mode = d.mode
    state.selectedMode = d.selectedMode || state.mode
    state.modePending = !!d.modePending
    if (d.scope) state.scope = d.scope
    if (d.prefs) state.prefs = d.prefs
    clearTimeout(planExpiryTimer)
    var expiresAt = Number(d.planExpiresAt)
    var valid = d.pendingExecution && (!expiresAt || expiresAt > Date.now())
    state.planToken = valid && typeof d.planToken === 'string' ? d.planToken : null
    state.pending = !!state.planToken
    if (state.pending) {
      state.silent = false
      if (expiresAt) planExpiryTimer = setTimeout(function () {
        state.pending = false; state.planToken = null; paint()
      }, Math.max(0, expiresAt - Date.now()))
    }
    arrowEl.title = state.pending ? '执行计划：' + (d.planTitle || '当前完整计划') : (d.statusReason || '等待新的完整计划')
    badge.title = state.modePending
      ? '本轮：' + (ZH[state.mode] || state.mode) + '；已选择：' + (ZH[state.selectedMode] || state.selectedMode) + '（下一轮生效）'
      : (d.statusReason || '模式轮盘（右键打开偏好）')
    paint()
    syncPanel()
    return true
  }
  function applyState(d) { return applyPlanState(d, false) }
  function paint() {
    nameEl.textContent = state.prefs.labelLang === 'zh' ? (ZH[state.mode] || '标准') : (EN[state.mode] || 'BASE')
    pill.classList.toggle('act', !!state.pending)
    // 名字始终渲染（宽度稳定，不跳）；▶ 是一层绝对定位的覆盖物，压在上面
    var showName = !!state.pending || (!state.silent && !!state.prefs.showModeName)
    slot.style.display = showName ? '' : 'none'
    badge.querySelectorAll('img').forEach(function (img) { img.classList.toggle('on', img.dataset.m === state.mode) })
    wheel.querySelectorAll('g[data-mode]').forEach(function (g) { g.classList.toggle('sel', g.dataset.mode === state.mode) })
  }
  function setMode(m) {
    if (state.protocolVersion !== EXPECTED_PROTOCOL || streamDisconnected) {
      badge.title = streamDisconnected ? '会话状态连接已断开，恢复后再切换模式' : '状态核心尚未就绪或版本不一致，请完整重启 DSH'
      return
    }
    state.silent = false
    api({ mode: m, sessionId: sessionId }).then(applyState).catch(function () {
      if (!disposed) badge.title = '模式切换失败；当前模式未改变，请检查连接'
    })
  }
  function syncPanel() {
    panel.querySelector('[data-k=leaveDelay]').value = state.prefs.leaveDelay
    panel.querySelector('[data-k=labelLang]').value = state.prefs.labelLang
    panel.querySelector('[data-k=showModeName]').checked = !!state.prefs.showModeName
  }
  panel.addEventListener('change', function (e) {
    var k = e.target.getAttribute('data-k')
    if (!k) return
    var body = { sessionId: sessionId }
    if (k === 'scope') body.scope = e.target.value
    else {
      var prefs = {}; prefs[k] = k === 'leaveDelay' ? Number(e.target.value) : (k === 'showModeName' ? e.target.checked : e.target.value)
      body.prefs = prefs
    }
    api(body).then(applyState).catch(function () {})
  })
  panel.addEventListener('click', function (e) {
    if (e.target.dataset.act === 'close') panel.classList.remove('show')
  })

  // ---------- 开合 ----------
  var opened = false
  var leaveTimer = null
  function open(event) {
    opened = true
    root.classList.add('open')
    // Opening under a stationary pointer must initialize the same hover state as pointermove.
    if (event) setHot(sectorAt(event.clientX, event.clientY))
  }
  function close2() {
    opened = false; hotMode = null; root.classList.remove('open')
    wheel.querySelectorAll('g.hot').forEach(function (g) { g.classList.remove('hot'); g.style.animation = '' })
    tip.classList.remove('show')
  }
  badge.addEventListener('click', function (e) { e.stopPropagation(); open(e) })
  // 模式名这段：只负责开轮盘
  slot.addEventListener('click', function (e) { e.stopPropagation(); open(e) })
  // 执行键单独一段：只负责执行，不碰轮盘
  arrowEl.addEventListener('click', function (e) { e.stopPropagation(); fireExecute() })
  // The pill and wheel share one slot subtree; leaving the pill for the wheel must not close it.
  function onEnter() { clearTimeout(leaveTimer) }
  function onLeave() {
    clearTimeout(leaveTimer)
    leaveTimer = setTimeout(function () { if (state.prefs.leaveDelay > 0) close2() }, Math.max(0, state.prefs.leaveDelay | 0))
  }
  root.addEventListener('mouseleave', onLeave)
  root.addEventListener('mouseenter', onEnter)
  function onKeyDown(e) { if (e.key === 'Escape') { close2(); panel.classList.remove('show') } }
  document.addEventListener('keydown', onKeyDown)
  function onOutsidePointer(e) {
    if (!root.contains(e.target)) { close2(); panel.classList.remove('show') }
  }
  document.addEventListener('pointerdown', onOutsidePointer)
  root.addEventListener('contextmenu', function (e) {
    e.preventDefault()
    panel.classList.toggle('show')
    syncPanel()
  })

  // ---------- 极坐标命中 ----------
  function sectorAt(clientX, clientY) {
    var svg = wheel.querySelector('svg')
    var r = svg.getBoundingClientRect()
    if (!r.width) return null
    var x = (clientX - r.left) / r.width * 380
    var y = (clientY - r.top) / r.height * 220
    var dx = x - 190, dy = 210 - y
    if (dy < -6) return null
    var d = Math.hypot(dx, dy)
    if (d > 192) return null
    var a = Math.atan2(dy, dx) * 180 / Math.PI
    if (a < -8) return null
    if (d < 94) return 'standard'
    if (a < 60) return 'grill'
    if (a < 120) return 'plan'
    return 'limit'
  }
  function placeTip(g) {
    var svg = wheel.querySelector('svg')
    var img = g.querySelector('image')
    if (!img) return
    var x = img.x.baseVal.value, y = img.y.baseVal.value
    var w = img.width.baseVal.value, h = img.height.baseVal.value
    tip.style.left = ((x + w / 2) / 380 * 380) + 'px'
    tip.style.top = ((y + h * 0.76) / 220 * 220) + 'px'
  }
  var hotMode = null
  function setHot(m) {
    if (m === hotMode) return
    hotMode = m
    wheel.querySelectorAll('g.hot').forEach(function (g) { g.classList.remove('hot') })
    if (!m) { tip.classList.remove('show'); return }
    var g = wheel.querySelector('g[data-mode="' + m + '"]')
    if (!g) return
    g.classList.add('hot')
    tip.textContent = EN[m] || m
    placeTip(g)
    tip.classList.add('show')
  }
  wheel.addEventListener('pointermove', function (e) { setHot(sectorAt(e.clientX, e.clientY)) })
  wheel.addEventListener('pointerleave', function () { setHot(null) })
  wheel.addEventListener('click', function (e) {
    var m = sectorAt(e.clientX, e.clientY)
    if (!m) { close2(); return }
    setMode(m); close2()
  })

  // Eligibility changes arrive immediately. Polling is a recovery path, not a layout loop.
  var planEvents = null
  if (typeof EventSource === 'function') {
    planEvents = new EventSource('/dsh-mode/plan-events?session=' + encodeURIComponent(sessionId))
    planEvents.onmessage = function (event) {
      try {
        var update = JSON.parse(event.data)
        streamDisconnected = false
        applyPlanState(update, true)
      } catch (e) {}
    }
    planEvents.onerror = function () {
      if (disposed) return
      streamDisconnected = true
      state.pending = false; state.planToken = null
      badge.title = '会话状态连接已断开，执行按钮已暂停；连接恢复后自动同步'
      paint()
    }
  }
  api().then(applyState).catch(function () { if (!disposed) paint() })
  var stateTimer = setInterval(function () { api().then(applyState).catch(function () {}) }, 4000)
  return function dispose() {
    disposed = true
    if (planEvents) planEvents.close()
    clearInterval(stateTimer)
    clearTimeout(leaveTimer)
    clearTimeout(planExpiryTimer)
    document.removeEventListener('keydown', onKeyDown)
    document.removeEventListener('pointerdown', onOutsidePointer)
    root.remove()
    style.remove()
  }

    }
    function ModeWidget(props) {
      const ref = React.useRef(null)
      React.useEffect(function () {
        if (!ref.current || !props.boundSessionId) return
        return mountWidget(ref.current, props.boundSessionId)
      }, [props.boundSessionId])
      return React.createElement('span', {
        ref: ref, 'data-dsh-mode-widget': 'composer-slot-v1',
        style: { display: 'inline-flex', alignItems: 'center', flex: '0 0 auto' }
      })
    }
    return {
      inject: ['slots'],
      apply: function (ctx) {
        ctx.slots.inject('conversation.input.left', function () {
          return ctx.slots.register({
            name: 'conversation.input.left',
            id: 'dsh-mode-widget',
            inject: function (sessionId) { return { boundSessionId: sessionId } }
          }, ModeWidget)
        })
      }
    }
  }
})
