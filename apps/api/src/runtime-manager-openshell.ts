// RuntimeManager 的默认实现：把 start 交给 apps/runtime/planA-boot 背后的同一套逻辑。
//
// 沙箱镜像、策略、provider 都由环境给出；这里只负责把工作区映射到固定沙箱名，
// 并在成功后回报阶段。机器上没有 OpenShell（本地开发）时抛 runtime.not_configured。
//
// 启动前先拉 profile 锁（TODO 4.3.4；plugin-marketplace.md §4 ④⑤）：锁拉不到
// 就抛错，不假装沙箱起来了。锁经 sync 接口的 loopback 自调拉取（与沙箱将来走的
// 是同一条路由、同一套 runtime token 鉴权）；不用 cpHost——那是给沙箱解析宿主机
// 用的，控制面自己未必能解析。锁 id 注入沙箱 env，沙箱 sync 后必须落在同一把锁上。
// 旧 planA-boot 已删除（E5）；本模块是控制面唯一的启动路径。
//
// TODO E6：每 workspace 短期 token。
//   * 有 rawStore（或注入的 tokenIssuer）时，ensure 先签发一个 24h token，再用它
//     拉锁、并写进沙箱 env 的 ROOST_RUNTIME_TOKEN。退出时把 tokenId 交给调用方，
//     stop/失败可以 revokeRuntimeToken。
//   * 没有 rawStore（内存 port / 旧部署）时退回 config.runtimeToken（全局 env），
//     行为与 E6 之前完全一致。

import { issueRuntimeToken, revokeRuntimeToken } from '../../../packages/store/src/runtime-tokens.ts'
import type { IssuedRuntimeToken } from '../../../packages/store/src/runtime-tokens.ts'
import type { Store } from '../../../packages/store/src/types.ts'
import { fetchProfileLock } from './profile-lock.ts'
import type { RuntimeEnsureResult, RuntimeManager } from './workspace-runtime.ts'

/** 短 token 有效期：跟沙箱的典型生命周期一致；每次 start 重新签发。 */
export const RUNTIME_TOKEN_TTL_MS = 24 * 60 * 60 * 1000

/** ensureSandbox 的第三个参数：测试/自定义后端据此把 token 写进沙箱环境。 */
export interface SandboxStartContext {
  workspaceId: string
  runtimeToken: string
  env: Record<string, string>
}

export interface SandboxStartResult {
  sandbox: string
  phase: 'ready' | 'stopped' | 'error' | 'unknown'
  /** false = 复用了已存在的沙箱（env 不会被重写）。省略按 true 处理。 */
  created?: boolean
}

export interface OpenShellRuntimeConfig {
  image: string
  cpHost: string
  cpPort: number
  /** 旧部署兼容：全局 runtime token；没有 rawStore/issuer 时直接注入沙箱 env。 */
  runtimeToken: string
  /** 控制面 SQLite store；有它才签发每 workspace token。 */
  rawStore?: Store
  /** 测试注入：替代 issueRuntimeToken（例如固定 token 或验证调用次数）。 */
  tokenIssuer?: (workspaceId: string) => IssuedRuntimeToken
  /** token 有效期；默认 24h。 */
  tokenTtlMs?: number
  /** 注入时钟（签发的 issued_at / expires_at）。 */
  now?: () => number
  botId?: string
  log?: (line: string) => void
  /** 测试注入：替代全局 fetch。 */
  fetchImpl?: typeof fetch
  /** 测试注入：替代 sandbox-manager 的创建逻辑；入参带上已拉到的锁 id 与要注入的 env。 */
  ensureSandbox?: (
    workspaceId: string,
    lockId: string,
    context: SandboxStartContext,
  ) => Promise<SandboxStartResult>
}

interface ResolvedToken {
  token: string
  /** 只有本进程签发（或注入 issuer 提供）的 token 才有 id，用于失败/复用回收。 */
  id?: string
}

