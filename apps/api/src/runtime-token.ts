// 内部接口（runtime worker 用）的统一鉴权：控制面全局 token + 每 workspace 短期 token。
//
// 事实源：docs/build/wave3.md §B、docs/decisions/0005-runtime-token.md「provider 方案」。
//
// 现状：10 个 `*-routes.ts` / server.ts 各自复制了 `runtimeTokenFrom()` + 字符串比较，
// 返回 boolean，也没有 workspaceId。这个模块把判定收敛成一个纯函数，返回值带
// `workspaceId`，让路由能按 workspace 过滤（ADR 0005 的验收标准：两个 workspace 的
// token 互换后必须被拒绝）。
//
// 判定顺序（与 wave3 §B 一致）：
//   1. 没有 x-runtime-token / Authorization: Runtime <t>，或为空 → unauthorized
//   2. 等于控制面全局 token（非空）→ ok，workspaceId=null（旧部署兼容 / 管理员凭据）
//   3. 命中 runtime_tokens（未吊销、未过期）→ ok，workspaceId=<该 token 的 workspace>
//   4. 其余 → unauthorized
//
// 为什么用普通字符串比较，而不是 timing-safe：
//   * 全局 token 是部署级 secret，比较本身走 JS 字符串 ===。理论上不是定时安全，
//     但攻击者只能通过 HTTP 往返观察时序，噪声远大于逐字节差异；ADR 0005 已把
//     全局 token 定位为「集群管理员凭据」，不是多租户边界。
//   * workspace token 的比较发生在 SQLite 的 token_hash 索引上：入参先 sha256，
//     库里只有 hash。比较的不是明文，也没有可用的长度信息；对 hash 做 timing-safe
//     比较解决不了「输入→hash」这一步，反而会误导人以为这里有密码学收益。
//   * 失败一律返回同一种 unauthorized，且不回显 token 长度、不区分「没这个 token」
//     与「token 错了」，避免枚举。
//
// 接线在 runtime-auth.ts：它负责 404（内部接口关闭）/ 401 / 403（跨 workspace），
// 各 route 模块只调用 authorizeRuntimeHttp + ensureRuntimeWorkspace（E6 已接完）。

import { verifyRuntimeToken } from '../../../packages/store/src/runtime-tokens.ts'
import type { Store } from '../../../packages/store/src/types.ts'

/** 鉴权失败只有一种对外结果（不区分原因，避免枚举）。 */
export interface RuntimeAuthDenied {
  ok: false
  code: 'unauthorized'
}

export interface RuntimeAuthGranted {
  ok: true
  /** 全局 token 是 null；workspace token 是它所属的 workspace。 */
  workspaceId: string | null
  kind: 'global' | 'workspace'
}

export type RuntimeAuthResult = RuntimeAuthGranted | RuntimeAuthDenied

/**
 * 校验端口：给定明文 token 返回它对应的 runtime_tokens 行（id + workspaceId）。
 * 未命中 / 过期 / 吊销一律 null；实现方不要抛「token 错」这类异常。
 */
export interface RuntimeTokenVerifier {
  verify(token: string, at?: number): { id: string; workspaceId: string } | null
}

export interface AuthorizeRuntimeOptions {
  /** 校验端口；省略 = 没有每 workspace token（只认全局 token）。 */
  store?: RuntimeTokenVerifier | null
  /** 控制面全局 token；空串/undefined = 未配置（旧部署兼容）。 */
  globalToken?: string | null
  /** 省略 = store 自己读 Date.now()；测试注入时钟用。 */
  now?: number
  /** 显式传入的明文 token；省略则从 `req` 的 header 读。 */
  headerToken?: string | null
}

/** 只需要 headers 的最小请求形状（node:http 的 IncomingMessage 天然满足）。 */
export interface RuntimeHeaderCarrier {
  headers?: Record<string, string | string[] | undefined>
}

function deny(): RuntimeAuthDenied {
  return { ok: false, code: 'unauthorized' }
}

function readHeader(headers: NonNullable<RuntimeHeaderCarrier['headers']>, name: string): string | null {
  const value = headers[name]
  if (typeof value === 'string') return value
  // 重复 header 在 node 里是数组；取第一个，与旧实现一致。
  if (Array.isArray(value) && value.length > 0 && typeof value[0] === 'string') return value[0]
  return null
}

/**
 * 从请求里取 runtime token：优先 `x-runtime-token`，其次
 * `Authorization: Runtime <token>`（沙箱里两种写法都在用）。没有则 null。
 */
export function runtimeTokenFromRequest(req?: RuntimeHeaderCarrier | null): string | null {
  const headers = req?.headers
  if (headers === undefined || headers === null) return null
  const direct = readHeader(headers, 'x-runtime-token')
  if (direct !== null && direct !== '') return direct
  const auth = (readHeader(headers, 'authorization') ?? '').trim()
  const match = /^Runtime[ ]+(\S+)$/.exec(auth)
  return match === null ? null : match[1]!
}

/**
 * 纯函数判定：给定 header token、全局 token 与校验端口，返回授权结果。
 *
 * `req` 只在 `headerToken` 未提供时用来读 header（两者都传时以 headerToken 为准，
 * 方便路由层复用已经解析好的值）。store.verify 抛错会向上抛：那是基础设施故障，
 * 不应该被静默降级成 401（会掩盖「库关了」这类 bug）。
 */
export function authorizeRuntimeRequest(
  options: AuthorizeRuntimeOptions,
  req?: RuntimeHeaderCarrier | null,
): RuntimeAuthResult {
  const opts: AuthorizeRuntimeOptions = options ?? {}
  const headerToken =
    opts.headerToken === undefined ? runtimeTokenFromRequest(req) : opts.headerToken
  if (typeof headerToken !== 'string' || headerToken === '') return deny()

  const globalToken = typeof opts.globalToken === 'string' ? opts.globalToken : ''
  if (globalToken !== '' && headerToken === globalToken) {
    return { ok: true, workspaceId: null, kind: 'global' }
  }

  const store = opts.store
  if (store !== undefined && store !== null && typeof store.verify === 'function') {
    const hit = store.verify(headerToken, opts.now)
    // 防守畸形端口：没有 workspaceId 的命中不授权（宁可 401，不可越过租户边界）。
    if (hit !== null && hit !== undefined && typeof hit.workspaceId === 'string' && hit.workspaceId !== '') {
      return { ok: true, workspaceId: hit.workspaceId, kind: 'workspace' }
    }
  }

  return deny()
}

/**
 * 把 store 包成校验端口：`authorizeRuntimeRequest` 只依赖 verify，不认识 Store，
 * 这样纯函数测试不需要真库；接线时用这个适配器即可。
 */
export function storeRuntimeTokenVerifier(store: Store): RuntimeTokenVerifier {
  return {
    verify(token: string, at?: number) {
      return verifyRuntimeToken(store, at === undefined ? { token } : { token, at })
    },
  }
}
