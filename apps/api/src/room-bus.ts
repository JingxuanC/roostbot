// 进程内房间事件总线（docs/design/architecture-v2.md §5.4）。
//
// appendEvent 成功之后通知这里。SSE 和沙箱长轮询挂在同一条总线上，
// 写完就醒，不再按 700ms 空转。通知失败不能影响已经落库的事件。

import { EventEmitter } from 'node:events'

export interface RoomWake {
  roomId: string
  seq: number
  kind: string
}

const bus = new EventEmitter()
bus.setMaxListeners(0)

export function publishRoomWake(wake: RoomWake): void {
  bus.emit('rooms', wake)
  if (wake.roomId !== '') bus.emit(`room:${wake.roomId}`, wake)
}

/** 从已落库的事件里取出房间受众并唤醒。非房间事件忽略。 */
export function publishFromStoredEvent(event: {
  audience?: string | null
  seq: number
  kind: string
}): void {
  const audience = event.audience ?? ''
  if (!audience.startsWith('room:')) return
  const roomId = audience.slice('room:'.length)
  if (roomId === '') return
  publishRoomWake({ roomId, seq: event.seq, kind: event.kind })
}

export interface RoomWait {
  /**
   * 等到这个房间（roomId 为 null 时是任意房间）有新事件，或超时。
   * 在 wait 之前已经醒过一次时立刻返回 true，避免读和等之间的空窗。
   */
  wait(timeoutMs: number, signal?: AbortSignal): Promise<boolean>
  cancel(): void
}

/** roomId 为 null：任意房间的写入都会唤醒（workspace 级长轮询）。 */
export function armRoomWait(roomId: string | null): RoomWait {
  const channel = roomId === null || roomId === '' ? 'rooms' : `room:${roomId}`
  let pending = false
  let resolveWait: (() => void) | null = null
  const onWake = (): void => {
    pending = true
    resolveWait?.()
  }
  bus.on(channel, onWake)
  return {
    wait(timeoutMs, signal) {
      if (signal?.aborted === true) return Promise.resolve(false)
      if (pending) {
        pending = false
        return Promise.resolve(true)
      }
      return new Promise((resolve) => {
        let settled = false
        const finish = (value: boolean): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          signal?.removeEventListener('abort', onAbort)
          resolveWait = null
          if (value) pending = false
          resolve(value)
        }
        const timer = setTimeout(() => finish(false), Math.max(0, timeoutMs))
        const onAbort = (): void => finish(false)
        resolveWait = () => finish(true)
        if (signal?.aborted === true) {
          finish(false)
          return
        }
        signal?.addEventListener('abort', onAbort, { once: true })
        if (pending) finish(true)
      })
    },
    cancel() {
      bus.off(channel, onWake)
      resolveWait?.()
    },
  }
}
