/**
 * dsh-heatmap-cost — 多 Agent 数据源 (sources)。
 *
 * 聚合本机所有 coding agent 的 token/费用消耗:
 *   dsh         ~/.dsh/sessions 下 session.jsonl.zstd   (zstd JSONL, 估算价)
 *   claude-code ~/.claude/projects 下 .jsonl            (assistant usage, 估算价)
 *   codex       ~/.codex/sessions 下 .jsonl             (token_count 事件, 估算价)
 *   opencode    ~/.local/share/opencode/opencode.db     (SQLite session 表, 真实 cost)
 *   omp         ~/.omp/agent/sessions 下 .jsonl         (usage.cost, 真实 cost)
 *
 * 每个源产出统一的 usage 步骤: { model, time, tokens, cost, agent }
 * 统一聚合为 ledger 结构 (totals / byAgent / byModel / byDay)。
 */
import { readdirSync, readFileSync, statSync, existsSync, createReadStream, mkdirSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { Readable } from 'node:stream'
import { join, dirname } from 'node:path'
import { zstdDecompressAll } from './persistence.js'
import { dayKey, resolveModelPrice } from './index.js'

// node:sqlite (Node 22.5+); 部分环境不可用则 opencode 源自动禁用
let DatabaseSync = null
try { ({ DatabaseSync } = await import('node:sqlite')) } catch { /* sqlite 不可用 */ }

/** 按模型单价估算一步 usage 的成本(无真实 cost 的源用)。 */
const estimateCost = (tokens, price) =>
  ((tokens.input + tokens.cacheWrite) * price.cacheMiss +
    tokens.cacheRead * price.cacheHit +
    tokens.output * price.output) / 1e6

// ── 统一聚合器: 把 usage 步骤折叠成 ledger ──────────────────────────────────
export const aggregateSteps = (steps) => {
  const byDay = new Map()
  const byAgent = new Map()
  const byModel = new Map()
  let tokens = 0
  let cost = 0
  let requests = 0
  const seenSessions = new Set()
  const agentSessionSets = new Map() // agent -> Set(sessionId)

  for (const s of steps) {
    const t = s.tokens
    const tt = t.input + t.output + t.cacheRead + t.cacheWrite
    const c = typeof s.cost === 'number' ? s.cost : 0
    tokens += tt
    cost += c
    requests += 1

    const key = dayKey(s.time)
    let dd = byDay.get(key)
    if (dd === undefined) { dd = { date: key, tokens: 0, cost: 0, requests: 0, modelCosts: {} }; byDay.set(key, dd) }
    dd.tokens += tt
    dd.cost += c
    dd.requests += 1
    const pm = dd.modelCosts[s.model] ?? { cost: 0, tokens: 0 }
    dd.modelCosts[s.model] = { cost: pm.cost + c, tokens: pm.tokens + tt }

    const pa = byAgent.get(s.agent) ?? { tokens: 0, cost: 0, requests: 0 }
    byAgent.set(s.agent, { tokens: pa.tokens + tt, cost: pa.cost + c, requests: pa.requests + 1 })

    const pm2 = byModel.get(s.model) ?? { tokens: 0, cost: 0 }
    byModel.set(s.model, { tokens: pm2.tokens + tt, cost: pm2.cost + c })

    if (s.sessionId) {
      seenSessions.add(s.sessionId)
      let set = agentSessionSets.get(s.agent)
      if (!set) { set = new Set(); agentSessionSets.set(s.agent, set) }
      set.add(s.sessionId)
    }
  }

  return {
    totals: { tokens, cost, requests, sessions: seenSessions.size },
    byAgent: [...byAgent.entries()].map(([agent, v]) => ({
      agent,
      tokens: v.tokens,
      cost: v.cost,
      requests: v.requests,
      sessions: agentSessionSets.get(agent)?.size ?? 0,
    })).sort((a, b) => b.cost - a.cost),
    byModel: [...byModel.entries()].map(([model, v]) => ({ model, tokens: v.tokens, cost: v.cost })).sort((a, b) => b.cost - a.cost),
    byDay: [...byDay.values()].map((d) => ({
      date: d.date,
      tokens: d.tokens,
      cost: d.cost,
      requests: d.requests,
      modelCosts: Object.entries(d.modelCosts).map(([model, v]) => ({ model, cost: v.cost, tokens: v.tokens })).sort((a, b) => b.cost - a.cost),
    })).sort((a, b) => (a.date < b.date ? -1 : 1)),
  }
}

// ── 递归发现文件 ────────────────────────────────────────────────────────────
const walkFiles = (root, match, out = []) => {
  let entries
  try { entries = readdirSync(root, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.local') continue
    const p = join(root, e.name)
    if (e.isDirectory()) walkFiles(p, match, out)
    else if (match(e.name)) out.push(p)
  }
  return out
}

const parseJsonLines = (text) => {
  const out = []
  for (const l of text.split('\n')) {
    if (!l.trim()) continue
    try { const e = JSON.parse(l); if (e && typeof e === 'object') out.push(e) } catch { /* 跳过 */ }
  }
  return out
}

/**
 * 按行过滤解析: 只 JSON.parse 命中关键字的行(流式大文件内存优化)。
 * 大文件(如 codex 86MB JSONL)全量 parse 会产生数倍的对象图,
 * 而 token_count/usage 只出现在少数行, 过滤后峰值内存从 GB 级降到几十 MB。
 */
const parseLinesFiltered = (text, predicate) => {
  const out = []
  let start = 0
  let idx
  while ((idx = text.indexOf('\n', start)) !== -1) {
    const line = start === idx ? '' : text.slice(start, idx)
    if (line.length > 0 && predicate(line)) {
      try { const e = JSON.parse(line); if (e && typeof e === 'object') out.push(e) } catch { /* 跳过 */ }
    }
    start = idx + 1
  }
  if (start < text.length) {
    const line = text.slice(start)
    if (line.trim() && predicate(line)) {
      try { const e = JSON.parse(line); if (e && typeof e === 'object') out.push(e) } catch { /* 跳过 */ }
    }
  }
  return out
}

/** 事件式 readline: 规避 for-await 在输入快速结束时抛 ERR_USE_AFTER_CLOSE 的坑。 */
const readLines = (input, onLine) => new Promise((resolve, reject) => {
  const rl = createInterface({ input, crlfDelay: Infinity })
  rl.on('line', (line) => { onLine(line) })
  rl.on('close', () => resolve())
  rl.on('error', (err) => reject(err))
})

// ── 各源解析器: 返回 usage 步骤数组 ──────────────────────────────────────────
// 每个步骤: { model, time, tokens:{input,output,cacheRead,cacheWrite}, cost?, agent, sessionId }

/** DSH: zstd JSONL。解压后经 readline 流式逐行, 只处理 header/model/usage 行,
 *  避免 text.slice 逐行产生引用大 Buffer 的 SlicedString(内存暴涨)。 */
const parseDshFile = async (filePath, getConfig) => {
  const buf = readFileSync(filePath)
  const text = (buf[0] === 0x28 ? zstdDecompressAll(buf) : buf).toString('utf8')
  let agent = 'unknown'
  let sessionId = null
  let currentModel = null
  const byStep = new Map()
  const keep = (line) => (
    line.includes('"type":"session"') ||
    line.includes('"type":"request/header"') ||
    line.includes('"type":"request/context"') ||
    (line.includes('"type":"assistant/chunk"') && line.includes('"type":"usage"')) ||
    (line.includes('"type":"assistant/message"') && line.includes('"usage"'))
  )
  await readLines(Readable.from([text]), (line) => {
    if (line.length === 0 || !keep(line)) return
    let e
    try { e = JSON.parse(line) } catch { return }
    if (e === null || typeof e !== 'object') return
    if (e.type === 'session') {
      agent = typeof e.agentPreset === 'string' && e.agentPreset !== '' ? e.agentPreset : 'unknown'
      sessionId = e.id ?? null
      return
    }
    if (e.type === 'request/header') { const m = e.data?.header?.config?.model; if (typeof m === 'string' && m !== '') currentModel = m; return }
    if (e.type === 'request/context') { const m = e.data?.model; if (typeof m === 'string' && m !== '') currentModel = m; return }
    let usage = null
    let turn = 0
    let step = 0
    if (e.type === 'assistant/chunk' && e.data?.chunk?.type === 'usage') { ;({ turn, step } = e.data); usage = e.data.chunk.usage }
    else if (e.type === 'assistant/message' && e.data?.usage !== undefined) { ;({ turn, step, usage } = e.data) }
    if (usage === null) return
    byStep.set(`${turn}:${step}`, {
      model: currentModel ?? 'unknown',
      tokens: {
        input: usage.inputTokens,
        output: usage.outputTokens,
        cacheRead: usage.cacheReadTokens ?? 0,
        cacheWrite: usage.cacheWriteTokens ?? 0,
      },
      time: typeof e.time === 'number' ? e.time : Date.now(),
    })
  })
  return [...byStep.values()].map((s) => ({ ...s, agent: 'dsh', sessionId }))
}

/** Claude Code: ~/.claude/projects/<cwd>/<uuid>.jsonl, assistant 消息带 usage (流式) */
const parseClaudeFile = async (filePath) => {
  const steps = []
  let sessionId = null
  await readLines(createReadStream(filePath), (line) => {
    if (line.length === 0 || !line.includes('"usage"') || !line.includes('assistant')) return
    try {
      const e = JSON.parse(line)
      if (e.sessionId) sessionId = e.sessionId
      if (e.type === 'assistant' && e.message?.usage) {
        const u = e.message.usage
        steps.push({
          model: typeof e.model === 'string' && e.model !== '' ? e.model : 'unknown',
          tokens: {
            input: u.input_tokens ?? 0,
            output: u.output_tokens ?? 0,
            cacheRead: u.cache_read_input_tokens ?? 0,
            cacheWrite: u.cache_creation_input_tokens ?? 0,
          },
          time: e.timestamp ? new Date(e.timestamp).getTime() : Date.now(),
          cost: null,
          agent: 'claude-code',
          sessionId,
        })
      }
    } catch { /* 跳过 */ }
  })
  return steps
}

/** Codex: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl, token_count 事件
 * 注意: token_count 的 total_token_usage 是**会话累计值**(每步重报累计),
 * 必须按会话取最后一个事件, 不能累加, 否则重复计数。 */
const parseCodexFile = async (filePath) => {
  // 流式 readline: 只处理含 token_count 或首个含 model 的行, 2.4GB JSONL 内存 O(单行)
  const perSession = new Map() // sessionId -> { model, usage, time }
  let model = 'unknown'
  let gotModel = false
  await readLines(createReadStream(filePath), (line) => {
    if (line.length === 0) return
    if (!gotModel && line.includes('"model"')) {
      try {
        const e = JSON.parse(line)
        const m = e.payload?.model || e.payload?.model_config?.name || e.model
        if (typeof m === 'string' && m !== '') { model = m; gotModel = true }
      } catch { /* 跳过 */ }
    }
    if (line.includes('token_count')) {
      try {
        const e = JSON.parse(line)
        if (e.type === 'event_msg' && e.payload?.type === 'token_count' && e.payload?.info?.total_token_usage) {
          const sid = typeof e.payload?.session_id === 'string' && e.payload.session_id !== ''
            ? e.payload.session_id
            : (e.payload?.session?.id || filePath)
          const u = e.payload.info.total_token_usage
          perSession.set(sid, {
            model,
            tokens: {
              input: u.input_tokens ?? 0,
              output: u.output_tokens ?? 0,
              cacheRead: u.cached_input_tokens ?? 0,
              cacheWrite: 0,
            },
            time: e.timestamp ? new Date(e.timestamp).getTime() : Date.now(),
            sessionId: sid,
          })
        }
      } catch { /* 跳过 */ }
    }
  })
  return [...perSession.values()].map((s) => ({ ...s, cost: null, agent: 'codex' }))
}

/** opencode: SQLite session 表 (直接有 cost/tokens/agent/model) */
const parseOpencodeDb = (dbPath) => {
  if (DatabaseSync === null) return []
  const steps = []
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true })
    const rows = db.prepare('SELECT id, agent, model, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, time_created FROM session').all()
    db.close()
    for (const r of rows) {
      const input = Number(r.tokens_input ?? 0)
      const output = Number(r.tokens_output ?? 0)
      const cacheRead = Number(r.tokens_cache_read ?? 0)
      const cacheWrite = Number(r.tokens_cache_write ?? 0)
      if (input + output + cacheRead + cacheWrite <= 0) continue
      steps.push({
        model: r.model || 'unknown',
        tokens: { input, output, cacheRead, cacheWrite },
        time: Number(r.time_created) * 1000,
        cost: Number(r.cost ?? 0) > 0 ? Number(r.cost) : null,
        agent: 'opencode',
        sessionId: r.id,
      })
    }
  } catch { /* db 锁定或损坏则跳过 */ }
  return steps
}

