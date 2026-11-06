// 把轮次开合、轮到谁说话写进房间日志（docs/design/architecture-v2.md §5.2）。
//
// 只追加事件，不改 slot 状态机。失败只打日志：轮次投影已经落库，信号丢了
// 下一拍兜底读库还能从 room_rounds 看到，不能反过来让开轮失败。

import type { RoomRound } from '../../../packages/contract/src/index.ts'
import { appendRoomSignal } from '../../../packages/store/src/room-log.ts'
import type { Store } from '../../../packages/store/src/types.ts'

function snapshot(round: RoomRound): Record<string, unknown> {
  return {
    id: round.id,
    roomId: round.roomId,
    state: round.state,
    startSeq: round.startSeq,
    slots: round.slots,
    turns: round.turns,
    startedAt: round.startedAt,
    ...(round.speaking === undefined ? {} : { speaking: round.speaking }),
    ...(round.endedAt === undefined ? {} : { endedAt: round.endedAt }),
  }
}

function firstWaiting(round: RoomRound): { index: number; botId: string } | null {
  const index = round.slots.findIndex((slot) => slot.status === 'waiting' || slot.status === 'speaking')
  if (index < 0) return null
  return { index, botId: round.slots[index]!.botId }
}

/** 新开的一轮：round.started + 第一个发言人的 speaking。idem 保证重复开轮不产生新 seq。 */
export function noteRoundOpened(store: Store, round: RoomRound): void {
  try {
    const started = appendRoomSignal(store, {
      roomId: round.roomId,
      domain: 'turn',
      kind: 'turn.round.started',
      idem: `round:${round.id}:started`,
      payload: { roundId: round.id, round: snapshot(round) },
    })
    const speaker = firstWaiting(round)
    if (speaker === null) return
    appendRoomSignal(store, {
      roomId: round.roomId,
      domain: 'turn',
      kind: 'turn.speaking',
      idem: `round:${round.id}:speaking:${speaker.index}:${speaker.botId}`,
      parent: started.seq,
      payload: { roundId: round.id, botId: speaker.botId, slotIndex: speaker.index },
    })
  } catch (error) {
    console.error('roost api: failed to append round.started', error)
  }
}

/** advance 之后：轮次结束写 round.ended；还在跑就写下一位 speaking。 */
export function noteRoundAdvanced(store: Store, before: RoomRound, after: RoomRound): void {
  try {
    if (before.state === 'running' && after.state !== 'running') {
      appendRoomSignal(store, {
        roomId: after.roomId,
        domain: 'turn',
        kind: 'turn.round.ended',
        idem: `round:${after.id}:ended`,
        payload: { roundId: after.id, state: after.state, round: snapshot(after) },
      })
      return
    }
    if (after.state !== 'running') return
    const speaker = firstWaiting(after)
    if (speaker === null) return
    const previous = firstWaiting(before)
    if (previous !== null && previous.index === speaker.index && previous.botId === speaker.botId) return
    appendRoomSignal(store, {
      roomId: after.roomId,
      domain: 'turn',
      kind: 'turn.speaking',
      idem: `round:${after.id}:speaking:${speaker.index}:${speaker.botId}`,
      payload: { roundId: after.id, botId: speaker.botId, slotIndex: speaker.index },
    })
  } catch (error) {
    console.error('roost api: failed to append round signal', error)
  }
}
