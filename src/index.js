/**
 * dsh-heatmap-cost — server half.
 *
 * 1. 余额服务: 按 `refreshIntervalMs` 从 DeepSeek `/user/balance` 拉取余额并缓存,
 *    通过 HTTP 路由 `/cost-heatmap` 提供给浏览器。密钥优先取配置 `apiKey`,
 *    否则经 `ctx.credentials` 解析 `apiKeyRef`(默认 `DEEPSEEK_API_KEY`)。
 * 2. 当前会话消耗投影: 注册 `sessionProjections` 单元 `heatmapSessionCost`,
 *    在已提交的会话事件上按模型折叠 token 用量并估算本会话金额。
 * 3. 热力图聚合: 遍历宿主全部会话事件, 按 (sessionId, turn, step) 去重折叠
 *    token 用量, 按事件时间戳归入日 bucket, 生成近 N 天每日 token/金额序列。
 */
import Schema from '@deepseek-ai/schemastery'
import { z } from 'zod'

export const name = 'dsh-heatmap-cost'

/** 每个模型每 100 万 token 的价格(以 `currency` 计价)。 */
const ModelPrice = Schema.object({
  /** 缓存命中输入价 */
  cacheHit: Schema.number().min(0).default(0.2),
  /** 缓存未命中输入价(含缓存写入) */
  cacheMiss: Schema.number().min(0).default(2),
  /** 输出价 */
  output: Schema.number().min(0).default(8),
})

export const Config = Schema.object({
  /** 显式 API 密钥; 留空则走 apiKeyRef(credentials / 环境变量) */
  apiKey: Schema.string().default(''),
  /** credentials / 环境变量引用名 */
  apiKeyRef: Schema.string().default('DEEPSEEK_API_KEY'),
  /** DeepSeek API 基址 */
  baseUrl: Schema.string().default('https://api.deepseek.com'),
  /** 服务器向 DeepSeek 查询余额的频率(毫秒) */
  refreshIntervalMs: Schema.number().min(1000).default(300000),
  /** 单次请求超时时间(毫秒) */
  timeoutMs: Schema.number().min(1000).default(8000),
  /** 花费估算的计价货币(与 prices 一致) */
  currency: Schema.string().default('CNY'),
  prices: Schema.dict(ModelPrice).default({}),
  /** 谷时模型单价表 */
  pricesOffPeak: Schema.dict(ModelPrice).default({}),
  /** 未列出的模型的回退单价 */
  defaultPrices: ModelPrice.default({ cacheHit: 0.1, cacheMiss: 1, output: 2 }),
  /** 余额预警阈值 */
  warningThreshold: Schema.number().min(0).default(10),
  /** 余额告急阈值 */
  dangerThreshold: Schema.number().min(0).default(5),
  /** 热力图覆盖的天数(最大 400) */
  heatmapDays: Schema.number().min(7).max(400).default(365),
})

/** DeepSeek V4 官方现行定价表 (单位: 每 100 万 tokens, 支持 CNY 与 USD 谷峰费率) */
export const V4_RATES = {
  CNY: {
    peak: {
      'deepseek-v4-flash': { cacheHit: 0.1, cacheMiss: 3, output: 9 },
      'deepseek-v4-pro': { cacheHit: 0.3, cacheMiss: 9, output: 27 },
    },
    offPeak: {
      'deepseek-v4-flash': { cacheHit: 0.05, cacheMiss: 1.5, output: 4.5 },
      'deepseek-v4-pro': { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 },
    },
  },
  USD: {
    peak: {
      'deepseek-v4-flash': { cacheHit: 0.014, cacheMiss: 0.44, output: 1.32 },
      'deepseek-v4-pro': { cacheHit: 0.044, cacheMiss: 1.32, output: 3.96 },
    },
    offPeak: {
      'deepseek-v4-flash': { cacheHit: 0.007, cacheMiss: 0.22, output: 0.66 },
      'deepseek-v4-pro': { cacheHit: 0.022, cacheMiss: 0.66, output: 1.98 },
    },
  },
}