/** omp: ~/.omp/agent/sessions/<cwd>/<ts>_<id>.jsonl, usage 嵌套在 message 对象里 (流式) */
const parseOmpFile = async (filePath) => {
  const steps = []
  let model = 'unknown'
  let sessionId = null
  const rl = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity })
  await readLines(createReadStream(filePath), (line) => {
    if (line.length === 0 || (!line.includes('model_change') && !line.includes('"usage"'))) return
    try {
      const e = JSON.parse(line)
      if (e.id && e.type === 'session') sessionId = e.id
      if (e.type === 'model_change' && typeof e.model === 'string' && e.model !== '') model = e.model
      if (e.type === 'message' && e.message?.usage) {
        const u = e.message.usage
        steps.push({
          model: typeof e.model === 'string' && e.model !== '' ? e.model : model,
          tokens: {
            input: u.input ?? 0,
            output: u.output ?? 0,
            cacheRead: u.cacheRead ?? 0,
            cacheWrite: u.cacheWrite ?? 0,
          },
          time: e.timestamp ? new Date(e.timestamp).getTime() : Date.now(),
          cost: typeof u.cost?.total === 'number' ? u.cost.total : null,
          agent: 'omp',
          sessionId,
        })
      }
    } catch { /* 跳过 */ }
  })
  return steps
}

