// dsh-heatmap-cost 集成 smoke: 模拟 Cordis host 上下文挂载插件并调用路由。
// 热力图数据来自 fixture 会话日志(全量历史账本), sessionCost 来自投影 mock。
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeSessionFile } from './fixtures.mjs'

const plugin = await import('../src/index.js')
assert.equal(plugin.name, 'dsh-heatmap-cost')
assert.equal(typeof plugin.apply, 'function')
assert.ok(plugin.Config, 'Config schema 存在')

// ── fixture 会话日志(全量历史) ──────────────────────────────────────────────
const fxDir = mkdtempSync(join(tmpdir(), 'dsh-hc-int-'))
const t1 = Date.UTC(2026, 7, 17, 2, 0, 0) // 谷时
const t2 = Date.UTC(2026, 7, 18, 3, 0, 0) // 峰时
makeSessionFile(fxDir, 's1', {
  agentPreset: 'liangshen',
  createdAt: t1,
  model: 'deepseek-v4-flash',
  usages: [
    { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 100, cacheWriteTokens: 50, time: t1 },
    { inputTokens: 100, outputTokens: 50, time: t2 },
  ],
})
makeSessionFile(fxDir, 's2', {
  agentPreset: 'standard',
  createdAt: t2,
  model: 'deepseek-v4-pro',
  usages: [
    { inputTokens: 2000, outputTokens: 800, time: t2 },
  ],
})

// ── mock host ctx ───────────────────────────────────────────────────────────
const registered = { webServer: [], projections: [] }
const effects = []
const injected = {}

const mockCtx = {
  effects: effects,
  registered: registered,
  get(key) { return injected[key] },
  inject(key, fn) {
    const k = Array.isArray(key) ? key[0] : key
    if (k === 'webServer') {
      const webServer = { register(route) { registered.webServer.push(route) } }
      fn({ webServer, effect: (fn2) => { fn2(); return () => {} } })
    } else if (k === 'sessionProjections') {
      fn({ sessionProjections: { register(def) { registered.projections.push(def) } } })
    } else {
      fn({})
    }
  },
  effect(fn, label) { effects.push({ fn, label }); return () => {} },
  logger: { warn: () => {} },
}

// 投影快照: 模拟当前会话的投影值
injected.sessions = { list: () => [{ id: 's1', header: { id: 's1' } }] }
injected.sessionProjections = {
  snapshot: () => ({
    values: {
      heatmapSessionCost: {
        models: ['deepseek-v4-pro'], cost: 0.02, costByModel: { 'deepseek-v4-pro': 0.02 },
        tokens: { uncachedInput: 2000, cacheRead: 0, cacheWrite: 0, output: 800 }, currency: 'CNY',
      },
    },
  }),
}

plugin.apply(mockCtx, {
  currency: 'CNY',
  sessionsRoot: fxDir,
  ledgerFile: join(fxDir, 'ledger.json'),
  claudeCodeEnabled: false,
  codexEnabled: false,
  opencodeEnabled: false,
  ompEnabled: false,
})

// ── 断言挂载 ────────────────────────────────────────────────────────────────
assert.equal(effects.length >= 1, true, 'effect 已注册(余额循环)')
assert.equal(registered.webServer.length, 2, '两个路由已注册')
assert.equal(registered.projections.length, 1, '投影单元已注册')
assert.equal(registered.projections[0].key, 'heatmapSessionCost')

// ── 调用主路由 handler ───────────────────────────────────────────────────────
const main = registered.webServer.find((r) => r.path === '/cost-heatmap')
assert.ok(main, '主路由存在')

const responses = []
const mockRes = {
  writeHead(status, headers) { this.status = status; this.headers = headers },
  end(body) { responses.push({ status: this.status, body: typeof body === 'string' ? body : String(body), headers: this.headers }) },
}

