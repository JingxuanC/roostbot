// 控制面写接口限流（M6-6.6）：每个 server 实例独立的内存令牌桶。
//
// 桶容量 = 窗口内允许的突发请求数；按时间匀速回填。账号维度计数，不跨实例共享。
// 配对码限流沿用 server.ts 里已有的全局失败窗口，不在本模块里。

export const RATE_LIMITS = {
  messages: { capacity: 30, windowMs: 60_000 },
  pluginInstall: { capacity: 10, windowMs: 3_600_000 }
} as const

export type RateLimitKind = keyof typeof RATE_LIMITS

interface Bucket {
  tokens: number
  updatedAt: number
}

export interface RateLimiter {
  /** 返回 null = 放行；否则是建议的 Retry-After 秒数（至少 1）。 */
  consume(kind: RateLimitKind, accountId: string, now: number): number | null
}

export class TokenBucketLimiter implements RateLimiter {
  private buckets = new Map<string, Bucket>()

  consume(kind: RateLimitKind, accountId: string, now: number): number | null {
    const rule = RATE_LIMITS[kind]
    const key = `${kind}\0${accountId}`
    const current = this.buckets.get(key)
    const bucket: Bucket =
      current === undefined
        ? { tokens: rule.capacity, updatedAt: now }
        : {
            tokens: Math.min(
              rule.capacity,
              current.tokens + Math.max(0, now - current.updatedAt) * (rule.capacity / rule.windowMs)
            ),
            updatedAt: now
          }

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1
      this.buckets.set(key, bucket)
      return null
    }

    this.buckets.set(key, bucket)
    const milliseconds = Math.ceil(((1 - bucket.tokens) * rule.windowMs) / rule.capacity)
    return Math.max(1, Math.ceil(milliseconds / 1000))
  }
}
