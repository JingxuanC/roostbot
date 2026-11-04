// RuntimeManager 的默认实现：把 start 交给 apps/runtime/planA-boot 背后的同一套逻辑。
//
// 沙箱镜像、策略、provider 都由环境给出；这里只负责把工作区映射到固定沙箱名，
// 并在成功后回报阶段。机器上没有 OpenShell（本地开发）时抛 runtime.not_configured。

import type { RuntimeManager } from './workspace-runtime.ts'

export interface OpenShellRuntimeConfig {
  image: string
  cpHost: string
  cpPort: number
  runtimeToken: string
  botId?: string
  log?: (line: string) => void
}

export function openShellRuntimeManager(config: OpenShellRuntimeConfig): RuntimeManager {
  return {
    async ensure(workspaceId) {
      const { sandboxNameFor, ensureUserSandbox, userSandboxPolicy } = await import('../../runtime/sandbox-manager.mjs')
      const name = sandboxNameFor(workspaceId)
      const result = await ensureUserSandbox({
        workspaceId,
        name,
        image: config.image,
        policyYaml: userSandboxPolicy({ host: config.cpHost, port: config.cpPort }),
        providers: ['deepseek'],
        env: {
          ROOST_API: `http://${config.cpHost}:${config.cpPort}`,
          ROOST_RUNTIME_TOKEN: config.runtimeToken,
          ROOST_BOT_ID: config.botId ?? 'selector',
          ROOST_WORKSPACE_ID: workspaceId,
          ROOST_STATE_FILE: '/workspace/.dsh/room-cursors.json',
          ROOST_DSH_PROVIDER: 'deepseek-official',
          ROOST_DSH_MODEL: 'deepseek-chat',
          ROOST_WORKDIR: '/workspace'
        },
        log: config.log ?? (() => {})
      })
      return { sandbox: result.handle.name, phase: 'ready' as const }
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
    }
  }
}