await main.handler({ method: 'GET', url: '/cost-heatmap' }, mockRes)
const parsed = JSON.parse(responses[0].body)
assert.equal(parsed.ok, true)
assert.equal(typeof parsed.balance.error, 'string', '余额状态有 error(首次轮询未完成或未配 key)')
assert.ok(parsed.sessionCost, 'sessionCost 存在')
assert.equal(parsed.sessionCost.cost, 0.02)
assert.ok(parsed.heatmap, 'heatmap 存在')
assert.ok(parsed.heatmap.series.length >= 365 && parsed.heatmap.series.length <= 371, '序列长度 365~371(对齐周日)')
assert.equal(new Date(parsed.heatmap.series[0].date + 'T00:00:00').getDay(), 0, '序列从周日开始(列=日历周)')
assert.equal(parsed.heatmap.summary.total.tokens, 4600, '总 token(全部历史会话)')
assert.equal(parsed.heatmap.summary.total.requests, 3, '总请求数')
assert.ok(parsed.heatmap.series.every((d) => typeof d.cost === 'number' && typeof d.tokens === 'number' && Array.isArray(d.modelCosts)), '每格数值类型 + 每天分模型')
const day17 = parsed.heatmap.series.find((d) => d.date === '2026-08-17')
const day18 = parsed.heatmap.series.find((d) => d.date === '2026-08-18')
assert.ok(day17 && day17.cost > 0, '8-17 有成本(谷时)')
assert.ok(day18 && day18.cost > 0, '8-18 有成本(峰时)')
assert.ok(day17.cost < day18.cost, 'pro 峰时成本应高于 flash 谷时')
const idx17 = parsed.heatmap.series.indexOf(day17)
const idx18 = parsed.heatmap.series.indexOf(day18)
assert.equal(Math.floor(idx17 / 7), Math.floor(idx18 / 7), '8-17 与 8-18 在同一列(同日历周)')
assert.ok(day17.modelCosts.every((m) => typeof m.tokens === 'number'), '每天分模型含 tokens')
assert.ok(parsed.heatmap.modelCosts.length === 2, '分模型成本 2 项')

// ── 全量历史账本断言 ─────────────────────────────────────────────────────────
assert.ok(parsed.totals, 'totals 存在')
assert.equal(parsed.totals.sessions, 2, '账本会话数 2')
assert.equal(parsed.totals.tokens, 4600, '账本总 token')
assert.equal(parsed.totals.requests, 3, '账本总请求')
assert.ok(parsed.totals.cost > 0, '账本总金额 > 0')
assert.ok(Array.isArray(parsed.byAgent), 'byAgent 数组')
assert.equal(parsed.byAgent.length, 1, '1 个数据源(dsh, 其他源已禁用)')
const dshAgent = parsed.byAgent.find((a) => a.agent === 'dsh')
assert.ok(dshAgent && dshAgent.sessions === 2 && dshAgent.tokens === 4600 && dshAgent.cost > 0, 'dsh 源统计(2 会话 4600 tokens)')
console.log('✓ 全量账本: totals/byAgent 正确(按数据源分组, fixture 历史会话计费)')

// ── 配置路由 ────────────────────────────────────────────────────────────────
const cfgRoute = registered.webServer.find((r) => r.path === '/cost-heatmap/config')
const cfgRes = { writeHead(s, h) { this.status = s; this.headers = h }, end(b) { responses.push({ status: this.status, body: String(b) }) } }
await cfgRoute.handler({ method: 'GET', url: '/cost-heatmap/config' }, cfgRes)
const cfg = JSON.parse(responses[1].body)
assert.equal(cfg.ok, true)
assert.equal(cfg.config.currency, 'CNY')
assert.equal(cfg.config.heatmapDays, 365)

// ── HEAD 请求 ───────────────────────────────────────────────────────────────
const headRes = { writeHead(s, h) { this.status = s; this.headers = h }, end(b) { responses.push({ status: this.status, body: String(b) }) } }
await main.handler({ method: 'HEAD', url: '/cost-heatmap' }, headRes)
assert.equal(headRes.status, 200)

// ── 405 ─────────────────────────────────────────────────────────────────────
const badRes = { writeHead(s, h) { this.status = s; this.headers = h }, end(b) { responses.push({ status: this.status, body: String(b) }) } }
await cfgRoute.handler({ method: 'DELETE', url: '/cost-heatmap/config' }, badRes)
assert.equal(badRes.status, 405)

console.log('✓ 挂载: 余额循环 / 2 路由 / 投影单元')
console.log('✓ /cost-heatmap: 365 天序列, 汇总, 分模型, sessionCost')
console.log('✓ 谷峰计费区分:', day17.cost.toFixed(6), '<', day18.cost.toFixed(6))
console.log('✓ /config GET / HEAD / 405')

rmSync(fxDir, { recursive: true, force: true })
console.log('\n集成测试全部通过 ✅')
