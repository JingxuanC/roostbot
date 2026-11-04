// 远端一次性引导脚本：确保用户沙箱存在（主进程 room-agent）。
// 只在 E2E 里用；产品路径是控制面调用同一套 ensureUserSandbox。
import { ensureUserSandbox, userSandboxPolicy, sandboxNameFor } from './sandbox-manager.mjs'

const workspaceId = process.env.ROOST_WS
const cpHost = process.env.ROOST_CP_HOST ?? 'host.openshell.internal'
const cpPort = Number(process.env.ROOST_CP_PORT ?? '8792')
const name = sandboxNameFor(workspaceId)
const result = await ensureUserSandbox({
  workspaceId,
  name,
  image: process.env.ROOST_IMAGE ?? 'roost/agent:dev',
  policyYaml: userSandboxPolicy({ host: cpHost, port: cpPort }),
  providers: ['deepseek'],
  env: {
    ROOST_API: `http://${cpHost}:${cpPort}`,
    ROOST_RUNTIME_TOKEN: process.env.ROOST_RUNTIME_TOKEN ?? '',
    ROOST_BOT_ID: process.env.ROOST_BOT_ID ?? 'selector',
    ROOST_STATE_FILE: '/workspace/.dsh/room-cursors.json',
    ROOST_DSH_PROVIDER: 'deepseek-official',
    ROOST_DSH_MODEL: 'deepseek-chat',
    ROOST_WORKDIR: '/workspace'
  },
  log: (line) => console.log(line)
})
console.log(JSON.stringify({ name: result.handle.name, created: result.created }))