export function openShellRuntimeManager(config: OpenShellRuntimeConfig): RuntimeManager {
  function resolveStore(context?: { store?: Store }): Store | undefined {
    return context?.store ?? config.rawStore
  }

  function issueFor(store: Store | undefined, workspaceId: string): ResolvedToken {
    if (config.tokenIssuer !== undefined) {
      const issued = config.tokenIssuer(workspaceId)
      return { token: issued.token, id: issued.id }
    }
    if (store !== undefined) {
      const issued = issueRuntimeToken(store, {
        workspaceId,
        ttlMs: config.tokenTtlMs ?? RUNTIME_TOKEN_TTL_MS,
        ...(config.now === undefined ? {} : { at: config.now() }),
      })
      return { token: issued.token, id: issued.id }
    }
    // 旧部署兼容：没有 store 就没有签发，继续用全局 env token。
    return { token: config.runtimeToken }
  }

  function revoke(store: Store | undefined, token: ResolvedToken): void {
    if (token.id === undefined || store === undefined) return
    try {
      revokeRuntimeToken(store, { id: token.id })
    } catch {
      // 回收失败不能盖住原始错误；token 24h 后自然过期。
    }
  }

  return {
    async ensure(workspaceId, context) {
      const store = resolveStore(context)
      const token = issueFor(store, workspaceId)
      const env: Record<string, string> = {
        ROOST_API: `http://${config.cpHost}:${config.cpPort}`,
        ROOST_RUNTIME_TOKEN: token.token,
        ROOST_BOT_ID: config.botId ?? 'selector',
        ROOST_WORKSPACE_ID: workspaceId,
        ROOST_STATE_FILE: '/workspace/.dsh/room-cursors.json',
        ROOST_DSH_PROVIDER: 'deepseek-official',
        ROOST_DSH_MODEL: 'deepseek-chat',
        // 沙箱内的边界是 OpenShell，不是 DSH 自带的 sandbox：
        // 不设这个的话 fresh session 会 pin 到 workspace-write + ask，每条 bash 都要人批。
        DSH_PERMISSION_MODE: 'danger-full-access',
        ROOST_WORKDIR: '/workspace',
      }

      try {
        // 用刚签发的 token 拉锁：同时验证它确实能通过控制面校验。
        const lock = await fetchProfileLock({
          apiBase: `http://127.0.0.1:${config.cpPort}`,
          runtimeToken: token.token,
          workspaceId,
          ...(config.fetchImpl === undefined ? {} : { fetchImpl: config.fetchImpl }),
        })
        config.log?.(`profile lock ${lock.id}`)
        env.ROOST_PROFILE_LOCK_ID = lock.id

        let result: SandboxStartResult
        if (config.ensureSandbox !== undefined) {
          result = await config.ensureSandbox(workspaceId, lock.id, {
            workspaceId,
            runtimeToken: token.token,
            env,
          })
          // 注入的 fake 默认按「新建」处理：env 已经被它收下，token 继续有效。
          if (result.created === undefined) result = { ...result, created: true }
        } else {
          const { sandboxNameFor, ensureUserSandbox, userSandboxPolicy } = await import('../../runtime/sandbox-manager.mjs')
          const name = sandboxNameFor(workspaceId)
          const ensured = await ensureUserSandbox({
            workspaceId,
            name,
            image: config.image,
            policyYaml: userSandboxPolicy({ host: config.cpHost, port: config.cpPort }),
            providers: ['deepseek'],
            env,
            log: config.log ?? (() => {}),
          })
          result = { sandbox: ensured.handle.name, phase: 'ready', created: ensured.created }
        }

        // 复用既有沙箱时不会重写 env：本次签发的新 token 没人持有，立刻回收，
        // 避免留下「明文丢失但仍有效」的凭据。旧沙箱继续用上次注入的 token。
        if (result.created === false) {
          revoke(store, token)
          token.id = undefined
        }

        const out: RuntimeEnsureResult = { sandbox: result.sandbox, phase: result.phase }
        if (token.id !== undefined) out.tokenId = token.id
        return out
      } catch (error) {
        // 锁拉不到 / 沙箱创建失败：这张 token 还没进任何沙箱，直接吊销。
        revoke(store, token)
        throw error
      }
    },

    async status(workspaceId) {
      const { sandboxNameFor } = await import('../../runtime/sandbox-manager.mjs')
      // 没有 OpenShell CLI 时返回 null，让 API 退回库里记录的状态。
      try {
        const { OpenShellBackend } = await import('../../../packages/sandbox/src/index.ts')
        const backend = new OpenShellBackend()
        if (await backend.available().catch(() => false) !== true) return null
        const list = await backend.list?.()
        const name = sandboxNameFor(workspaceId)
        const entry = Array.isArray(list) ? list.find((item) => item.name === name) : undefined
        if (entry === undefined) return null
        const phase = String(entry.phase ?? '').toLowerCase()
        return { sandbox: name, phase: phase === 'ready' ? 'ready' : phase === 'stopped' ? 'stopped' : phase === 'error' ? 'error' : 'unknown' }
      } catch {
        return null
      }
    },
  }
}
