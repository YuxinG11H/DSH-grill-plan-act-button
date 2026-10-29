// lib/inject.mjs — 每态的注入文本与工具约束
//
// 设计原则（用户定调）：
//   · 标准模式注入 0 token —— 原汁原味的 DSH
//   · 其余模式只加"这个模式下必须不一样"的那几句，不重复默认行为
//   · 计划/审问覆盖所有任务领域；问题卡偏好只控制提问形式，不改变规划边界

// Grilling interview guidance; no machine-specific skill path is required at runtime.
// 用行数组拼接，避免正文里的 ``` 与模板字符串冲突。
const GRILLING = [
  'Interview the user relentlessly until you reach a shared understanding. Map this as a **design tree**: every decision branches into the decisions that hang off it.',
  '',
  'Work the tree in **rounds**. The **frontier** is every decision whose prerequisites are already settled: the questions you can ask _now_ without guessing at answers you haven\'t heard yet. Ask the whole frontier in one round: number each question and give your recommended answer. Then wait for the user\'s answers before the next round.',
  '',
  'Format a round like so:',
  '',
  '```',
  '❓ **Q1** - **<question title>**: <question body, might be multiple paragraphs, including multiple choices>',
  '',
  '➡️ <your recommended answer>',
  '',
  '---',
  '',
  '❓ **Q2** - **<question title>**: <question body, might be multiple paragraphs, including multiple choices>',
  '',
  '➡️ <your recommended answer>',
  '```',
  '',
  'Each round the user answers reshapes the tree: settled decisions push the frontier outward and unblock questions that depended on them. Recompute the frontier and ask the next round. A question whose answer depends on another question still open in this round belongs to a _later_ round, not this one.',
  '',
  'Finding _facts_ is your job, never the user\'s. When a frontier question needs a fact from the environment (filesystem, tools, etc.), dispatch a sub-agent to find it; don\'t ask the user for anything you could look up yourself. Don\'t block on it: a running exploration is an unsettled prerequisite, so only the questions downstream of it wait for the sub-agent to report; ask the rest of the frontier now. The _decisions_ are the user\'s: put each to them and wait.',
  '',
  'The session is done when the frontier is empty: every branch of the design tree visited, nothing left silently assumed. Do not act on it until the user confirms you have reached a shared understanding.',
].join('\n')

// 计划模式 = 官方 plan-mode 的三条防糊弄设计 + 我们自己的工具闸门。
// 官方原文要点（@deepseek-ai/dsh-plan-mode 的 section）：
//   · 命令式语气意味着"规划怎么改"，不是"现在去改"
//   · 用户的对话式同意不算批准，不能用来结束计划
//   · 先探明现状再写计划；事实自己查，只问用户拥有的选择
//   · 计划要决策完备（目标/成功标准/分组/接口变化/边界/验收）
//   · 计划通过专用出口提交，不要当普通回复贴出来
// 我们没有 exit_plan_mode，出口是用户点执行按钮 —— 这一点要在文本里说清。
const PLAN = [
  '【计划模式 · 必要澄清后给出完整计划，不动手】',
  '这一轮的产物是计划，不是成品。用户的命令式请求表示规划如何完成，不是立即执行。',
  '先用只读手段查明现状，只在确有必要时澄清用户拥有的决策，最多三个问题；信息已经充分就直接写完整可执行计划，不必先问问题。',
  '必要澄清结束后一次给出决策完备、可交接执行的完整计划，不要将完整计划当成必须等执行批准之后才能提交的产物。',
  '不写文件、不改配置、不运行有副作用的命令、不交付最终任务成果；对话式同意不代替执行按钮的批准。',
  '本模式下写文件、执行会改动东西的命令、创建子任务都会被拒绝 —— 别浪费调用去试。',
].join('\n')

