// dsh-heatmap-cost 集成 smoke: 模拟 Cordis host 上下文挂载插件并调用路由。
import assert from 'node:assert/strict'

const plugin = await import('../src/index.js')
assert.equal(plugin.name, 'dsh-heatmap-cost')
assert.equal(typeof plugin.apply, 'function')
assert.ok(plugin.Config, 'Config schema 存在')

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

// 模拟 sessions: 两个会话, 各带 usage 事件
const ts1 = Date.UTC(2026, 7, 17, 2, 0, 0) // 谷时
const ts2 = Date.UTC(2026, 7, 18, 3, 0, 0) // 峰时
const mkSession = (id, events) => ({ id, header: { id }, events })
const s1 = mkSession('s1', [
  { type: 'request/header', data: { header: { config: { model: 'deepseek-v4-flash' } } }, seq: 1, time: ts1 },
  { type: 'assistant/chunk', data: { turn: 1, step: 0, chunk: { type: 'usage', usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 100, cacheWriteTokens: 50 } } }, seq: 2, time: ts1 },
])
const s2 = mkSession('s2', [
  { type: 'request/header', data: { header: { config: { model: 'deepseek-v4-pro' } } }, seq: 1, time: ts2 },
  { type: 'assistant/message', data: { turn: 1, step: 0, usage: { inputTokens: 2000, outputTokens: 800 } }, seq: 2, time: ts2 },
])
injected.sessions = { list: () => [s1, s2] }
// 投影快照: 模拟当前会话的投影值
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

plugin.apply(mockCtx, { currency: 'CNY' })

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
assert.equal(parsed.heatmap.series.length, 365, '365 天序列')
assert.equal(parsed.heatmap.summary.total.tokens, 1000 + 500 + 100 + 50 + 2000 + 800, '总 token')
assert.equal(parsed.heatmap.summary.total.requests, 2, '总请求数')
assert.ok(parsed.heatmap.series.every((d) => typeof d.cost === 'number' && typeof d.tokens === 'number' && Array.isArray(d.modelCosts)), '每格数值类型 + 每天分模型')
const day17 = parsed.heatmap.series.find((d) => d.date === '2026-08-17')
const day18 = parsed.heatmap.series.find((d) => d.date === '2026-08-18')
assert.ok(day17 && day17.cost > 0, '8-17 有成本(谷时)')
assert.ok(day18 && day18.cost > 0, '8-18 有成本(峰时)')
assert.ok(day17.cost < day18.cost, 'pro 峰时成本应高于 flash 谷时')
assert.ok(parsed.heatmap.modelCosts.length === 2, '分模型成本 2 项')

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
console.log('\n集成测试全部通过 ✅')
