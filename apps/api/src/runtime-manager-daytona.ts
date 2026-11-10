// Daytona RuntimeManager wrapper.
//
// The orchestration (token issuance, profile lock, credentialRef env, spec
// building) is shared with Docker; only the RuntimeProvider differs.

import type { IssuedRuntimeToken } from '../../../packages/store/src/runtime-tokens.ts'
import type { Store } from '../../../packages/store/src/types.ts'
import { daytonaRuntimeProvider, type DaytonaRuntimeProviderConfig } from './runtime-provider-daytona.ts'
import { providerRuntimeManager } from './runtime-manager-provider.ts'
import type { RuntimeManager } from './workspace-runtime.ts'

export interface DaytonaRuntimeManagerConfig extends DaytonaRuntimeProviderConfig {
  cpHost: string
  cpPort: number
  cpScheme?: 'http' | 'https'
  lockApiBase?: string
  runtimeToken: string
  rawStore?: Store
  tokenIssuer?: (workspaceId: string) => IssuedRuntimeToken
  tokenTtlMs?: number
  botId?: string
  credentialsFile?: string
  log?: (line: string) => void
}

export function daytonaRuntimeManager(config: DaytonaRuntimeManagerConfig): RuntimeManager {
  return providerRuntimeManager({
    provider: daytonaRuntimeProvider(config),
    image: config.snapshot ?? 'roost/agent:multi-runtime',
    cpHost: config.cpHost,
    cpPort: config.cpPort,
    ...(config.cpScheme === undefined ? {} : { cpScheme: config.cpScheme }),
    ...(config.lockApiBase === undefined ? {} : { lockApiBase: config.lockApiBase }),
    runtimeToken: config.runtimeToken,
    ...(config.rawStore === undefined ? {} : { rawStore: config.rawStore }),
    ...(config.tokenIssuer === undefined ? {} : { tokenIssuer: config.tokenIssuer }),
    ...(config.tokenTtlMs === undefined ? {} : { tokenTtlMs: config.tokenTtlMs }),
    ...(config.botId === undefined ? {} : { botId: config.botId }),
    ...(config.credentialsFile === undefined ? {} : { credentialsFile: config.credentialsFile }),
    ...(config.log === undefined ? {} : { log: config.log }),
  })
}
