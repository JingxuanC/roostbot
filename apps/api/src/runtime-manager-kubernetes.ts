// Kubernetes RuntimeManager wrapper. See runtime-manager-daytona.ts: the
// control-plane orchestration is shared; only the provider changes.

import type { IssuedRuntimeToken } from '../../../packages/store/src/runtime-tokens.ts'
import type { Store } from '../../../packages/store/src/types.ts'
import { kubernetesRuntimeProvider, type KubernetesRuntimeProviderConfig } from './runtime-provider-kubernetes.ts'
import { providerRuntimeManager } from './runtime-manager-provider.ts'
import type { RuntimeManager } from './workspace-runtime.ts'

export interface KubernetesRuntimeManagerConfig extends KubernetesRuntimeProviderConfig {
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

export function kubernetesRuntimeManager(config: KubernetesRuntimeManagerConfig): RuntimeManager {
  return providerRuntimeManager({
    provider: kubernetesRuntimeProvider(config),
    image: config.image ?? 'roost/agent:multi-runtime',
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
