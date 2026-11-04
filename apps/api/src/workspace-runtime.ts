// 工作区运行时：start 与状态查询（TODO 4.3.1–4.3.3 / E6）。
//
// 控制面不自己碰 Docker/OpenShell：它调用一个 RuntimeManager 端口；
// 默认实现把请求交给 apps/runtime 的 sandbox-manager（同一台主机上）。
// 本地开发/测试没有运行时环境时，start 返回 runtime.not_configured，而不是假装成功。
//
// E6：ensure 会为 workspace 签发 24h runtime token，并把它注入沙箱 env；
// 这里把 rawStore 一并交给 manager，启动失败时回收已签发的 token（stop 同理，
// 调用方用 revokeWorkspaceRuntimeTokens）。

import {
  getWorkspaceRuntime,
  saveWorkspaceRuntime,
  type RuntimePhase,
  type WorkspaceRuntime,
} from '../../../packages/store/src/workspace-runtime.ts'
import { revokeRuntimeToken, revokeRuntimeTokens } from '../../../packages/store/src/runtime-tokens.ts'
import type { Store } from '../../../packages/store/src/types.ts'

/** ensure 的结果；`tokenId` 只有控制面签发了短 token 时才存在（全局 env 兼容路径没有）。 */
export interface RuntimeEnsureResult {
  sandbox: string
  phase: RuntimePhase
  tokenId?: string
}

export interface RuntimeManager {
  /** 确保这个工作区的用户沙箱存在（创建或复用 stop/start）。 */
  ensure(workspaceId: string, context?: { store?: Store }): Promise<RuntimeEnsureResult>
  /** 只看状态，不创建。 */
  status(workspaceId: string): Promise<{ sandbox: string; phase: RuntimePhase } | null>
}

export interface StartRuntimeResult {
  runtime: WorkspaceRuntime
  created: boolean
  /** 本次签发并注入沙箱的 token id；复用既有沙箱或走全局 env 兼容路径时没有。 */
  tokenId?: string
}

export async function startWorkspaceRuntime(
  store: Store,
  workspaceId: string,
  manager: RuntimeManager
): Promise<StartRuntimeResult> {
  const existing = getWorkspaceRuntime(store, workspaceId)
  let ensured: RuntimeEnsureResult
  try {
    // rawStore 透传给 manager：它需要它来签发 token（也便于测试注入）。
    ensured = await manager.ensure(workspaceId, { store })
  } catch (error) {
    // 状态失败也要落库，面板才能显示 error 而不是空白。
    if (existing !== null) saveWorkspaceRuntime(store, { workspaceId, sandbox: existing.sandbox, phase: 'error' })
    throw error
  }
  let runtime: WorkspaceRuntime
  try {
    runtime = saveWorkspaceRuntime(store, {
      workspaceId,
      sandbox: ensured.sandbox,
      phase: ensured.phase,
      ...(existing === null ? {} : { startedAt: existing.startedAt })
    })
  } catch (error) {
    // 沙箱已经起来了但状态落库失败：回收这张刚签发的 token，避免泄漏一张
    // 无人持有明文、却仍然有效的凭据。
    revokeIssuedToken(store, ensured.tokenId)
    throw error
  }
  return {
    runtime,
    created: existing === null,
    ...(ensured.tokenId === undefined ? {} : { tokenId: ensured.tokenId }),
  }
}

/** 吊销某 workspace 的全部有效 runtime token（停沙箱 / 重建 / 归档时调用）。 */
export function revokeWorkspaceRuntimeTokens(store: Store, workspaceId: string): number {
  return revokeRuntimeTokens(store, { workspaceId }).revoked
}

function revokeIssuedToken(store: Store, tokenId: string | undefined): void {
  if (tokenId === undefined) return
  try {
    revokeRuntimeToken(store, { id: tokenId })
  } catch {
    // 回收失败不能盖住原始错误：token 会自然过期（TTL 24h）。
  }
}

export async function readWorkspaceRuntime(
  store: Store,
  workspaceId: string,
  manager?: RuntimeManager
): Promise<WorkspaceRuntime | null> {
  const saved = getWorkspaceRuntime(store, workspaceId)
  if (manager === undefined) return saved
  const live = await manager.status(workspaceId)
  if (live === null) return saved
  if (saved !== null && saved.phase === live.phase && saved.sandbox === live.sandbox) {
    return saveWorkspaceRuntime(store, {
      workspaceId,
      sandbox: live.sandbox,
      phase: live.phase,
      startedAt: saved.startedAt
    })
  }
  return saveWorkspaceRuntime(store, { workspaceId, sandbox: live.sandbox, phase: live.phase, ...(saved === null ? {} : { startedAt: saved.startedAt }) })
}