// ── 源注册表 ────────────────────────────────────────────────────────────────
export const buildSources = (config, dshHome) => {
  const home = process.env.HOME || '/Users/aubergine'
  const mk = (enabled, root, parse) => (enabled ? { enabled: true, root, parse } : { enabled: false })

  return {
    dsh: mk(config.dshEnabled !== false, config.sessionsRoot || join(dshHome, 'sessions'), parseDshFile),
    'claude-code': mk(config.claudeCodeEnabled !== false, config.claudeCodeRoot || join(home, '.claude', 'projects'), parseClaudeFile),
    codex: mk(config.codexEnabled !== false, config.codexRoot || join(home, '.codex', 'sessions'), parseCodexFile),
    opencode: mk(config.opencodeEnabled !== false, config.opencodeRoot || join(home, '.local', 'share', 'opencode', 'opencode.db'), parseOpencodeDb),
    omp: mk(config.ompEnabled !== false, config.ompRoot || join(home, '.omp', 'agent', 'sessions'), parseOmpFile),
  }
}

/**
 * 多源增量账本: 每个源扫描/解析/指纹缓存, 聚合为 ledger。
 * 每个源独立指纹缓存文件, 只重扫变化的文件。
 */
export const buildMultiLedger = async ({ sources, ledgerFile, getConfig }) => {
  let ledger = { version: 2, sources: {} }
  if (existsSync(ledgerFile)) {
    try { ledger = JSON.parse(readFileSync(ledgerFile, 'utf8')) } catch { ledger = { version: 2, sources: {} } }
  }
  // 兼容旧版账本(v1 只有 sessions 字段)
  if (ledger === null || typeof ledger !== 'object' || !ledger.sources || typeof ledger.sources !== 'object') {
    ledger = { version: 2, sources: {} }
  }

  // 逐文件处理并立即丢弃原始 steps, 只缓存每文件聚合后的 stats(小对象),
  // 避免大文件(几十 MB JSONL)在内存里滞留 → 峰值内存从 GB 级降到几 MB。
  const fileStats = [] // { stats } 列表
  for (const [srcId, src] of Object.entries(sources)) {
    if (!src.enabled) continue
    let cache = ledger.sources[srcId]?.files ?? {}
    const updated = {}
    let discovered = []
    try {
      if (srcId === 'opencode') {
        discovered = existsSync(src.root) ? [src.root] : []
      } else {
        discovered = walkFiles(src.root, (name) => name.endsWith('.jsonl') || name === 'session.jsonl.zstd')
      }
    } catch { discovered = [] }

    for (const f of discovered) {
      let st
      try { st = statSync(f) } catch { continue }
      const fp = `${st.size}:${st.mtimeMs}`
      const cached = cache[f]
      if (cached !== undefined && cached.fp === fp && cached.stats !== undefined) {
        updated[f] = cached
        continue
      }
      try {
        const parsed = await src.parse(f, getConfig)
        const steps = parsed.map((s) => (
          typeof s.cost === 'number'
            ? s
            : { ...s, cost: estimateCost(s.tokens, resolveModelPrice(getConfig(), s.model, s.time)) }
        ))
        // 单文件聚合后丢弃 steps, 缓存小 stats
        const stats = aggregateSteps(steps)
        const entry = { fp, stats }
        updated[f] = entry
      } catch { /* 单文件失败跳过 */ }
    }
    ledger.sources[srcId] = { files: updated }
    for (const e of Object.values(updated)) fileStats.push(e.stats)
  }

  try {
    mkdirSync(dirname(ledgerFile), { recursive: true })
    writeFileSync(ledgerFile, JSON.stringify(ledger))
  } catch { /* 写失败不影响响应 */ }

  // 合并所有文件的 stats
  return mergeStats(fileStats)
}