const PLANNING_POLICY = [
  '【所有任务领域的规划边界】',
  'PLAN 和 GRILL 适用于所有任务领域：代码、研究、分析、写作、创作、设计、问答以及其他任务，没有非代码例外。',
  '即使任务只需文字回答，也只能规划如何完成，不得直接交付成品分析、文章、故事或其他最终成果。',
  '事实问题必须先用可用的只读工具研究；只向用户询问无法自行查明、确实影响方案的决策。不要编造问题，不要为提问而提问；无法查证的事实应说明限制，不得伪装成用户必须作出的决策。',
  '完整可执行计划应覆盖目标、成功标准、已定决策、依赖顺序、具体步骤、相关接口/产物、边界与验证；按任务领域表达，不强套工程模板。',
  '计划完整且没有待决需求时，必须在最终回复之前调用 mode_plan_ready，然后在最终回复中给出完整计划并停止。仅等待用户执行批准不属于待决需求，不得因此拖延或漏掉提交。',
  'mode_plan_ready 仅标记计划已就绪，不是执行授权，不会允许开始执行；不得调用后直接动手。澄清、讨论、草稿或确有未决需求时不得提交。',
].join('\n')

const GRILL = [
  '【审问模式 · 依赖有序的决策访谈】',
  GRILLING,
  '仅询问有真实必要性的决策；已由用户确定的分支不要重问。没有必要问题时直接收束，不要为了凑轮次发明问题。',
  '按依赖顺序完成各轮后，总结共同理解和已定决策，并给出完整可执行计划；共同理解的总结不是最终任务成品。',
  '若共同理解仍需用户确认，先解决这一实际需求；单纯等待执行批准不算未决需求。',
].join('\n\n')

const LIMIT = [
  '【限制模式 · 简单问答】',
  '- 不写代码、不改文件、不执行命令、不创建子任务',
  '- 需要外部事实时才查，查几次看问题本身',
  '- 直接回答：不要反复推演、比较多个方案后再开口',
  '- 先答案，后解释',
].join('\n')

export const PROMPTS = { standard: '', plan: PLAN + '\n\n' + PLANNING_POLICY, grill: GRILL + '\n\n' + PLANNING_POLICY, limit: LIMIT }

// Only booleans override defaults; malformed persisted/request values do not toggle policy.
export function questionCardsDisabled(mode, prefs = {}) {
  const key = mode === 'plan' ? 'disablePlanQuestionCard' : mode === 'grill' ? 'disableGrillQuestionCard' : null
  if (!key) return false
  return typeof prefs?.[key] === 'boolean' ? prefs[key] : mode === 'plan'
}

function questionCardText(mode, prefs) {
  if (mode !== 'plan' && mode !== 'grill') return ''
  if (questionCardsDisabled(mode, prefs)) {
    return '【本模式问题卡已禁用】绝不调用 ask_user_question；确有必要的决策问题使用编号纯文本列出并等待回答（GRILL 仍按依赖有序的轮次进行）。不要为提问而提问。此提问形式优先于上述轮次示例。'
  }
  return '【本模式问题卡已启用】确有必要的决策问题必须使用 ask_user_question；不要只为了使用工具而提问。工具不可用时，向用户说明不可用并退回编号纯文本提问（GRILL 仍按依赖有序的轮次进行）。此提问形式优先于上述轮次示例。'
}

// 一次性注入：从计划/审问切到标准、且有已确认计划文件时，只在该轮注入
export function planExecutionText(planPath) {
  if (!planPath) return ''
  return ['【执行计划】', `计划文件：${planPath}`, '按该文件的「决策」与「待办」执行；与对话记忆冲突时以文件为准。'].join('\n')
}

export function textFor(mode, extra, prefs = {}) {
  if (mode === 'standard') return ''
  const base = PROMPTS[mode] || ''
  return [base, extra, questionCardText(mode, prefs)].filter(Boolean).join('\n\n').trim()
}

// ---- 工具约束 ----
// 只做 deny（guard 语义）：工具还在列表里，调用被拒并给出理由，模型可以改口。
// 名字用正则匹配，避免 DSH 改工具名后整条失效；命中不到的会退化成"没拦住"而不是"拦错"。
const WRITE_RE = /^(write|edit|apply_patch|str_replace|create_file|delete_file|mkdir|move|rename|ops_replace|ops_write)$/i
const SHELL_RE = /^(bash|sh|shell|pwsh|powershell|terminal|exec|run|ops_bash)$/i
const AGENT_RE = /^(subagent|task|agent|spawn_agent|delegate|subagent_fork)$/i

