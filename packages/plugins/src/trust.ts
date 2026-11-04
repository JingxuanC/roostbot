// 插件信任判定：integrity / 白名单 / 发布时长 / 签名状态（纯函数，零依赖）。
//
// 事实源：docs/design/plugin-marketplace.md §8（供应链：pnpm lock + integrity +
//         minimumReleaseAge + 禁运行时 postinstall）、docs/build/wave1.md §B。
//
// 三条纪律：
//   * 白名单是**默认拒绝**：ROOST_PLUGIN_ALLOWLIST 为空 = 一个都不许装，不是「全放行」。
//     空字符串在配置里太容易误读成「不限制」，所以这里把它读成「没有可装的插件」。
//   * integrity 只认 sha512：期望值来自市场版本元数据，实际值来自 registry 返回的
//     `sha512-<base64>`（或直接给内容字节由我们算）。
//   * 签名缺失不是阻断：sigstore / npm provenance 都缺失时只提示（白名单内的插件仍可装），
//     真正的阻断在白名单与 integrity。签名是「更好」，白名单是「必须」。

import { createHash, timingSafeEqual } from 'node:crypto'

/** 签名来源：sigstore（我们私有 registry 的签名）/ npm provenance / 没有。 */
export type SignatureState = 'sigstore' | 'npm-provenance' | 'none'

const SHA512_INTEGRITY = /^sha512-([A-Za-z0-9+/]+={0,2})$/

/** 一条 integrity 里的 base64 部分；不是 sha512 形状返回 null。 */
function decodeIntegrity(value: string): Buffer | null {
  const match = SHA512_INTEGRITY.exec(value.trim())
  if (match === null) return null
  try {
    return Buffer.from(match[1]!, 'base64')
  } catch {
    return null
  }
}

/** 内容 → `sha512-<base64>`（npm integrity 的形状）。 */
export function sha512Integrity(content: string | Uint8Array): string {
  const hash = createHash('sha512')
  hash.update(typeof content === 'string' ? Buffer.from(content, 'utf8') : content)
  return `sha512-${hash.digest('base64')}`
}

/**
 * 校验 sha512 integrity。
 *
 * `actual` 两种写法都接受：
 *   * `sha512-<base64>`：registry 给的另一份 integrity，逐字节比较；
 *   * 其它字符串 / 字节：当作内容，自己算 sha512。
 * 长度不同直接 false（timingSafeEqual 要求等长）；缺值一律 false。
 */
export function verifyIntegrity(
  expected: string | null | undefined,
  actual: string | Uint8Array | null | undefined,
): boolean {
  if (typeof expected !== 'string') return false
  const expectedBytes = decodeIntegrity(expected)
  if (expectedBytes === null) return false
  if (actual === null || actual === undefined) return false

  let actualBytes: Buffer | null
  if (typeof actual === 'string' && SHA512_INTEGRITY.test(actual.trim())) {
    actualBytes = decodeIntegrity(actual)
  } else {
    actualBytes = Buffer.from(sha512Integrity(actual).slice('sha512-'.length), 'base64')
  }
  if (actualBytes === null || actualBytes.length !== expectedBytes.length) return false
  return timingSafeEqual(expectedBytes, actualBytes)
}

/**
 * 解析白名单：`ROOST_PLUGIN_ALLOWLIST` 逗号分隔；`*` 是显式放行全部。
 * 大小写不敏感（npm 包名本来就小写），去空白、去空项、保序去重。
 */
export function parseAllowlist(raw: string | readonly string[] | null | undefined): string[] {
  if (raw === null || raw === undefined) return []
  const parts = typeof raw === 'string' ? raw.split(',') : Array.from(raw)
  const out: string[] = []
  for (const part of parts) {
    if (typeof part !== 'string') continue
    const value = part.trim().toLowerCase()
    if (value === '' || out.includes(value)) continue
    out.push(value)
  }
  return out
}

