// 日志脱敏与保留策略（M6-6.6 / events.md §8）。
//
// redactLine 面向“一行日志/一个 KV 串”，不是 JSON 解析器：日志可能来自任意进程、
// 也可能被截断，所以按 key 前缀识别敏感字段，保留 key 本身（排查时要知道是哪个
// 字段被抹掉），只替换值。支持的形态：
//   token=abc            api_key: sk-xxx        "client_secret": "..."
//   Authorization: Bearer xxx                   cookie: a=b; c=d
//   https://x/y?access_token=abc&keep=1         password=hunter2
//
// retentionPlan 只做纯计算：先按年龄删除过期文件，再按总大小从最旧开始删到上限。
// 返回 path 列表，不做文件系统操作。

export const REDACTED = '[REDACTED]'

const MAX_KEY_CHARS = 80

/** 被识别为敏感字段的单词（按 -/_/. 与 camelCase 切段后逐段比较）。 */
const SENSITIVE_SEGMENTS = new Set([
  'token',
  'tokens',
  'key',
  'secret',
  'secrets',
  'cookie',
  'cookies',
  'password',
  'passwd',
  'pwd',
  'authorization',
  'bearer',
  'auth',
  'session',
  'sessionid',
  'credential',
  'credentials',
  'signature'
])

/** monkey / hockey 这类普通单词不能被拆出 key。 */
function isSensitiveKey(rawKey: string): boolean {
  const key = rawKey.trim()
  if (key === '' || key.length > MAX_KEY_CHARS) return false
  const snake = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
  const segments = snake.split(/[^a-z0-9]+/).filter((segment) => segment !== '')
  return segments.some((segment) => SENSITIVE_SEGMENTS.has(segment))
}

/** Header 值：方案（Bearer/Basic）本身没有信息量，只保留引号形态。 */
function maskHeaderValue(rawValue: string): string {
  const first = rawValue[0]
  if ((first === '"' || first === "'") && rawValue.length >= 2 && rawValue.endsWith(first)) {
    return `${first}${REDACTED}${first}`
  }
  return REDACTED
}

/** 保留值的引号/方案前缀，让脱敏后的行仍然可读、JSON 仍然合法。 */
function maskValue(rawValue: string): string {
  const first = rawValue[0]
  if ((first === '"' || first === "'") && rawValue.length >= 2 && rawValue.endsWith(first)) {
    return `${first}${REDACTED}${first}`
  }
  const scheme = /^(Bearer|Basic|Token)\s+/i.exec(rawValue)
  if (scheme !== null) return `${scheme[1]} ${REDACTED}`
  return REDACTED
}