// 每个模式"能不能动手"的定义：
//   plan  = 只读探索（对齐 Claude Code 的 exploration commands）：写/子任务禁，命令按白名单放行
//   grill = 只审问，不写代码不跑命令；但 grilling 技能要求"派子代理查事实"，所以子代理必须放行
//   limit = 简单问答，什么都不动
const MODE_RULES = {
  plan: { write: '计划模式不写文件：先给计划，等用户确认后再执行', agent: '计划模式不创建子任务：先给计划，等用户确认后再执行' },
  grill: { write: '审问模式不写文件：先把问题问清楚、达成共识后再执行', shell: '审问模式不执行命令：先把问题问清楚' },
  limit: { write: '限制模式不允许写改文件', shell: '限制模式不允许执行命令', agent: '限制模式不允许创建子任务' },
}

// Conservative single-command grammar, not an OS security boundary.
// Complex paths/searches should use the host's read/glob/grep tools instead.
const READONLY_GIT = /^git (?:status(?: --(?:short|porcelain|branch))*|diff(?: --(?:stat|name-only|no-ext-diff|no-textconv))*|log(?: --oneline)?(?: -n [1-9][0-9]{0,3})?|show HEAD|rev-parse HEAD|ls-files|branch --list)$/i
const READONLY_FILES = /^(?:ls|dir|cat|type|head|tail|wc|tree)(?: +[A-Za-z0-9_.:/\\][A-Za-z0-9_.:/\\-]*)*$/i
const UNSAFE_CMD = /[\r\n><`|&;$(){}\[\]!"']/

function commandOf(args) {
  if (!args || typeof args !== 'object') return ''
  for (const k of ['command', 'cmd', 'script', 'code', 'args']) {
    const v = args[k]
    if (typeof v === 'string' && v.trim()) return v
  }
  return ''
}

export function isReadOnlyCommand(command) {
  const raw = String(command || '')
  if (UNSAFE_CMD.test(raw)) return false
  const s = raw.trim().replace(/[ \t]+/g, ' ')
  if (!s) return false
  return s === 'pwd' || READONLY_GIT.test(s) || READONLY_FILES.test(s)
}

export function denyReason(mode, toolName, args) {
  const rules = MODE_RULES[mode]
  if (!rules) return null
  if (rules.write && WRITE_RE.test(toolName)) return rules.write
  if (rules.shell && SHELL_RE.test(toolName)) return rules.shell
  if (rules.agent && AGENT_RE.test(toolName)) return rules.agent
  // 计划模式单独处理命令：只读的放行，其余拒绝并说明
  if (mode === 'plan' && SHELL_RE.test(toolName)) {
    return isReadOnlyCommand(commandOf(args))
      ? null
      : '计划模式只允许只读命令（ls/cat/grep/git status 这类）：要跑会改东西的命令，请先给计划、切到标准模式再执行'
  }
  return null
}

// 诊断用：把当前规则展开成可读列表
export function describeRules() {
  return [
    `写改类: ${WRITE_RE}`,
    `执行类: ${SHELL_RE}`,
    `子任务类: ${AGENT_RE}`,
    `plan 禁: 写/命令/子任务 · grill 禁: 写/命令（子代理放行） · limit 禁: 写/命令/子任务`,
  ]
}

// ---- 计划模式的"读取预算" ----
// 计划阶段允许读（计划的准确性依赖现状），但每轮有预算：
// 读完预算就要求先给计划，而不是无限深挖。读取不产生副作用，所以只限次数、不禁止。
const INFO_RE = /^(read|glob|grep|web_search|web_fetch|ops_grep|ops_glob|ops_inspect_local_file|office_read|list_dir|ls)$/i

export function isInfoTool(toolName) {
  if (!toolName) return false
  return INFO_RE.test(toolName) || /^browser_/i.test(toolName)
}

export const PLAN_READ_LIMIT = 10
