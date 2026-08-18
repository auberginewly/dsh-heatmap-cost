/**
 * dsh-heatmap-cost — 账本扫描子进程。
 *
 * 由 host 进程 spawn, 在**独立进程**里完成全量多源扫描(2.4GB codex 等大文件
 * 解析会产生瞬时大堆), 把聚合结果与文件指纹缓存写回 ledger.json 后退出,
 * 峰值内存随进程退出完全释放 —— host 进程 RSS 不受影响。
 *
 * 用法: node scan-worker.mjs --ledger <path> --sessionsRoot <dir> ...
 *        (其余源路径/开关通过同名 --key value 参数传入)
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { buildMultiLedger, buildSources } from './sources.js'

const argv = process.argv.slice(2)
const getArg = (name, def) => {
  const i = argv.indexOf(`--${name}`)
  return i !== -1 && argv[i + 1] !== undefined ? argv[i + 1] : def
}
const getFlag = (name, def) => {
  const i = argv.indexOf(`--${name}`)
  return i !== -1 ? argv[i + 1] !== 'false' : def
}

const home = homedir()
const dshHome = process.env.DSH_HOME || join(home, '.dsh')
const cfg = {
  currency: getArg('currency', 'CNY'),
  sessionsRoot: getArg('sessionsRoot', join(dshHome, 'sessions')),
  ledgerFile: getArg('ledgerFile', join(dshHome, 'storages', 'dsh-heatmap-cost', 'ledger.json')),
  claudeCodeRoot: getArg('claudeCodeRoot', join(home, '.claude', 'projects')),
  codexRoot: getArg('codexRoot', join(home, '.codex', 'sessions')),
  opencodeRoot: getArg('opencodeRoot', join(home, '.local', 'share', 'opencode', 'opencode.db')),
  ompRoot: getArg('ompRoot', join(home, '.omp', 'agent', 'sessions')),
  prices: {}, pricesOffPeak: {}, defaultPrices: { cacheHit: 0.1, cacheMiss: 1, output: 2 },
  dshEnabled: getFlag('dshEnabled', true),
  claudeCodeEnabled: getFlag('claudeCodeEnabled', true),
  codexEnabled: getFlag('codexEnabled', true),
  opencodeEnabled: getFlag('opencodeEnabled', true),
  ompEnabled: getFlag('ompEnabled', true),
}

const getConfig = () => cfg

const run = async () => {
  const sources = buildSources(cfg, dshHome)
  const result = await buildMultiLedger({ sources, ledgerFile: cfg.ledgerFile, getConfig })
  // 预聚合结果 + 指纹缓存 一起写盘
  const ledger = JSON.parse(await import('node:fs/promises').then((m) => m.readFile(cfg.ledgerFile, 'utf8')).catch(() => '{}'))
  const payload = { version: 3, scannedAt: Date.now(), result, sources: ledger.sources ?? {} }
  mkdirSync(dirname(cfg.ledgerFile), { recursive: true })
  writeFileSync(cfg.ledgerFile, JSON.stringify(payload))
  process.exit(0)
}

run().catch((err) => {
  console.error('[dsh-heatmap-cost worker] failed:', err)
  process.exit(1)
})