export interface AllowlistInput {
  slug: string
  /** 市场发布者 id；白名单里也可以直接写发布者 id（允许整个发布者）。 */
  publisherId?: string | null
  allowlist: string | readonly string[] | null | undefined
}

/** 插件是否在白名单里；空白名单 = 拒绝（默认拒绝）。 */
export function isAllowlisted(input: AllowlistInput): boolean {
  const entries = parseAllowlist(input.allowlist)
  if (entries.length === 0) return false
  if (entries.includes('*')) return true
  if (typeof input.slug !== 'string') return false
  const slug = input.slug.trim().toLowerCase()
  if (slug === '') return false
  if (entries.includes(slug)) return true
  if (typeof input.publisherId === 'string') {
    const publisher = input.publisherId.trim().toLowerCase()
    if (publisher !== '' && entries.includes(publisher)) return true
  }
  return false
}

export interface ReleaseAgeResult {
  ok: boolean
  /** now - publishedAt（毫秒）；publishedAt 不可读时为 null。 */
  ageMs: number | null
  reason: string | null
}

/**
 * 发布时长门槛（供应链冷却期，对应 pnpm 的 minimumReleaseAge）。
 * minAgeMs <= 0 = 不设门槛；发布时间读不出来时按「不满足」处理（宁可不装）。
 */
export function checkReleaseAge(
  publishedAt: number | null | undefined,
  minAgeMs: number,
  now: number,
): ReleaseAgeResult {
  const minimum = Number.isFinite(minAgeMs) && minAgeMs > 0 ? minAgeMs : 0
  const readable =
    typeof publishedAt === 'number' && Number.isFinite(publishedAt) && publishedAt > 0
      ? publishedAt
      : null
  if (minimum === 0) {
    return {
      ok: true,
      ageMs: readable === null ? null : Math.max(0, now - readable),
      reason: null,
    }
  }
  if (readable === null) {
    return { ok: false, ageMs: null, reason: 'publishedAt is missing; cannot enforce the minimum release age' }
  }
  const ageMs = now - readable
  if (ageMs < minimum) {
    return {
      ok: false,
      ageMs,
      reason: `published ${ageMs}ms ago, minimum release age is ${minimum}ms`,
    }
  }
  return { ok: true, ageMs, reason: null }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmpty(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false
  if (typeof value === 'string') return value.trim() !== ''
  if (Array.isArray(value)) return value.length > 0
  if (isPlainRecord(value)) return Object.keys(value).length > 0
  return true
}

/**
 * 签名状态（docs/design/plugin-marketplace.md §8 的供应链一层）。
 *
 * versionMeta 是版本元数据对象，兼容几种写法：
 *   { sigstore: true } / { sigstore: 'roost' }
 *   { provenance: {...} } / dist.attestations / attestations
 *   { signatures: [...] }（npm registry 的签名数组）
 * 只有明确有 sigstore 才算 sigstore；有 provenance/attestations/signatures 算 npm-provenance。
 */
export function signatureState(versionMeta: unknown): SignatureState {
  if (!isPlainRecord(versionMeta)) return 'none'
  const meta = versionMeta
  const dist = isPlainRecord(meta['dist']) ? meta['dist'] : null

  const sigstore =
    meta['sigstore'] ?? meta['sigstoreBundle'] ?? (dist === null ? undefined : dist['sigstore'])
  if (typeof sigstore === 'string' && sigstore.trim() !== '') return 'sigstore'
  // sigstoreBundle 是对象（bundle JSON）；true 是简写。
  if (sigstore === true || isPlainRecord(sigstore)) return 'sigstore'

  for (const key of ['provenance', 'attestations', 'signatures', 'npmProvenance']) {
    if (nonEmpty(meta[key])) return 'npm-provenance'
  }
  if (dist !== null) {
    for (const key of ['attestations', 'signatures']) {
      if (nonEmpty(dist[key])) return 'npm-provenance'
    }
  }
  return 'none'
}
