// Local process RuntimeManager: the same control plane, but the workspace runtime
// is a child `node room-agent.mjs` on this machine instead of an OpenShell sandbox.
//
// This exists so `ROOST_SANDBOX=local` can exercise the real room/SSE/DB path
// during development without Docker, OpenShell or a remote host. It is not a
// security boundary: the child inherits this user's filesystem and network.
//
// The manager owns process lifetime only. Token issuance, workspace runtime rows,
// room state and SSE remain control-plane responsibilities, exactly as they are
// for the OpenShell manager.

import { spawn as nodeSpawn } from 'node:child_process'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { issueRuntimeToken, revokeRuntimeToken } from '../../../packages/store/src/runtime-tokens.ts'
import type { IssuedRuntimeToken } from '../../../packages/store/src/runtime-tokens.ts'
import type { Store } from '../../../packages/store/src/types.ts'
import type { RuntimeEnsureResult, RuntimeManager } from './workspace-runtime.ts'

export const LOCAL_RUNTIME_TOKEN_TTL_MS = 24 * 60 * 60 * 1000

export interface LocalRuntimeConfig {
  /** Control-plane base URL reachable from the child. */
  cpHost: string
  cpPort: number
  cpScheme?: 'http' | 'https'
  /** DSH executable; defaults to `dsh` on PATH. */
  dshBin: string
  /** Node executable used to launch room-agent; defaults to process.execPath. */
  nodeBin?: string
  /** Absolute path to apps/runtime/room-agent.mjs. */
  roomAgentPath: string
  /** Directory holding one workdir per workspace. */
  workRoot: string
  /** Global token fallback when there is no SQLite store (memory mode). */
  runtimeToken?: string
  /** Test/fake token issuance. */
  tokenIssuer?: (workspaceId: string) => IssuedRuntimeToken
  /** Test/fake process spawn. */
  spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess
  /** In tests, skip waiting for room-agent's `sdk ready` line. */
  waitForReady?: boolean
  readyTimeoutMs?: number
  log?: (line: string) => void
  now?: () => number
}

interface LocalEntry {
  child: ChildProcess
  tokenId?: string
  sandbox: string
  workspaceId: string
}

/** Resolve a token while keeping the id for cleanup on failed starts. */
function issueLocalToken(store: Store | undefined, config: LocalRuntimeConfig, workspaceId: string): { token: string; id?: string } {
  if (config.tokenIssuer !== undefined) {
    const issued = config.tokenIssuer(workspaceId)
    return { token: issued.token, id: issued.id }
  }
  if (store !== undefined) {
    const issued = issueRuntimeToken(store, {
      workspaceId,
      ttlMs: LOCAL_RUNTIME_TOKEN_TTL_MS,
      ...(config.now === undefined ? {} : { at: config.now() }),
    })
    return { token: issued.token, id: issued.id }
  }
  return { token: config.runtimeToken ?? '' }
}

function revokeLocalToken(store: Store | undefined, tokenId: string | undefined): void {
  if (store === undefined || tokenId === undefined) return
  try {
    revokeRuntimeToken(store, { id: tokenId })
  } catch {
    // A failed cleanup must not hide the original start error; tokens expire.
  }
}

function workspaceKey(workspaceId: string): string {
  return workspaceId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80)
}

