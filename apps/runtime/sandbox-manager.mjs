// 用户级沙箱管理器：一个 workspace 一个沙箱，固定名字复用（stop/start）。
//
// 沙箱主进程就是 room-agent（长活 DSH + 每房间一个会话），不是 sleep infinity。
// 名字规则：user-<8 hex of workspaceId>（OpenShell 上限 19 字符）。

import { createHash } from 'node:crypto'
import { OpenShellBackend, renderPolicyYaml } from '../../packages/sandbox/src/index.ts'

export function sandboxNameFor(workspaceId) {
  const hash = createHash('sha256').update(String(workspaceId)).digest('hex').slice(0, 8)
  return `user-${hash}`
}

/** 用户沙箱策略：默认拒绝出网；只放行控制面（tcp）与 provider 声明的端点。 */
export function userSandboxPolicy(controlPlane) {
  return renderPolicyYaml({
    version: 1,
    filesystem: {
      read: ['/usr', '/etc', '/bin', '/sbin', '/lib', '/lib64', '/opt', '/proc', '/dev/null'],
      write: ['/tmp', '/workspace', '/var/lib/dsh']
    },
    process: { user: 1000, caps: [] },
    network: {
      default: 'deny',
      allow: [
        {
          binary: '/usr/local/bin/node',
          host: `${controlPlane.host}:${controlPlane.port}`,
          port: controlPlane.port,
          methods: []
        }
      ]
    }
  })
}

/** 是否已有同名沙箱；有就 start（幂等），返回复用标记。 */
export async function ensureUserSandbox(options) {
  const backend = options.backend ?? new OpenShellBackend({ binary: options.binary ?? 'openshell' })
  const name = options.name ?? sandboxNameFor(options.workspaceId)
  const handle = { id: name, name, backend: backend.id }

  const listed = await backend.list?.()
  const exists = Array.isArray(listed) ? listed.some((entry) => entry.name === name) : false

  if (exists) {
    // stopped → start；ready → 忽略错误（已启动）。
    await backend.start?.(handle).catch(() => undefined)
    options.log?.(`sandbox ${name} reused (started)`)
    return { handle, created: false }
  }

  const created = await backend.create({
    name,
    policyYaml: options.policyYaml,
    image: options.image,
    ...(options.providers === undefined ? {} : { providers: options.providers }),
    ...(options.env === undefined ? {} : { env: options.env }),
    command: options.command ?? ['node', '/opt/roost/room-agent.mjs']
  })
  options.log?.(`sandbox ${created.name} created`)
  return { handle: created, created: true }
}