// Authorization 头：值可能是 "Bearer <token>"，允许 key 带引号。
const AUTH_HEADER =
  /((["']?)(?:proxy-)?authorization\2\s*[:=]\s*)("[^"\n]*"|'[^'\n]*'|(?:Bearer|Basic|Token)\s+[^\s,;&]+|[^\s,;&]+)/gi

// Cookie 头通常有多段 a=b; c=d，整段抹掉；JSON 里的引号值只抹到引号为止。
const COOKIE_HEADER = /((["']?)(?:set-)?cookie\2\s*[:=]\s*)("[^"\n]*"|'[^'\n]*'|[^\n]+)/gi

// 裸露的 Bearer/Basic 凭据（没有 key 前缀时也要抹）。
const BARE_BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/=-]+/gi

// 通用 key=value / key: value；key 允许引号，value 允许引号或裸值。
const KEY_VALUE =
  /(^|[\s,;{[(?&])(["']?)([A-Za-z0-9_.@-]{1,80})\2(\s*[:=]\s*)("[^"\n]*"|'[^'\n]*'|\[REDACTED\]|[^\s,;&}\]\)]+)/g

/**
 * 一行文本里的凭据值脱敏。幂等：对已脱敏的行再跑一次结果不变。
 * 不是完整的安全边界 —— 只覆盖已知的 key 形态，不猜自由文本里的秘密。
 */
export function redactLine(line: string): string {
  if (typeof line !== 'string' || line === '') return line

  let output = line.replace(COOKIE_HEADER, (_match, prefix: string, _quote: string, value: string) => {
    return `${prefix}${maskValue(value)}`
  })

  output = output.replace(AUTH_HEADER, (_match, prefix: string, _quote: string, value: string) => {
    return `${prefix}${maskHeaderValue(value)}`
  })

  output = output.replace(BARE_BEARER, (_match, scheme: string) => `${scheme} ${REDACTED}`)

  output = output.replace(
    KEY_VALUE,
    (match, lead: string, quote: string, key: string, separator: string, value: string) => {
      if (!isSensitiveKey(key)) return match
      return `${lead}${quote}${key}${quote}${separator}${maskValue(value)}`
    }
  )

  return output
}

export interface RetentionFile {
  path: string
  /** 字节数；非法值按 0 处理。 */
  size: number
  /** 最后修改时间（epoch 毫秒）。 */
  mtime: number
}

export interface RetentionOptions {
  files: readonly RetentionFile[]
  /** 当前时刻：epoch 毫秒或 Date。 */
  now: number | Date
  /** 超过这个年龄删除；<=0 表示“立刻过期”，非有限值表示不按年龄清理。 */
  maxAgeMs: number
  /** 清理后总大小上限；非有限值表示不按大小清理。 */
  maxBytes: number
}

export interface RetentionPlan {
  /** 保留文件，按输入顺序。 */
  keep: string[]
  /** 待删除文件：先过期（最旧优先），再因超总量被淘汰（最旧优先）。 */
  delete: string[]
}

function nowMs(now: number | Date): number {
  if (now instanceof Date) {
    const value = now.getTime()
    return Number.isFinite(value) ? value : Date.now()
  }
  return typeof now === 'number' && Number.isFinite(now) ? now : Date.now()
}

function sizeOf(file: RetentionFile): number {
  return typeof file.size === 'number' && Number.isFinite(file.size) && file.size > 0 ? file.size : 0
}

function oldestFirst(a: RetentionFile, b: RetentionFile): number {
  return a.mtime - b.mtime || a.path.localeCompare(b.path)
}

/**
 * 保留计划：
 *   1. age > maxAgeMs 的文件先删（无论总量）；
 *   2. 剩余文件按总量判断，超 maxBytes 时从最旧开始删，直到 <= maxBytes。
 * 年龄边界与大小边界都取“不超过即保留”。
 */
export function retentionPlan(options: RetentionOptions): RetentionPlan {
  const at = nowMs(options.now)
  const maxAgeMs = options.maxAgeMs
  const maxBytes = options.maxBytes
  const expired: RetentionFile[] = []
  const remaining: RetentionFile[] = []

  for (const file of options.files) {
    const age = at - file.mtime
    const isExpired = Number.isFinite(maxAgeMs) && maxAgeMs >= 0 && age > maxAgeMs
    if (isExpired) expired.push(file)
    else remaining.push(file)
  }

  expired.sort(oldestFirst)

  let total = remaining.reduce((sum, file) => sum + sizeOf(file), 0)
  const evicted: RetentionFile[] = []
  if (Number.isFinite(maxBytes) && maxBytes >= 0) {
    for (const file of [...remaining].sort(oldestFirst)) {
      if (total <= maxBytes) break
      const size = sizeOf(file)
      // 删 0 字节文件不会让总量下降，跳过它去找真正占空间的文件。
      if (size === 0) continue
      total -= size
      evicted.push(file)
    }
  }

  const deleted = new Set<RetentionFile>([...expired, ...evicted])
  return {
    keep: options.files.filter((file) => !deleted.has(file)).map((file) => file.path),
    delete: [...expired, ...evicted].map((file) => file.path)
  }
}
