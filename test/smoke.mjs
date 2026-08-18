// dsh-heatmap-cost 核心纯函数 smoke 测试 (node --input-type=module test/smoke.mjs)
import assert from 'node:assert/strict'
import {
  resolveModelPrice, foldUsageEvents, aggregateByDay, costOfBuckets,
  dayKey, makeSessionCostProjection, V4_RATES,
} from '../src/index.js'

const cfg = { currency: 'CNY', prices: {}, pricesOffPeak: {}, defaultPrices: { cacheHit: 0.1, cacheMiss: 1, output: 2 } }
const getConfig = () => cfg

// 1. 定价: 峰时 (2026-08-18T03:00Z = 11:00 BJT) flash → 峰价
const peak = resolveModelPrice(cfg, 'deepseek-v4-flash', Date.UTC(2026, 7, 18, 3, 0, 0))
assert.deepEqual(peak, V4_RATES.CNY.peak['deepseek-v4-flash'], 'peak flash price')
// 谷时 (2026-08-18T23:00Z = 07:00 BJT 次日) → 谷价
const off = resolveModelPrice(cfg, 'deepseek-v4-flash', Date.UTC(2026, 7, 18, 23, 0, 0))
assert.deepEqual(off, V4_RATES.CNY.offPeak['deepseek-v4-flash'], 'off-peak flash price')
// 未知模型 → 回退
const fallback = resolveModelPrice(cfg, 'my-model', Date.UTC(2026, 7, 18, 3, 0, 0))
assert.deepEqual(fallback, cfg.defaultPrices, 'unknown model fallback')
console.log('✓ 定价(谷峰/回退)')

// 2. foldUsageEvents: 同 (turn,step) 去重 + 模型追踪
const ts = Date.UTC(2026, 7, 18, 3, 0, 0)
const events = [
  { type: 'request/header', data: { header: { config: { model: 'deepseek-v4-flash' } } }, seq: 1, time: ts },
  { type: 'assistant/chunk', data: { turn: 1, step: 0, chunk: { type: 'usage', usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 20 } } }, seq: 2, time: ts },
  // 同 step 的替换样本(last-wins)
  { type: 'assistant/chunk', data: { turn: 1, step: 0, chunk: { type: 'usage', usage: { inputTokens: 200, outputTokens: 60, cacheReadTokens: 10, cacheWriteTokens: 20 } } }, seq: 3, time: ts },
  { type: 'request/context', data: { model: 'deepseek-v4-pro' }, seq: 4, time: ts },
  { type: 'assistant/message', data: { turn: 2, step: 0, usage: { inputTokens: 300, outputTokens: 100 } }, seq: 5, time: ts },
]
const folded = foldUsageEvents(events)
assert.equal(folded.size, 2, 'two steps after dedup')
const step0 = folded.get('1:0')
assert.equal(step0.buckets.uncachedInputTokens, 200, 'last-wins input')
assert.equal(step0.model, 'deepseek-v4-flash', 'step0 model from request/header')
const step1 = folded.get('2:0')
assert.equal(step1.model, 'deepseek-v4-pro', 'step1 model from request/context')
assert.equal(step1.buckets.uncachedInputTokens, 300, 'step1 input')
console.log('✓ 事件折叠((turn,step) 去重 / last-wins / 模型追踪)')

// 3. 成本计算: 200 miss + 10 hit + 60 out @flash 峰价
const c0 = costOfBuckets(step0.buckets, resolveModelPrice(cfg, 'deepseek-v4-flash', ts))
// (200+20)*3 + 10*0.1 + 60*9 = 660+1+540 = 1201 /1e6
assert.ok(Math.abs(c0 - 1201e-6) < 1e-9, `step0 cost ${c0}`)
console.log('✓ 成本计算')

// 4. 日聚合
const agg = aggregateByDay(folded, getConfig)
assert.equal(agg.days.length, 1, 'one day')
assert.equal(agg.days[0].requests, 2)
assert.equal(agg.days[0].tokens, 200 + 10 + 20 + 60 + 300 + 100, 'token total')
assert.ok(agg.days[0].cost > 0)
assert.equal(agg.days[0].date, dayKey(ts))
console.log('✓ 日聚合', agg.days[0])

// 5. 当前会话投影单元
const proj = makeSessionCostProjection(getConfig)
let state = proj.init()
for (const e of events) state = proj.apply(state, e)
const view = proj.view(state)
assert.equal(view.tokens.uncachedInput, 500, 'projection input tokens (200+300)')
assert.equal(view.tokens.output, 160, 'projection output tokens (60+100)')
assert.equal(view.models.length, 2, 'two models')
assert.ok(view.cost > 0, 'projection cost > 0')
// 同引用闸门: 无关事件不产生新状态
const same = proj.apply(state, { type: 'user/message', data: {} })
assert.equal(same, state, 'unrelated event returns same reference')
console.log('✓ 会话投影单元', JSON.stringify(view))

console.log('\n全部通过 ✅')
