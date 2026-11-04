// 工作区运行时：start 与状态查询（TODO 4.3.1–4.3.3）。
//
// 控制面不自己碰 Docker/OpenShell：它调用一个 RuntimeManager 端口；
// 默认实现把请求交给 apps/runtime 的 sandbox-manager（同一台主机上）。
// 本地开发/测试没有运行时环境时，start 返回 runtime.not_configured，而不是假装成功。

import { getWorkspaceRuntime, saveWorkspaceRuntime, type RuntimePhase, type WorkspaceRuntime } from '../../../packages/store/src/workspace-runtime.ts'
import type { Store } from '../../../packages/store/src/types.ts'

export interface RuntimeManager {
  /** 确保这个工作区的用户沙箱存在（创建或复用 stop/start）。 */
  ensure(workspaceId: string): Promise<{ sandbox: string; phase: RuntimePhase }>
  /** 只看状态，不创建。 */
  status(workspaceId: string): Promise<{ sandbox: string; phase: RuntimePhase } | null>
}

export interface StartRuntimeResult {
  runtime: WorkspaceRuntime
  created: boolean
}

export async function startWorkspaceRuntime(
  store: Store,
  workspaceId: string,
  manager: RuntimeManager
): Promise<StartRuntimeResult> {
  const existing = getWorkspaceRuntime(store, workspaceId)
  let ensured: { sandbox: string; phase: RuntimePhase }
  try {
    ensured = await manager.ensure(workspaceId)
  } catch (error) {
    // 状态失败也要落库，面板才能显示 error 而不是空白。
    if (existing !== null) saveWorkspaceRuntime(store, { workspaceId, sandbox: existing.sandbox, phase: 'error' })
    throw error
  }
  const runtime = saveWorkspaceRuntime(store, {
    workspaceId,
    sandbox: ensured.sandbox,
    phase: ensured.phase,
    ...(existing === null ? {} : { startedAt: existing.startedAt })
  })
  return { runtime, created: existing === null }
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