export function localRuntimeManager(config: LocalRuntimeConfig): RuntimeManager {
  const entries = new Map<string, LocalEntry>()
  const log = config.log ?? (() => {})
  const nodeBin = config.nodeBin ?? process.execPath
  const spawnProcess = config.spawn ?? ((command: string, args: string[], options: SpawnOptions) => nodeSpawn(command, args, options))

  function sandboxName(workspaceId: string): string {
    return `local:${workspaceId}`
  }

  function isAlive(child: ChildProcess): boolean {
    return child.exitCode === null && child.killed !== true
  }

  function revokeEntry(entry: LocalEntry, store?: Store): void {
    try {
      entry.child.kill('SIGTERM')
    } catch {
      // best effort
    }
    revokeLocalToken(store, entry.tokenId)
    entries.delete(entry.workspaceId)
  }

  function processEnv(workspaceId: string, token: string, workdir: string): Record<string, string> {
    const apiBase = `${config.cpScheme ?? 'http'}://${config.cpHost}:${config.cpPort}`
    return {
      ...process.env,
      ROOST_API: apiBase,
      ROOST_RUNTIME_TOKEN: token,
      ROOST_BOT_ID: 'selector',
      ROOST_WORKSPACE_ID: workspaceId,
      ROOST_WORKDIR: workdir,
      ROOST_STATE_FILE: join(workdir, '.dsh', 'room-cursors.json'),
      ROOST_DSH_BIN: config.dshBin,
      ROOST_DSH_PROFILE: process.env.ROOST_DSH_PROFILE ?? 'sdk',
      ROOST_DSH_PROVIDER: process.env.ROOST_DSH_PROVIDER ?? 'deepseek-official',
      ROOST_DSH_MODEL: process.env.ROOST_DSH_MODEL ?? (process.env.ROOST_FREE_MODEL ?? 'deepseek-flash'),
      ROOST_DSH_WEB: '0',
      ROOST_MULTI_RUNTIME: process.env.ROOST_MULTI_RUNTIME ?? '0',
      DEEPSEEK_BASE_URL: apiBase,
      DEEPSEEK_API_KEY: token,
      DSH_PERMISSION_MODE: 'danger-full-access',
      HOME: workdir,
      DSH_HOME: join(workdir, '.dsh'),
    }
  }

  function waitUntilReady(child: ChildProcess, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (error?: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        child.stdout?.off('data', onStdout)
        child.off('exit', onExit)
        if (error === undefined) resolve()
        else reject(error)
      }
      let buffer = ''
      const onStdout = (chunk: Buffer | string) => {
        buffer += String(chunk)
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (line.includes('sdk ready') || line.includes('room-agent ready')) finish()
        }
      }
      const onExit = (code: number | null, signal: string | null) => {
        finish(new Error(`local room-agent exited before ready (code=${code ?? 'null'}, signal=${signal ?? 'null'})`))
      }
      const timer = setTimeout(() => finish(new Error(`local room-agent did not become ready within ${timeoutMs}ms`)), Math.max(1, timeoutMs))
      if (typeof timer.unref === 'function') timer.unref()
      child.stdout?.on('data', onStdout)
      child.once('exit', onExit)
    })
  }

  return {
    async ensure(workspaceId, context): Promise<RuntimeEnsureResult> {
      const existing = entries.get(workspaceId)
      if (existing !== undefined && isAlive(existing.child)) {
        return { sandbox: existing.sandbox, phase: 'ready' }
      }
      if (existing !== undefined) entries.delete(workspaceId)

      const store = context?.store
      const token = issueLocalToken(store, config, workspaceId)
      if (token.token === '') {
        throw new Error('local runtime needs ROOST_RUNTIME_TOKEN when the control plane uses a memory store')
      }
      const workdir = join(config.workRoot, workspaceKey(workspaceId))
      mkdirSync(join(workdir, '.dsh'), { recursive: true })

      let child: ChildProcess
      try {
        child = spawnProcess(nodeBin, [config.roomAgentPath], {
          cwd: workdir,
          env: processEnv(workspaceId, token.token, workdir),
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      } catch (error) {
        revokeLocalToken(store, token.id)
        throw new Error(`local room-agent spawn failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      child.stderr?.on('data', (chunk) => log(`[local:${workspaceId}] ${String(chunk).trimEnd()}`))
      child.stdout?.on('data', (chunk) => log(`[local:${workspaceId}] ${String(chunk).trimEnd()}`))
      child.once('exit', (code, signal) => {
        log(`[local:${workspaceId}] exited code=${code ?? 'null'} signal=${signal ?? 'null'}`)
      })

      const entry: LocalEntry = { child, tokenId: token.id, sandbox: sandboxName(workspaceId), workspaceId }
      entries.set(workspaceId, entry)
      try {
        if (config.waitForReady !== false) {
          await waitUntilReady(child, config.readyTimeoutMs ?? 20_000)
        }
      } catch (error) {
        revokeEntry(entry, store)
        throw error
      }
      log(`[local:${workspaceId}] ready workdir=${workdir}`)
      return { sandbox: entry.sandbox, phase: 'ready' }
    },

    async status(workspaceId) {
      const entry = entries.get(workspaceId)
      if (entry === undefined) return null
      if (!isAlive(entry.child)) {
        entries.delete(workspaceId)
        return null
      }
      return { sandbox: entry.sandbox, phase: 'ready' }
    },

    /** Local-only cleanup hook; not part of the shared RuntimeManager port. */
    async stop(workspaceId) {
      const entry = entries.get(workspaceId)
      if (entry === undefined) return false
      revokeEntry(entry)
      return true
    },
  }
}
