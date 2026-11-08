#!/usr/bin/env node
// 控制面最小 API 的可执行入口。
//
//   PORT=8787 node --experimental-strip-types apps/api/src/main.ts
//
// 默认用 SQLite（`ROOST_DB`，缺省 `./data/roost.db`）：Bot/房间/轮次等 M4 能力需要它。
// `ROOST_DB=memory` 显式选择内存实现（重启即丢，仅演示用）。监听地址默认回环。
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { DEFAULT_HOST, DEFAULT_PORT, startServer } from './server.ts'
import type { StartedServer } from './server.ts'
import { createMemoryStore } from './memory-store.ts'
import { createStorePort } from './store-adapter.ts'
import { openStore } from '../../../packages/store/src/index.ts'
import { openShellRuntimeManager } from './runtime-manager-openshell.ts'
import { localRuntimeManager } from './runtime-manager-local.ts'
import { dockerRuntimeManager } from './runtime-manager-docker.ts'
import { daytonaRuntimeManager } from './runtime-manager-daytona.ts'
import { kubernetesRuntimeManager } from './runtime-manager-kubernetes.ts'
import { createSmtpMailerFromEnv } from './smtp-mailer.ts'
import { createSleeperRegistry } from './idle-sleepers.ts'

function readPort(): number {
  const raw = process.env['PORT']
  if (raw === undefined || raw.trim() === '') return DEFAULT_PORT
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`roost api: PORT must be an integer between 0 and 65535, got ${JSON.stringify(raw)}`)
    process.exit(2)
  }
  return port
}

/**
 * DSH 反代端口：`ROOST_DSH_PROXY_PORT` 未设置时默认 4098；`0` 表示禁用（不启动第二监听）。
 * 返回 undefined = 禁用。
 */
function readDshProxyPort(): number | undefined {
  const raw = process.env['ROOST_DSH_PROXY_PORT']
  if (raw === undefined || raw.trim() === '') return 4098
  const port = Number(raw.trim())
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(
      `roost api: ROOST_DSH_PROXY_PORT must be an integer between 0 and 65535, got ${JSON.stringify(raw)}`
    )
    process.exit(2)
  }
  return port === 0 ? undefined : port
}

function installShutdown(started: StartedServer, extraStop?: () => void): void {
  let closing = false
  const shutdown = (signal: string): void => {
    if (closing) return
    closing = true
    console.log(`roost api: ${signal} received, closing`)
    try {
      extraStop?.()
    } catch {
      // 宿主清理失败不阻塞退出。
    }
    const timer = setTimeout(() => {
      console.error('roost api: close timed out, exiting')
      process.exit(1)
    }, 5000)
    timer.unref()
    started.close().then(
      () => {
        clearTimeout(timer)
        process.exit(0)
      },
      (err: unknown) => {
        console.error('roost api: close failed', err)
        process.exit(1)
      }
    )
  }
  process.once('SIGINT', () => shutdown('SIGINT'))
  process.once('SIGTERM', () => shutdown('SIGTERM'))
}

function readKubernetesToken(): string {
  const env = (process.env.ROOST_K8S_TOKEN ?? process.env.KUBERNETES_TOKEN ?? '').trim()
  if (env !== '') return env
  try {
    return readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/token', 'utf8').trim()
  } catch {
    return ''
  }
}