/** 合并多个文件的 stats(每文件聚合结果) → 全局 ledger。 */
const mergeStats = (statsList) => {
  const byDay = new Map()
  const byAgent = new Map()
  const byModel = new Map()
  let tokens = 0
  let cost = 0
  let requests = 0
  let sessions = 0

  for (const s of statsList) {
    tokens += s.totals.tokens
    cost += s.totals.cost
    requests += s.totals.requests
    sessions += s.totals.sessions
    for (const a of s.byAgent) {
      const pa = byAgent.get(a.agent) ?? { tokens: 0, cost: 0, requests: 0, sessions: 0 }
      byAgent.set(a.agent, {
        tokens: pa.tokens + a.tokens,
        cost: pa.cost + a.cost,
        requests: pa.requests + a.requests,
        sessions: pa.sessions + a.sessions,
      })
    }
    for (const m of s.byModel) {
      const pm = byModel.get(m.model) ?? { tokens: 0, cost: 0 }
      byModel.set(m.model, { tokens: pm.tokens + m.tokens, cost: pm.cost + m.cost })
    }
    for (const d of s.byDay) {
      let dd = byDay.get(d.date)
      if (dd === undefined) { dd = { date: d.date, tokens: 0, cost: 0, requests: 0, modelCosts: {} }; byDay.set(d.date, dd) }
      dd.tokens += d.tokens
      dd.cost += d.cost
      dd.requests += d.requests
      for (const mc of d.modelCosts) {
        const pm = dd.modelCosts[mc.model] ?? { cost: 0, tokens: 0 }
        dd.modelCosts[mc.model] = { cost: pm.cost + mc.cost, tokens: pm.tokens + mc.tokens }
      }
    }
  }

  return {
    totals: { tokens, cost, requests, sessions },
    byAgent: [...byAgent.entries()].map(([agent, v]) => ({ agent, ...v })).sort((a, b) => b.cost - a.cost),
    byModel: [...byModel.entries()].map(([model, v]) => ({ model, tokens: v.tokens, cost: v.cost })).sort((a, b) => b.cost - a.cost),
    byDay: [...byDay.values()].map((d) => ({
      date: d.date,
      tokens: d.tokens,
      cost: d.cost,
      requests: d.requests,
      modelCosts: Object.entries(d.modelCosts).map(([model, v]) => ({ model, cost: v.cost, tokens: v.tokens })).sort((a, b) => b.cost - a.cost),
    })).sort((a, b) => (a.date < b.date ? -1 : 1)),
  }
}