/**
 * 实时计算指定模型在指定时间戳下的单价。
 * 1. 峰时优先匹配 config.prices[model], 谷时优先匹配 config.pricesOffPeak[model];
 * 2. 内置 DeepSeek V4 模型按货币(CNY/USD)与北京时间谷峰费率计算;
 * 3. 其余未知模型回退到 config.defaultPrices。
 */
export const resolveModelPrice = (config, model, timestamp = Date.now()) => {
  const d = new Date(timestamp)
  const hourBJT = (d.getUTCHours() + 8) % 24
  const isPeak = (hourBJT >= 9 && hourBJT < 12) || (hourBJT >= 14 && hourBJT < 18)

  if (isPeak) {
    if (config?.prices?.[model]) return config.prices[model]
  } else {
    if (config?.pricesOffPeak?.[model]) return config.pricesOffPeak[model]
    if (config?.prices?.[model]) return config.prices[model]
  }

  const isV4 = model === 'deepseek-v4-flash' || model === 'deepseek-v4-pro'
  if (!isV4) return config?.defaultPrices ?? { cacheHit: 0.1, cacheMiss: 1, output: 2 }

  const currency = config?.currency?.toUpperCase() === 'USD' ? 'USD' : 'CNY'
  const table = V4_RATES[currency] ?? V4_RATES.CNY
  return (isPeak ? table.peak[model] : table.offPeak[model]) ?? config?.defaultPrices
}