async function main(): Promise<void> {
  const port = readPort()
  // 沙箱要通过 host.openshell.internal 访问控制面，所以默认仍是回环，但允许显式放开。
  const host = process.env.ROOST_HOST ?? DEFAULT_HOST
  const dshProxyPort = readDshProxyPort()
  const raw = process.env.ROOST_DB
  const memory = raw === 'memory'
  const dbPath = memory ? undefined : resolve(raw === undefined || raw === '' ? join(process.cwd(), 'data', 'roost.db') : raw)
  if (dbPath !== undefined) mkdirSync(dirname(dbPath), { recursive: true })
  const sqlite = dbPath === undefined ? undefined : openStore(dbPath)
  const store = sqlite === undefined ? createMemoryStore() : createStorePort(sqlite)

  // 沙箱管理只在显式配置时启用；没有 OpenShell 的机器上 /start 返回 runtime.not_configured。
  // E6：rawStore 交给 manager，ensure 时为每个 workspace 签发 24h token；没有 SQLite
  // （ROOST_DB=memory）时退回全局 ROOST_RUNTIME_TOKEN，保持旧部署可用。
  const runtimeProvider = (process.env.ROOST_RUNTIME_PROVIDER ?? process.env.ROOST_SANDBOX ?? '').trim()
  // OpenShell is sealed: it stays in the tree as a reference/fallback only when
  // an operator explicitly opts in. Docker is the supported production provider.
  if (runtimeProvider === 'openshell' && process.env.ROOST_ALLOW_OPENSHELL !== '1') {
    throw new Error('OpenShell provider is sealed; set ROOST_ALLOW_OPENSHELL=1 only for legacy recovery')
  }
  const runtimeManager =
    runtimeProvider === 'docker'
      ? dockerRuntimeManager({
          workerUrl: process.env.ROOST_DOCKER_WORKER_URL ?? 'http://172.17.43.58:8790',
          ...(process.env.ROOST_DOCKER_WORKER_URLS === undefined
            ? {}
            : { workerUrls: process.env.ROOST_DOCKER_WORKER_URLS.split(',').map((url) => url.trim()).filter(Boolean) }),
          workerToken: process.env.ROOST_DOCKER_WORKER_TOKEN ?? '',
          image: process.env.ROOST_DOCKER_IMAGE ?? process.env.ROOST_SANDBOX_IMAGE ?? 'roost/agent:multi-runtime',
          cpHost: process.env.ROOST_CP_HOST ?? '172.17.43.89',
          cpPort: Number(process.env.ROOST_CP_PORT ?? port),
          ...(process.env.ROOST_CP_SCHEME === 'https' ? { cpScheme: 'https' as const } : {}),
          lockApiBase: process.env.ROOST_CP_API_BASE ?? `http://127.0.0.1:${port}`,
          runtimeToken: process.env.ROOST_RUNTIME_TOKEN ?? '',
          ...(sqlite === undefined ? {} : { rawStore: sqlite }),
          ...(process.env.ROOST_BOT_ID === undefined ? {} : { botId: process.env.ROOST_BOT_ID }),
          ...(process.env.ROOST_BOT_CREDENTIALS_FILE === undefined ? {} : { credentialsFile: process.env.ROOST_BOT_CREDENTIALS_FILE }),
          log: (line: string) => console.log(`[docker-runtime] ${line}`)
        })
      : runtimeProvider === 'daytona'
      ? daytonaRuntimeManager({
          apiUrl: process.env.DAYTONA_API_URL ?? process.env.ROOST_DAYTONA_API_URL ?? 'https://app.daytona.io/api',
          apiKey: process.env.DAYTONA_API_KEY ?? process.env.ROOST_DAYTONA_API_KEY ?? '',
          ...(process.env.DAYTONA_ORGANIZATION_ID === undefined ? {} : { organizationId: process.env.DAYTONA_ORGANIZATION_ID }),
          snapshot: process.env.DAYTONA_SNAPSHOT ?? process.env.ROOST_DAYTONA_SNAPSHOT ?? process.env.ROOST_DOCKER_IMAGE ?? 'roost/agent:multi-runtime',
          ...(process.env.DAYTONA_SNAPSHOT_IMAGE === undefined ? {} : { snapshotImage: process.env.DAYTONA_SNAPSHOT_IMAGE }),
          ...(process.env.DAYTONA_SNAPSHOT_AUTO_CREATE === '1' ? { snapshotAutoCreate: true } : {}),
          volumeName: process.env.DAYTONA_VOLUME ?? process.env.ROOST_DAYTONA_VOLUME ?? 'roost-workspaces',
          ...(process.env.DAYTONA_TARGET === undefined ? {} : { target: process.env.DAYTONA_TARGET }),
          cpHost: process.env.ROOST_CP_HOST ?? '127.0.0.1',
          cpPort: Number(process.env.ROOST_CP_PORT ?? port),
          ...(process.env.ROOST_CP_SCHEME === 'https' ? { cpScheme: 'https' as const } : {}),
          lockApiBase: process.env.ROOST_CP_API_BASE ?? `http://127.0.0.1:${port}`,
          runtimeToken: process.env.ROOST_RUNTIME_TOKEN ?? '',
          ...(sqlite === undefined ? {} : { rawStore: sqlite }),
          ...(process.env.ROOST_BOT_ID === undefined ? {} : { botId: process.env.ROOST_BOT_ID }),
          ...(process.env.ROOST_BOT_CREDENTIALS_FILE === undefined ? {} : { credentialsFile: process.env.ROOST_BOT_CREDENTIALS_FILE }),
          log: (line: string) => console.log(`[daytona-runtime] ${line}`)
        })
      : runtimeProvider === 'kubernetes'
      ? kubernetesRuntimeManager({
          apiUrl: process.env.ROOST_K8S_API_URL ?? 'https://kubernetes.default.svc',
          token: readKubernetesToken(),
          namespace: process.env.ROOST_K8S_NAMESPACE ?? 'roost',
          image: process.env.ROOST_K8S_IMAGE ?? process.env.ROOST_DOCKER_IMAGE ?? 'roost/agent:multi-runtime',
          ...(process.env.ROOST_K8S_IMAGE_PULL_SECRETS === undefined
            ? {}
            : { imagePullSecrets: process.env.ROOST_K8S_IMAGE_PULL_SECRETS.split(',').map((name) => name.trim()).filter(Boolean) }),
          ...(process.env.ROOST_K8S_SERVICE_ACCOUNT === undefined ? {} : { serviceAccountName: process.env.ROOST_K8S_SERVICE_ACCOUNT }),
          ...(process.env.ROOST_K8S_STORAGE_CLASS === undefined ? {} : { storageClassName: process.env.ROOST_K8S_STORAGE_CLASS }),
          ...(process.env.ROOST_K8S_STORAGE_SIZE === undefined ? {} : { storageSize: process.env.ROOST_K8S_STORAGE_SIZE }),
          cpHost: process.env.ROOST_CP_HOST ?? '127.0.0.1',
          cpPort: Number(process.env.ROOST_CP_PORT ?? port),
          ...(process.env.ROOST_CP_SCHEME === 'https' ? { cpScheme: 'https' as const } : {}),
          lockApiBase: process.env.ROOST_CP_API_BASE ?? `http://127.0.0.1:${port}`,
          runtimeToken: process.env.ROOST_RUNTIME_TOKEN ?? '',
          ...(sqlite === undefined ? {} : { rawStore: sqlite }),
          ...(process.env.ROOST_BOT_ID === undefined ? {} : { botId: process.env.ROOST_BOT_ID }),
          ...(process.env.ROOST_BOT_CREDENTIALS_FILE === undefined ? {} : { credentialsFile: process.env.ROOST_BOT_CREDENTIALS_FILE }),
          log: (line: string) => console.log(`[k8s-runtime] ${line}`)
        })
      : runtimeProvider === 'local'
      ? localRuntimeManager({
          cpHost: process.env.ROOST_CP_HOST ?? '127.0.0.1',
          cpPort: Number(process.env.ROOST_CP_PORT ?? port),
          cpScheme: process.env.ROOST_CP_SCHEME === 'https' ? 'https' : 'http',
          dshBin: process.env.ROOST_DSH_BIN ?? 'dsh',
          nodeBin: process.execPath,
          roomAgentPath: resolve(import.meta.dirname, '..', '..', 'runtime', 'room-agent.mjs'),
          workRoot: process.env.ROOST_LOCAL_WORKSPACE_DIR ?? resolve(process.cwd(), 'data', 'workspaces'),
          runtimeToken: process.env.ROOST_RUNTIME_TOKEN ?? '',
          log: (line: string) => console.log(`[local-runtime] ${line}`)
        })
      : runtimeProvider === 'openshell'
      ? openShellRuntimeManager({
          image: process.env.ROOST_SANDBOX_IMAGE ?? 'roost/agent:dev',
          cpHost: process.env.ROOST_CP_HOST ?? 'host.openshell.internal',
          cpPort: Number(process.env.ROOST_CP_PORT ?? port),
          cpScheme: process.env.ROOST_CP_SCHEME === 'https' ? 'https' : 'http',
          lockApiBase: process.env.ROOST_CP_API_BASE ?? `http://127.0.0.1:${port}`,
          runtimeToken: process.env.ROOST_RUNTIME_TOKEN ?? '',
          ...(sqlite === undefined ? {} : { rawStore: sqlite }),
          ...(process.env.ROOST_BOT_ID === undefined ? {} : { botId: process.env.ROOST_BOT_ID }),
          ...(process.env.ROOST_BOT_CREDENTIALS_FILE === undefined ? {} : { credentialsFile: process.env.ROOST_BOT_CREDENTIALS_FILE }),
          log: (line: string) => console.log(`[sandbox] ${line}`)
        })
      : undefined

  // 宿主侧空闲睡/醒（6.5.4）：默认关闭，ROOST_IDLE_SLEEP_MS > 0 才启用。
  const idleMs = Number(process.env['ROOST_IDLE_SLEEP_MS'] ?? '0')
  let sleepers: ReturnType<typeof createSleeperRegistry> | undefined
  if (runtimeManager !== undefined && sqlite !== undefined && Number.isFinite(idleMs) && idleMs > 0) {
    const { OpenShellBackend } = await import('../../../packages/sandbox/src/index.ts')
    sleepers = createSleeperRegistry({
      backend: new OpenShellBackend(),
      rawStore: sqlite,
      idleMs,
      log: (line: string) => console.log(`[idle] ${line}`)
    })
  }

  const smtpMailer = createSmtpMailerFromEnv()
  let started: StartedServer
  try {
    started = await startServer({
      store,
      port,
      host,
      ...(sqlite === undefined ? {} : { rawStore: sqlite }),
      ...(runtimeManager === undefined ? {} : { runtimeManager }),
      ...(smtpMailer === null ? {} : { authMailer: smtpMailer }),
      ...(dshProxyPort === undefined ? {} : { dshProxyPort }),
      ...(sleepers === undefined
        ? {}
        : {
            onEvent: (event: unknown) => sleepers?.onEvent(event as never),
            onWorkspaceStarted: (info: { workspaceId: string; sandbox: string }) => sleepers?.start(info)
          })
    })
  } catch (err) {
    console.error(`roost api: failed to listen on ${host}:${port}`, err)
    process.exitCode = 1
    return
  }

  console.log(
    `roost api listening on ${started.url} (${sqlite === undefined ? 'memory store; state is lost on exit' : `sqlite ${dbPath}`}${runtimeManager === undefined ? '' : ', sandbox manager on'})`
  )
  if (started.dshProxyUrl !== undefined) {
    console.log(`roost api: dsh proxy on ${started.dshProxyUrl}`)
  }
  installShutdown(started, () => sleepers?.stopAll())
}

await main()
