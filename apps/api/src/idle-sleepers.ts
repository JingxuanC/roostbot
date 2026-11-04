// 宿主侧空闲睡/醒（6.5.4）：控制面为每个运行中的 workspace 维护一个 idle-sleeper。
//
// 规则来自 docs/design/scheduling.md §9：容器永不自己停，只有控制面能停。
// 所以 sleeper 在宿主进程里跑，靠 backend.stop(start) 操作 OpenShell 沙箱；
// touch() 由入站事件（chat.message 等）驱动，保证"刚有活动就不睡"。

import { startIdleSleeper } from '../../runtime/idle-sleeper.mjs'
import type { SandboxBackend } from '../../../packages/sandbox/src/backend.ts'
import type { SandboxHandle } from '../../../packages/sandbox/src/backend.ts'
import { getRoom } from '../../../packages/store/src/rooms.ts'
import type { Event, Store } from '../../../packages/store/src/types.ts'

export interface SleeperRegistryOptions {
  backend: SandboxBackend
  rawStore: Store
  idleMs: number
  pollMs?: number
  log?: (line: string) => void
}

export interface SleeperRegistry {
  start(input: { workspaceId: string; sandbox: string }): void
  touch(workspaceId: string): void
  /** 事件 → 触达所属 workspace；不认识的事件忽略。 */
  onEvent(event: Event): void
  stopAll(): void
}

export function createSleeperRegistry(options: SleeperRegistryOptions): SleeperRegistry {
  const sleepers = new Map<string, ReturnType<typeof startIdleSleeper>>()

  return {
    start({ workspaceId, sandbox }) {
      if (sleepers.has(workspaceId)) return
      const handle = { id: sandbox, name: sandbox, backend: options.backend.id } as SandboxHandle
      const sleeper = startIdleSleeper({
        sandbox,
        idleMs: options.idleMs,
        pollMs: options.pollMs ?? 60_000,
        log: options.log,
        backend: {
          stop: async () => {
            await options.backend.stop?.(handle)
            options.log?.(`idle: stopped ${sandbox}`)
          },
          start: async () => {
            await options.backend.start?.(handle)
            options.log?.(`idle: started ${sandbox}`)
          }
        }
      })
      sleepers.set(workspaceId, sleeper)
    },
    touch(workspaceId) {
      sleepers.get(workspaceId)?.touch()
    },
    onEvent(event) {
      if (event.kind !== 'chat.message') return
      const roomId = typeof event.payload['roomId'] === 'string' ? event.payload['roomId'] : event.subject?.id
      if (typeof roomId !== 'string' || roomId === '') return
      const room = getRoom(options.rawStore, roomId)
      if (room === null) return
      sleepers.get(room.workspaceId)?.touch()
    },
    stopAll() {
      for (const sleeper of sleepers.values()) sleeper.stop()
      sleepers.clear()
    }
  }
}
