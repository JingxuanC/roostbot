// Per-Bot vendor credentials for external Agent runtimes.
//
// credential_ref is an opaque pointer. This module resolves it from a
// workspace-scoped secret file (mode 0600) and produces a JSON map injected into
// the Docker runtime. The runtime sees only the workspace's own Bot refs.
//
// Long term this module is the seam for a real secret provider (Vault/KMS);
// the file backend keeps the first implementation dependency-free and local.

import { readFileSync } from 'node:fs'
import { listBots } from '../../../packages/store/src/bots.ts'
import type { Store } from '../../../packages/store/src/types.ts'

export const CREDENTIAL_ENV_ALLOWLIST = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL', 'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_API_KEY', 'CODEX_HOME',
  'XAI_API_KEY', 'XAI_BASE_URL', 'GROK_API_KEY', 'GROK_BASE_URL',
] as const

export type BotCredentialMap = Record<string, Record<string, string>>

/** Parse a JSON object of `credentialRef -> {ENV: value}` with a strict allowlist. */
export function parseBotCredentialFile(raw: string): BotCredentialMap {
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { throw new Error('credential file must be valid JSON') }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('credential file must be a JSON object')
  }
  const out: BotCredentialMap = {}
  for (const [ref, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!ref.startsWith('vault://') && !ref.startsWith('env://')) {
      throw new Error(`credential ref must start with vault:// or env://: ${ref}`)
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error(`credential ${ref} must map to an object`)
    }
    const env: Record<string, string> = {}
    for (const [key, rawValue] of Object.entries(value as Record<string, unknown>)) {
      if (!(CREDENTIAL_ENV_ALLOWLIST as readonly string[]).includes(key)) {
        throw new Error(`credential ${ref} contains unsupported env ${key}`)
      }
      if (typeof rawValue !== 'string' || rawValue === '' || rawValue.length > 16_384) {
        throw new Error(`credential ${ref}.${key} must be a non-empty string`)
      }
      if (/[\u0000\r\n]/.test(rawValue)) throw new Error(`credential ${ref}.${key} contains a newline or NUL`)
      env[key] = rawValue
    }
    if (Object.keys(env).length === 0) throw new Error(`credential ${ref} is empty`)
    out[ref] = env
  }
  return out
}

export function loadBotCredentialFile(path: string | undefined): BotCredentialMap {
  if (path === undefined || path.trim() === '') return {}
  const raw = readFileSync(path, 'utf8')
  return parseBotCredentialFile(raw)
}

/** Build `{ botId: env }` for the bots in one workspace. */
export function botCredentialEnvMap(store: Store, workspaceId: string, registry: BotCredentialMap): BotCredentialMap {
  const out: BotCredentialMap = {}
  for (const bot of listBots(store, workspaceId)) {
    if (typeof bot.credentialRef !== 'string' || bot.credentialRef === '') continue
    const env = registry[bot.credentialRef]
    if (env !== undefined) out[bot.id] = { ...env }
  }
  return out
}
