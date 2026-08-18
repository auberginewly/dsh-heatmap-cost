// dsh-heatmap-cost 持久化账本测试: zstd 多帧解压 / 会话解析 / 增量账本。
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { makeSessionFile } from './fixtures.mjs'
import { zstdDecompressAll, discoverSessionFiles, parseSessionFile, buildLedger } from '../src/persistence.js'

const cfg = { currency: 'CNY', prices: {}, pricesOffPeak: {}, defaultPrices: { cacheHit: 0.1, cacheMiss: 1, output: 2 } }
const getConfig = () => cfg

// 1. 多帧解压: 拼接两个 frame 全部解出
const a = Buffer.from('line1\n')
const b = Buffer.from('line2\n')
const joined = Buffer.concat([zstdCompressSync(a), zstdCompressSync(b)])
const out = zstdDecompressAll(joined)
assert.equal(out.toString('utf8'), 'line1\nline2\n', '多 frame 全部解压')
console.log('✓ zstd 多帧解压')

// 2. 会话解析
const dir = mkdtempSync(join(tmpdir(), 'dsh-hc-test-'))
try {
  const t1 = Date.UTC(2026, 7, 17, 2, 0, 0) // 谷时
  const t2 = Date.UTC(2026, 7, 18, 3, 0, 0) // 峰时
  makeSessionFile(dir, 's-aaa', {
    agentPreset: 'liangshen',
    createdAt: t1,
    model: 'deepseek-v4-flash',
    usages: [
      { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 100, cacheWriteTokens: 50, time: t1 },
      { inputTokens: 2000, outputTokens: 800, cacheReadTokens: 0, cacheWriteTokens: 0, time: t2 },
    ],
  })
  makeSessionFile(dir, 's-bbb', {
    agentPreset: 'standard',
    createdAt: t2,
    model: 'deepseek-v4-pro',
    usages: [
      { inputTokens: 500, outputTokens: 200, time: t2 },
    ],
  })

  const files = discoverSessionFiles(dir)
  assert.equal(files.length, 2, '发现 2 个会话文件')

  const s1 = parseSessionFile(files.find((f) => f.includes('s-aaa')), getConfig)
  assert.equal(s1.agent, 'liangshen')
  assert.equal(s1.requests, 2)
  assert.equal(s1.tokens, 1000 + 500 + 100 + 50 + 2000 + 800, 's1 token 总量')
  assert.ok(s1.cost > 0)
  assert.equal(s1.byDay.length, 2, 's1 跨 2 天')
  assert.equal(s1.byDay[0].date, '2026-08-17')
  console.log('✓ 会话解析(agent/tokens/byDay)', 's1 cost=', s1.cost.toFixed(6))

  // 3. 增量账本
  const ledgerFile = join(dir, 'ledger.json')
  const led1 = buildLedger({ ledgerFile, sessionsRoot: dir, getConfig })
  assert.equal(led1.totals.sessions, 2, '账本 2 会话')
  assert.equal(led1.totals.requests, 3, '总请求 3')
  assert.equal(led1.totals.tokens, (1000 + 500 + 100 + 50 + 2000 + 800) + (500 + 200), '总 token')
  assert.equal(led1.byAgent.length, 2, '2 个 agent')
  const std = led1.byAgent.find((x) => x.agent === 'standard')
  assert.ok(std && std.cost > 0 && std.sessions === 1, 'standard agent 统计')
  assert.equal(led1.byModel.length, 2, '2 个模型')
  assert.ok(led1.byDay.some((d) => d.date === '2026-08-18'), '8-18 有天数据')
  // 账本文件已写
  assert.ok(readFileSync(ledgerFile, 'utf8').includes('s-aaa'), '账本缓存已落盘')

  // 4. 增量: 不变文件用缓存, 新增文件重扫
  const led2 = buildLedger({ ledgerFile, sessionsRoot: dir, getConfig })
  assert.equal(led2.totals.tokens, led1.totals.tokens, '无变化时结果一致')
  makeSessionFile(dir, 's-ccc', {
    agentPreset: 'code',
    createdAt: t2,
    model: 'deepseek-v4-flash',
    usages: [{ inputTokens: 100, outputTokens: 10, time: t2 }],
  })
  const led3 = buildLedger({ ledgerFile, sessionsRoot: dir, getConfig })
  assert.equal(led3.totals.sessions, 3, '新增会话后 3 个')
  assert.equal(led3.totals.tokens, led2.totals.tokens + 110, '新增 token 计入')
  assert.equal(led3.byAgent.length, 3, '3 个 agent 预设')
  console.log('✓ 增量账本(指纹缓存/新增文件重扫)')

  // 5. 损坏文件容错
  mkdirSync(join(dir, 's-bad'), { recursive: true })
  writeFileSync(join(dir, 's-bad', 'session.jsonl.zstd'), Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x01, 0x02]))
  const led4 = buildLedger({ ledgerFile, sessionsRoot: dir, getConfig })
  assert.equal(led4.totals.sessions, 3, '损坏文件跳过不影响其他')
  console.log('✓ 损坏文件容错')
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log('\n持久化测试全部通过 ✅')