/** 归一化 DeepSeek 余额响应中的金额字符串。 */
const toAmount = (value) => {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

const normalizeBalances = (data) => {
  const infos = Array.isArray(data?.balance_infos) ? data.balance_infos : []
  return infos.map((info) => ({
    currency: typeof info?.currency === 'string' && info.currency !== '' ? info.currency : 'CNY',
    total: toAmount(info?.total_balance),
    granted: toAmount(info?.granted_balance),
    toppedUp: toAmount(info?.topped_up_balance),
  }))
}

const zero = () => ({ uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 })
const bucketsOf = (usage) => ({
  uncachedInputTokens: usage.inputTokens,
  cacheReadTokens: usage.cacheReadTokens ?? 0,
  cacheWriteTokens: usage.cacheWriteTokens ?? 0,
  outputTokens: usage.outputTokens,
})

/**
 * 按 (turn, step) 折叠 usage 事件: 同一步骤的样本是替换语义(last-wins),
 * 绝不重复计数。返回 Map<turn:step, {model, buckets, time}>。
 */
export const foldUsageEvents = (events) => {
  const byStep = new Map()
  let currentModel = null
  for (const event of events) {
    if (event.type === 'request/header') {
      const model = event.data?.header?.config?.model
      if (typeof model === 'string' && model !== '') currentModel = model
    } else if (event.type === 'request/context') {
      const model = event.data?.model
      if (typeof model === 'string' && model !== '') currentModel = model
    }
    let usage = null
    let turn = 0
    let step = 0
    if (event.type === 'assistant/chunk' && event.data?.chunk?.type === 'usage') {
      ;({ turn, step } = event.data)
      usage = event.data.chunk.usage
    } else if (event.type === 'assistant/message' && event.data?.usage !== undefined) {
      ;({ turn, step, usage } = event.data)
    }
    if (usage === null) continue
    const key = `${turn}:${step}`
    byStep.set(key, {
      model: currentModel ?? 'unknown',
      buckets: bucketsOf(usage),
      time: typeof event.time === 'number' ? event.time : Date.now(),
    })
  }
  return byStep
}

/** 把一步 usage 按当前模型价格折算为金额。 */
export const costOfBuckets = (buckets, price) =>
  ((buckets.uncachedInputTokens + buckets.cacheWriteTokens) * price.cacheMiss +
    buckets.cacheReadTokens * price.cacheHit +
    buckets.outputTokens * price.output) / 1e6

/** 本地日期字符串 YYYY-MM-DD(按本机时区)。 */
export const dayKey = (ts) => {
  const d = new Date(ts)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

/**
 * 由折叠后的 usage 步骤生成日聚合。
 * @param byStep Map<turn:step, {model, buckets, time}>
 * @param getConfig 返回运行配置的函数
 */
export const aggregateByDay = (byStep, getConfig) => {
  const days = new Map()
  let totalTokens = 0
  let totalCost = 0
  const modelTotals = new Map()
  for (const { model, buckets, time } of byStep.values()) {
    const key = dayKey(time)
    let bucket = days.get(key)
    if (bucket === undefined) {
      bucket = { date: key, tokens: 0, cost: 0, requests: 0, modelCosts: {} }
      days.set(key, bucket)
    }
    const price = resolveModelPrice(getConfig(), model, time)
    const cost = costOfBuckets(buckets, price)
    const tokens = buckets.uncachedInputTokens + buckets.cacheReadTokens + buckets.cacheWriteTokens + buckets.outputTokens
    bucket.tokens += tokens
    bucket.cost += cost
    bucket.requests += 1
    bucket.modelCosts[model] = (bucket.modelCosts[model] ?? 0) + cost
    totalTokens += tokens
    totalCost += cost
    modelTotals.set(model, (modelTotals.get(model) ?? 0) + cost)
  }
  return {
    days: [...days.values()].map((d) => ({
      ...d,
      modelCosts: Object.entries(d.modelCosts).map(([model, cost]) => ({ model, cost })).sort((a, b) => b.cost - a.cost),
    })).sort((a, b) => (a.date < b.date ? -1 : 1)),
    totalTokens,
    totalCost,
    modelCosts: [...modelTotals.entries()].map(([model, cost]) => ({ model, cost })),
  }
}

/** 当前会话投影单元: 折叠本会话 token 并估算金额。 */
export const makeSessionCostProjection = (getConfig) => {
  return {
    key: 'heatmapSessionCost',
    schema: z.object({
      models: z.array(z.string()),
      cost: z.number().nonnegative(),
      costByModel: z.record(z.string(), z.number().nonnegative()),
      tokens: z.object({
        uncachedInput: z.number().int().nonnegative(),
        cacheRead: z.number().int().nonnegative(),
        cacheWrite: z.number().int().nonnegative(),
        output: z.number().int().nonnegative(),
      }).strict(),
      currency: z.string(),
    }).strict(),
    init: () => ({ currentModel: null, last: null, byModel: {}, modelOrder: [] }),
    apply: (state, event) => {
      let nextModel = state.currentModel
      if (event.type === 'request/header') {
        const model = event.data?.header?.config?.model
        if (typeof model === 'string' && model !== '') nextModel = model
      } else if (event.type === 'request/context') {
        const model = event.data?.model
        if (typeof model === 'string' && model !== '') nextModel = model
      }
      let usage = null
      let turn = 0
      let step = 0
      if (event.type === 'assistant/chunk' && event.data?.chunk?.type === 'usage') {
        ;({ turn, step } = event.data)
        usage = event.data.chunk.usage
      } else if (event.type === 'assistant/message' && event.data?.usage !== undefined) {
        ;({ turn, step, usage } = event.data)
      }
      if (usage === null) {
        return nextModel === state.currentModel ? state : { ...state, currentModel: nextModel }
      }
      const model = nextModel ?? 'unknown'
      const buckets = bucketsOf(usage)
      const previous = state.last !== null && state.last.turn === turn && state.last.step === step ? state.last : null
      if (previous !== null && previous.model === model &&
        previous.buckets.uncachedInputTokens === buckets.uncachedInputTokens &&
        previous.buckets.cacheReadTokens === buckets.cacheReadTokens &&
        previous.buckets.cacheWriteTokens === buckets.cacheWriteTokens &&
        previous.buckets.outputTokens === buckets.outputTokens) {
        return nextModel === state.currentModel ? state : { ...state, currentModel: nextModel }
      }
      const isNewModel = !(model in state.byModel)
      let byModel = state.byModel
      if (previous !== null) {
        const prev = byModel[previous.model] ?? zero()
        byModel = {
          ...byModel,
          [previous.model]: {
            uncachedInputTokens: prev.uncachedInputTokens - previous.buckets.uncachedInputTokens,
            cacheReadTokens: prev.cacheReadTokens - previous.buckets.cacheReadTokens,
            cacheWriteTokens: prev.cacheWriteTokens - previous.buckets.cacheWriteTokens,
            outputTokens: prev.outputTokens - previous.buckets.outputTokens,
          },
        }
      }
      byModel = {
        ...byModel,
        [model]: {
          uncachedInputTokens: (byModel[model]?.uncachedInputTokens ?? 0) + buckets.uncachedInputTokens,
          cacheReadTokens: (byModel[model]?.cacheReadTokens ?? 0) + buckets.cacheReadTokens,
          cacheWriteTokens: (byModel[model]?.cacheWriteTokens ?? 0) + buckets.cacheWriteTokens,
          outputTokens: (byModel[model]?.outputTokens ?? 0) + buckets.outputTokens,
        },
      }
      return {
        ...state,
        currentModel: nextModel,
        last: { turn, step, model, buckets },
        byModel,
        modelOrder: isNewModel ? [...state.modelOrder, model] : state.modelOrder,
      }
    },
    view: (state) => {
      const cfg = getConfig()
      const tokens = { uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
      const costByModel = {}
      let cost = 0
      for (const model of state.modelOrder) {
        const b = state.byModel[model] ?? zero()
        tokens.uncachedInput += b.uncachedInputTokens
        tokens.cacheRead += b.cacheReadTokens
        tokens.cacheWrite += b.cacheWriteTokens
        tokens.output += b.outputTokens
        const c = costOfBuckets(b, resolveModelPrice(cfg, model))
        if (c > 0) costByModel[model] = Math.round(c * 1e6) / 1e6
        cost += c
      }
      return {
        models: state.modelOrder,
        cost: Math.round(cost * 1e6) / 1e6,
        costByModel,
        tokens,
        currency: cfg.currency,
      }
    },
    stateVersion: 1,
  }
}

/** 读取 HTTP POST JSON Body (带 1MB 大小限制与默认 10 秒超时保护)。 */
const readJsonBody = (req, timeoutMs = 10000) => new Promise((resolve, reject) => {
  let settled = false
  let body = ''
  const timer = setTimeout(() => {
    if (settled) return
    settled = true
    if (typeof req.destroy === 'function') req.destroy()
    reject(new Error('Request body timeout'))
  }, timeoutMs)
  req.on('data', (chunk) => {
    if (settled) return
    body += chunk
    if (body.length > 1e6) {
      settled = true
      clearTimeout(timer)
      if (typeof req.destroy === 'function') req.destroy()
      reject(new Error('Payload too large'))
    }
  })
  req.on('end', () => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    try {
      resolve(body ? JSON.parse(body) : {})
    } catch {
      reject(new Error('Invalid JSON'))
    }
  })
  req.on('error', (err) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    reject(err)
  })
})

export function apply(ctx, config) {
  const runtimeConfig = {
    apiKey: config.apiKey ?? '',
    apiKeyRef: config.apiKeyRef ?? 'DEEPSEEK_API_KEY',
    baseUrl: config.baseUrl ?? 'https://api.deepseek.com',
    refreshIntervalMs: config.refreshIntervalMs ?? 300000,
    timeoutMs: config.timeoutMs ?? 8000,
    currency: (config.currency ?? 'CNY').toUpperCase(),
    prices: { ...(config.prices ?? {}) },
    pricesOffPeak: { ...(config.pricesOffPeak ?? {}) },
    defaultPrices: { ...(config.defaultPrices ?? { cacheHit: 0.1, cacheMiss: 1, output: 2 }) },
    warningThreshold: config.warningThreshold ?? 10,
    dangerThreshold: config.dangerThreshold ?? 5,
    heatmapDays: config.heatmapDays ?? 365,
  }
  const getConfig = () => runtimeConfig

  const resolveKey = async () => {
    if (runtimeConfig.apiKey !== '') return runtimeConfig.apiKey
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      try {
        const hit = await credentials.resolve(runtimeConfig.apiKeyRef)
        if (hit !== undefined) return hit.value
      } catch { /* 解析失败视为未配置 */ }
    }
    return process.env[runtimeConfig.apiKeyRef] ?? ''
  }

  // ── 余额服务 ──────────────────────────────────────────────────────────────
  let cache = { state: 'empty', payload: null, error: null, fetchedAt: 0 }
  let inflight = null
  let consecutiveFailures = 0

  const refresh = () => {
    if (inflight !== null) return inflight
    inflight = (async () => {
      const key = await resolveKey()
      if (key === '') {
        cache = { state: 'error', payload: null, error: 'api-key-missing', fetchedAt: 0 }
        consecutiveFailures++
        return
      }
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), runtimeConfig.timeoutMs)
      try {
        const res = await fetch(`${runtimeConfig.baseUrl.replace(/\/+$/, '')}/user/balance`, {
          headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
          signal: controller.signal,
        })
        if (!res.ok) throw new Error(`DeepSeek API HTTP ${res.status}`)
        const data = await res.json()
        cache = {
          state: 'ok',
          payload: { isAvailable: data?.is_available === true, balances: normalizeBalances(data) },
          error: null,
          fetchedAt: Date.now(),
        }
        consecutiveFailures = 0
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        consecutiveFailures++
        if (consecutiveFailures === 1) ctx.logger?.warn?.(`[dsh-heatmap-cost] balance fetch failed: ${message}`)
        cache = {
          state: cache.state === 'ok' ? 'ok' : 'error',
          payload: cache.payload,
          error: message,
          fetchedAt: cache.fetchedAt,
        }
      } finally {
        clearTimeout(timer)
      }
    })().finally(() => { inflight = null })
    return inflight
  }

  let loopTimer = null
  const resetLoop = () => {
    if (loopTimer !== null) { clearTimeout(loopTimer); loopTimer = null }
    const run = () => {
      void refresh().then(() => {
        const missingKey = cache.state === 'error' && cache.error === 'api-key-missing'
        loopTimer = setTimeout(run, missingKey ? 5000 : runtimeConfig.refreshIntervalMs)
      })
    }
    loopTimer = setTimeout(run, 1000)
  }

  ctx.effect(() => {
    resetLoop()
    return () => { if (loopTimer !== null) clearTimeout(loopTimer) }
  }, 'dsh-heatmap-cost: refresh loop')

  // ── 热力图聚合(带失效缓存) ───────────────────────────────────────────────
  let heatmapCache = { key: '', result: null, at: 0 }

  const buildHeatmap = (sessionsStore) => {
    const days = new Map()
    let totalTokens = 0
    let totalCost = 0
    const modelCosts = new Map()
    let requestCount = 0

    for (const session of sessionsStore.list()) {
      let events
      try { events = session.events ?? [] } catch { continue }
      const byStep = foldUsageEvents(events)
      for (const { model, buckets, time } of byStep.values()) {
        const key = dayKey(time)
        let bucket = days.get(key)
        if (bucket === undefined) {
          bucket = { date: key, tokens: 0, cost: 0, requests: 0, modelCosts: {} }
          days.set(key, bucket)
        }
        const cost = costOfBuckets(buckets, resolveModelPrice(getConfig(), model, time))
        const tokens = buckets.uncachedInputTokens + buckets.cacheReadTokens + buckets.cacheWriteTokens + buckets.outputTokens
        bucket.tokens += tokens
        bucket.cost += cost
        bucket.requests += 1
        bucket.modelCosts[model] = (bucket.modelCosts[model] ?? 0) + cost
        totalTokens += tokens
        totalCost += cost
        requestCount += 1
        modelCosts.set(model, (modelCosts.get(model) ?? 0) + cost)
      }
    }

    return {
      days: [...days.values()].map((d) => ({
        ...d,
        modelCosts: Object.entries(d.modelCosts).map(([model, cost]) => ({ model, cost })).sort((a, b) => b.cost - a.cost),
      })).sort((a, b) => (a.date < b.date ? -1 : 1)),
      totalTokens,
      totalCost,
      requestCount,
      modelCosts: [...modelCosts.entries()].map(([model, cost]) => ({ model, cost })).sort((a, b) => b.cost - a.cost),
    }
  }

  const getHeatmap = (sessionsStore) => {
    // 缓存键: 会话数 + 事件总数 + 最后事件时间, 60 秒 TTL。
    let events = 0
    let lastTime = 0
    let sessions = 0
    try {
      const list = sessionsStore.list()
      sessions = list.length
      for (const s of list) {
        const evs = s.events ?? []
        events += evs.length
        const t = evs[evs.length - 1]?.time ?? 0
        if (t > lastTime) lastTime = t
      }
    } catch { /* 读取失败则走缓存 */ }
    const key = `${sessions}:${events}:${lastTime}`
    const now = Date.now()
    if (heatmapCache.key === key && heatmapCache.result !== null && now - heatmapCache.at < 60000) {
      return heatmapCache.result
    }
    const result = buildHeatmap(sessionsStore)
    heatmapCache = { key, result, at: now }
    return result
  }

  // ── 会话消耗投影 ─────────────────────────────────────────────────────────
  ctx.inject(['sessionProjections'], (projectionCtx) => {
    projectionCtx.sessionProjections.register(makeSessionCostProjection(getConfig))
  })

  // ── webServer 路由 ────────────────────────────────────────────────────────
  ctx.inject(['webServer'], (webCtx) => {
    const sendJson = (res, statusCode, data) => {
      const body = JSON.stringify(data)
      res.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Length': Buffer.byteLength(body),
      })
      res.end(body)
    }

    const serializeBalance = () => {
      const base = {
        ok: cache.state === 'ok',
        fetchedAt: cache.fetchedAt,
        currency: runtimeConfig.currency,
        thresholds: {
          warning: runtimeConfig.warningThreshold,
          danger: runtimeConfig.dangerThreshold,
        },
        refreshIntervalMs: runtimeConfig.refreshIntervalMs,
      }
      if (cache.state === 'ok') {
        return {
          ...base,
          isAvailable: cache.payload.isAvailable,
          balances: cache.payload.balances,
          ...(cache.error !== null ? { error: cache.error, stale: true } : {}),
        }
      }
      return { ...base, error: cache.error ?? 'unknown' }
    }

    const serializeHeatmap = (sessionsStore) => {
      const heat = getHeatmap(sessionsStore)
      const days = heat.days
      const byDate = new Map(days.map((d) => [d.date, d]))
      const now = Date.now()
      const rangeStart = new Date(now)
      rangeStart.setDate(rangeStart.getDate() - (runtimeConfig.heatmapDays - 1))
      rangeStart.setHours(0, 0, 0, 0)

      const series = []
      for (let i = 0; i < runtimeConfig.heatmapDays; i++) {
        const d = new Date(rangeStart.getTime() + i * 86400000)
        const key = dayKey(d.getTime())
        const hit = byDate.get(key)
        series.push(hit ?? { date: key, tokens: 0, cost: 0, requests: 0, modelCosts: [] })
      }

      const sumDays = (n) => {
        const slice = series.slice(Math.max(0, series.length - n))
        return {
          tokens: slice.reduce((a, b) => a + b.tokens, 0),
          cost: Math.round(slice.reduce((a, b) => a + b.cost, 0) * 1e6) / 1e6,
          requests: slice.reduce((a, b) => a + b.requests, 0),
        }
      }

      const maxCost = Math.max(0.000001, ...series.map((d) => d.cost))
      return {
        series,
        summary: {
          today: series[series.length - 1],
          last7: sumDays(7),
          last30: sumDays(30),
          last365: sumDays(365),
          total: {
            tokens: heat.totalTokens,
            cost: Math.round(heat.totalCost * 1e6) / 1e6,
            requests: heat.requestCount,
          },
        },
        maxCost,
        modelCosts: heat.modelCosts,
        currency: runtimeConfig.currency,
        heatmapDays: runtimeConfig.heatmapDays,
      }
    }

    // 主路由: 余额 + 当前会话投影 + 热力图
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: '/cost-heatmap',
      async handler(req, res) {
        if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'POST') {
          res.writeHead(405, { Allow: 'GET, HEAD, POST' })
          res.end()
          return
        }
        const parsedUrl = new URL(req.url ?? '/', 'http://127.0.0.1')
        const force = parsedUrl.searchParams.get('force') === '1' || parsedUrl.searchParams.get('force') === 'true' || req.method === 'POST'
        if (force) {
          const now = Date.now()
          if (now - cache.fetchedAt > 2000 || cache.state !== 'ok') await refresh()
        }
        if (req.method === 'HEAD') {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
          res.end()
          return
        }
        const sessionsStore = ctx.get('sessions')
        const projection = ctx.get('sessionProjections')
        let sessionCost = null
        if (projection !== undefined) {
          try {
            const list = sessionsStore?.list?.() ?? []
            const active = list.find((s) => s.id !== undefined && s.header?.id !== undefined) ?? list[list.length - 1]
            if (active !== undefined) {
              const snap = projection.snapshot(active)
              const value = snap?.values?.heatmapSessionCost
              if (value !== undefined) sessionCost = value
            }
          } catch { /* 投影读取失败不阻塞主响应 */ }
        }
        sendJson(res, 200, {
          ok: true,
          balance: serializeBalance(),
          sessionCost,
          heatmap: sessionsStore !== undefined ? serializeHeatmap(sessionsStore) : null,
          prices: {
            'deepseek-v4-flash': resolveModelPrice(getConfig(), 'deepseek-v4-flash'),
            'deepseek-v4-pro': resolveModelPrice(getConfig(), 'deepseek-v4-pro'),
          },
        })
      },
    }), 'dsh-heatmap-cost: main route')

    // 配置读写路由
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: '/cost-heatmap/config',
      async handler(req, res) {
        if (req.method === 'GET') {
          sendJson(res, 200, {
            ok: true,
            config: {
              currency: runtimeConfig.currency,
              warningThreshold: runtimeConfig.warningThreshold,
              dangerThreshold: runtimeConfig.dangerThreshold,
              refreshIntervalMs: runtimeConfig.refreshIntervalMs,
              heatmapDays: runtimeConfig.heatmapDays,
              baseUrl: runtimeConfig.baseUrl,
              hasCustomKey: Boolean(runtimeConfig.apiKey),
            },
          })
          return
        }
        if (req.method === 'POST') {
          try {
            const body = await readJsonBody(req)
            if (typeof body.currency === 'string' && body.currency.trim()) runtimeConfig.currency = body.currency.trim().toUpperCase()
            if (typeof body.warningThreshold === 'number' && body.warningThreshold >= 0) runtimeConfig.warningThreshold = body.warningThreshold
            if (typeof body.dangerThreshold === 'number' && body.dangerThreshold >= 0) runtimeConfig.dangerThreshold = body.dangerThreshold
            if (typeof body.refreshIntervalMs === 'number' && body.refreshIntervalMs >= 1000) runtimeConfig.refreshIntervalMs = body.refreshIntervalMs
            if (typeof body.heatmapDays === 'number' && body.heatmapDays >= 7 && body.heatmapDays <= 400) runtimeConfig.heatmapDays = Math.floor(body.heatmapDays)
            if (typeof body.apiKey === 'string' && body.apiKey.trim() !== '') runtimeConfig.apiKey = body.apiKey.trim()
            resetLoop()
            await refresh()
            sendJson(res, 200, { ok: true, message: 'Config updated' })
          } catch (err) {
            sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) })
          }
          return
        }
        res.writeHead(405, { Allow: 'GET, POST' })
        res.end()
      },
    }), 'dsh-heatmap-cost: config route')
  })
}
