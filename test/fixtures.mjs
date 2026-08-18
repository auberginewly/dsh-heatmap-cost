// 构造 DSH 持久化会话日志 fixture (zstd 多帧拼接的 JSONL)。
// 结构与 dsh-session-persistence-jsonl 一致: header frame + append frames。
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

/**
 * 生成一个会话日志文件。
 * @param dir 会话目录(将创建 <dir>/<id>/)
 * @param opts { agentPreset, createdAt, model, usages: [{inputTokens, outputTokens, cacheReadTokens?, cacheWriteTokens?, turn, step, time}] }
 */
export const makeSessionFile = (dir, id, opts) => {
  const sessionDir = join(dir, id)
  mkdirSync(sessionDir, { recursive: true })
  const header = {
    type: 'session', version: 0, id,
    createdAt: opts.createdAt ?? Date.now(),
    cwd: '/tmp/test-cwd',
    delegationDepth: 0,
    agentPreset: opts.agentPreset ?? 'standard',
  }
  const lines = [JSON.stringify(header)]
  let seq = 1
  const model = opts.model ?? 'deepseek-v4-flash'
  ;(opts.usages ?? []).forEach((u, i) => {
    const turn = u.turn ?? 0
    const step = u.step ?? i
    lines.push(JSON.stringify({ type: 'request/header', seq: seq++, time: u.time, data: { header: { config: { model } } } }))
    lines.push(JSON.stringify({
      type: 'assistant/chunk', seq: seq++, time: u.time,
      data: { turn, step, chunk: { type: 'usage', usage: u } },
    }))
  })
  const text = lines.join('\n') + '\n'
  // 切成两个 frame: header 行 + 其余行 (模拟 append 批次)
  const nl = text.indexOf('\n')
  const frameA = Buffer.from(text.slice(0, nl + 1))
  const frameB = Buffer.from(text.slice(nl + 1))
  const file = join(sessionDir, 'session.jsonl.zstd')
  writeFileSync(file, Buffer.concat([zstdCompressSync(frameA), zstdCompressSync(frameB)]))
  return file
}
