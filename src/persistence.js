/**
 * dsh-heatmap-cost — 全量会话账本 (persistence)。
 *
 * 扫描 `sessionsRoot`(默认 $DSH_HOME/sessions) 下所有持久化会话日志
 * (`session.jsonl.zstd` / `session.jsonl`), 解压并折叠 usage 事件,
 * 按 会话 → 天 → 模型 聚合 token/金额。结果按会话缓存进账本文件,
 * 以 (size, mtimeMs) 指纹识别变化, 只重扫变化的文件, 实现增量更新。
 *
 * 数据源与 ctx.sessions 的内存视图不同: 这里覆盖**全部历史会话**
 * (含已关闭/已归档的), 从用户开始使用 DSH 起计费。
 */
import { readdirSync, readFileSync, statSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { foldUsageEvents, dayKey, costOfBuckets, resolveModelPrice } from './index.js'

/** 多 frame zstd 解压: zstd 拼接 frame 按 magic 切分后逐帧解压。 */
export const zstdDecompressAll = (buf) => {
  const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const starts = []
  let idx = 0
  while ((idx = buf.indexOf(MAGIC, idx)) !== -1) {
    starts.push(idx)
    idx += 4
  }
  if (starts.length === 0) {
    // 无 magic: 尝试整块解压(单 frame 或纯文本)
    try { return zstdDecompressSync(buf) } catch { return buf }
  }
  const out = []
  for (let i = 0; i < starts.length; i++) {
    const end = i + 1 < starts.length ? starts[i + 1] : buf.length
    out.push(zstdDecompressSync(buf.subarray(starts[i], end)))
  }
  return Buffer.concat(out)
}

/** 递归发现所有会话日志文件。 */
export const discoverSessionFiles = (root) => {
  const found = []
  const walk = (dir) => {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name === 'session.jsonl.zstd' || e.name === 'session.jsonl') found.push(p)
    }
  }
  if (existsSync(root)) walk(root)
  return found
}

const parseHeader = (lines) => {
  for (const l of lines) {
    if (!l.trim()) continue
    try {
      const obj = JSON.parse(l)
      if (obj && obj.type === 'session') return obj
    } catch { /* 跳过 */ }
  }
  return null
}

/**
 * 解析单个会话日志 → 每会话统计。
 * @returns { agent, cwd, createdAt, tokens, cost, requests, byModel, byDay } | null
 */
export const parseSessionFile = (filePath, getConfig) => {
  const buf = readFileSync(filePath)
  const text = (buf[0] === 0x28 ? zstdDecompressAll(buf) : buf).toString('utf8')
  const lines = text.split('\n')
  const header = parseHeader(lines)
  if (header === null) return null

  const events = []
  for (const l of lines.slice(1)) {
    if (!l.trim()) continue
    try {
      const e = JSON.parse(l)
      if (e && typeof e === 'object') events.push(e)
    } catch { /* 打包行/未知行跳过 */ }
  }

  const byStep = foldUsageEvents(events)
  const days = new Map()
  const byModel = new Map()
  let tokens = 0
  let cost = 0
  let requests = 0

  for (const { model, buckets, time } of byStep.values()) {
    const key = dayKey(time)
    let d = days.get(key)
    if (d === undefined) { d = { date: key, tokens: 0, cost: 0, requests: 0, byModel: {} }; days.set(key, d) }
    const price = resolveModelPrice(getConfig(), model, time)
    const c = costOfBuckets(buckets, price)
    const t = buckets.uncachedInputTokens + buckets.cacheReadTokens + buckets.cacheWriteTokens + buckets.outputTokens
    d.tokens += t
    d.cost += c
    d.requests += 1
    const pm = d.byModel[model] ?? { tokens: 0, cost: 0 }
    d.byModel[model] = { tokens: pm.tokens + t, cost: pm.cost + c }

    tokens += t
    cost += c
    requests += 1
    const pm2 = byModel.get(model) ?? { tokens: 0, cost: 0 }
    byModel.set(model, { tokens: pm2.tokens + t, cost: pm2.cost + c })
  }

  return {
    agent: typeof header.agentPreset === 'string' && header.agentPreset !== '' ? header.agentPreset : 'unknown',
    cwd: header.cwd ?? null,
    createdAt: header.createdAt ?? 0,
    tokens,
    cost,
    requests,
    byModel: [...byModel.entries()].map(([model, v]) => ({ model, tokens: v.tokens, cost: v.cost })).sort((a, b) => b.cost - a.cost),
    byDay: [...days.values()].sort((a, b) => (a.date < b.date ? -1 : 1)),
  }
}

/**
 * 增量账本: 指纹缓存 + 汇总。
 * @param ledgerFile 账本文件路径
 * @param sessionsRoot 会话根目录
 * @returns { totals, byAgent, byModel, byDay } 全量聚合
 */
export const buildLedger = ({ ledgerFile, sessionsRoot, getConfig }) => {
  let ledger = { version: 1, sessions: {} }
  if (existsSync(ledgerFile)) {
    try { ledger = JSON.parse(readFileSync(ledgerFile, 'utf8')) } catch { ledger = { version: 1, sessions: {} } }
  }

  const files = discoverSessionFiles(sessionsRoot)
  const current = {}

  for (const f of files) {
    let st
    try { st = statSync(f) } catch { continue }
    const fp = `${st.size}:${st.mtimeMs}`
    const cached = ledger.sessions[f]
    if (cached !== undefined && cached.fp === fp) {
      current[f] = cached
      continue
    }
    try {
      const stats = parseSessionFile(f, getConfig)
      if (stats !== null) {
        const entry = { fp, stats }
        current[f] = entry
      }
    } catch { /* 单文件失败跳过 */ }
  }

  // 汇总
  const byDay = new Map()
  const byAgent = new Map()
  const byModel = new Map()
  let tokens = 0
  let cost = 0
  let requests = 0
  let sessionCount = 0

  for (const entry of Object.values(current)) {
    const s = entry.stats
    sessionCount += 1
    tokens += s.tokens
    cost += s.cost
    requests += s.requests
    const pa = byAgent.get(s.agent) ?? { tokens: 0, cost: 0, requests: 0, sessions: 0 }
    byAgent.set(s.agent, { tokens: pa.tokens + s.tokens, cost: pa.cost + s.cost, requests: pa.requests + s.requests, sessions: pa.sessions + 1 })
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
      for (const [model, v] of Object.entries(d.byModel)) {
        const pm = dd.modelCosts[model] ?? { cost: 0, tokens: 0 }
        dd.modelCosts[model] = { cost: pm.cost + v.cost, tokens: pm.tokens + v.tokens }
      }
    }
  }

  // 写回账本(仅缓存指纹与统计, 不参与汇总的状态)
  const slim = {}
  for (const [f, entry] of Object.entries(current)) {
    slim[f] = { fp: entry.fp, stats: entry.stats }
  }
  try {
    mkdirSync(dirname(ledgerFile), { recursive: true })
    writeFileSync(ledgerFile, JSON.stringify({ version: 1, sessions: slim }))
  } catch { /* 写失败不影响响应 */ }

  return {
    totals: { tokens, cost, requests, sessions: sessionCount },
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
