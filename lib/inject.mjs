// lib/inject.mjs — 每态的注入文本与工具约束
//
// 设计原则（用户定调）：
//   · 标准模式注入 0 token —— 原汁原味的 DSH
//   · 其余模式只加"这个模式下必须不一样"的那几句，不重复默认行为
//   · 审问模式 = 移植原版 grilling 技能正文，一字不改

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
  '【计划模式 · 只想清楚，不动手】',
  '这一轮的产物是计划，不是成品。说完就停，等用户确认。',
  '',
  '一、命令式语气不等于执行',
  '用户说“把 X 改成 Y”，意思是规划怎么改，不是现在动手。',
  '用户的对话式同意（哪怕明说“行”“可以”）不算批准，不要拿它结束计划或开始执行。',
  '',
  '二、先查后写',
  '用只读手段（读文件、搜索、只读命令）把计划钉在真实现状上：',
  '不写文件、不改配置、不跑会改动文件的格式化或代码生成。',
  '事实自己查，不要问用户“代码在哪”“现在怎么实现的”。',
  '只有用户拥有的选择才问，最多三个问题。',
  '',
  '三、计划要决策完备',
  '写清：目标和成功标准；按模块分组的步骤；公共接口或数据结构的变化；',
  '边界情况与失败模式；怎么验证。',
  '标准是——另一个工程师照着做，不用再替你拍板。',
  '',
  '四、说完就停',
  '只有计划已完整、没有待决需求时才调用 mode_plan_ready 标记完成，再把完整计划作为本轮最终回复给出。讨论、澄清、补需求或草稿阶段不得调用。最后一句问是否照此执行。',
  '不要边说边做，也不要把计划拆成几轮慢慢挤。',
  '',
  '本模式下写文件、执行会改动东西的命令、创建子任务都会被拒绝 —— 别浪费调用去试。',
].join('\n')

const GRILL = '【审问模式】\n\n' + GRILLING + '\n\n只有需求已澄清、无待决问题且给出完整可执行计划时，才调用 mode_plan_ready 标记完成；审问与讨论过程中不要调用。'

const LIMIT = [
  '【限制模式 · 简单问答】',
  '- 不写代码、不改文件、不执行命令、不创建子任务',
  '- 需要外部事实时才查，查几次看问题本身',
  '- 直接回答：不要反复推演、比较多个方案后再开口',
  '- 先答案，后解释',
].join('\n')

export const PROMPTS = { standard: '', plan: PLAN, grill: GRILL, limit: LIMIT }

// 一次性注入：从计划/审问切到标准、且有已确认计划文件时，只在该轮注入
export function planExecutionText(planPath) {
  if (!planPath) return ''
  return ['【执行计划】', `计划文件：${planPath}`, '按该文件的「决策」与「待办」执行；与对话记忆冲突时以文件为准。'].join('\n')
}

export function textFor(mode, extra) {
  const base = PROMPTS[mode] || ''
  return (base + (extra ? '\n\n' + extra : '')).trim()
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
