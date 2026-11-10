// 建 Bot / 建群后的开场（docs/build/m4-addendum.md §A）。
//
// 事实源：docs/design/bots.md §2（创建后 kickoff：一句自我介绍 + 问“你希望我专注什么”）、
// docs/design/rooms.md §6（没写第一句时 host 用 kickoff 问“这个群要做什么”）。
//
// 这里只做四件事：
//   1. isKickoffDue：现在该不该自动开场（DM 或群；只看用户/系统消息，Bot 自己的话不算）；
//   2. kickoffPromptFor：交给 host 的 prompt（群复用 packages/rooms 的 buildKickoffPrompt）；
//   3. kickoffSlots：开场轮只有 host 一个 slot；
//   4. openKickoffRound：把开场落成一轮只有 host 的 round（不写消息、不投递，投递由 runtime 做）。
//
// 不碰 HTTP、不碰 runtime token；Lead 在 bots-routes / rooms-routes 接线。

import type { Room, RoomMember, RoomRound, RoundSlot } from '../../../packages/contract/src/index.ts'
import { buildKickoffPrompt, createRound } from '../../../packages/rooms/src/index.ts'
import { StoreError } from '../../../packages/store/src/errors.ts'
import { readMessages } from '../../../packages/store/src/rooms.ts'
import { getRoomDetail } from '../../../packages/store/src/rooms-ext.ts'
import { activeRound, latestRound, saveRound } from '../../../packages/store/src/rounds.ts'
import { noteRoundOpened } from './round-signals.ts'
import type { Store } from '../../../packages/store/src/types.ts'

/** Room + dm 标记；API 读 rooms 时把 rooms.dm 一起带出来即可。 */
export type KickoffRoom = Room & { dm?: boolean | number | null }

/** isKickoffDue 只关心 actor.kind；真实消息（RoomMessage）结构上满足它。 */
export interface KickoffMessage {
  actor?: { kind?: string } | null
}

/** dm 可能是 SQLite 的 0/1，也可能是 API 序列化后的 boolean；两种都认。 */
export function isDmRoom(room: { dm?: unknown } | null | undefined): boolean {
  return room?.dm === true || room?.dm === 1
}

/**
 * 现在该不该自动开场：房间的日志里还没有任何「非 Bot」消息（用户或系统）。
 *
 * 只看 actor.kind !== 'bot'：Bot 自己的开场/回复不会把 kickoff 判成“已经说过话”，
 * 这样某条 Bot 消息先落库时不会吞掉开场；真正决定“已经有过一轮”的是 openKickoffRound
 * 的 running / 已有 kickoff 轮检查。
 */
export function isKickoffDue(
  room: Pick<KickoffRoom, 'id'> & { dm?: unknown },
  messages: readonly KickoffMessage[] | null | undefined,
): boolean {
  if (room === null || room === undefined) return false
  for (const message of messages ?? []) {
    const kind = message?.actor?.kind ?? ''
    if (kind !== 'bot') return false
  }
  return true
}

/** DM 的开场：一句自我介绍 + 问用户希望你做什么（不是群里的“这个群要做什么”）。 */
export function dmKickoffPrompt(room: KickoffRoom, member: RoomMember): string {
  const name = (member.name ?? room.name ?? '').trim()
  const who = name === '' ? '' : `你是「${name}」。`
  return [
    `${who}这是你和用户的私聊，用户还没有发第一句话。`,
    '请用一条短消息介绍自己（一句话：你是谁、能帮用户做什么），然后问用户希望你做什么。',
    '不要 @ 任何人，也不要回复 [PASS]；直接写要发的话，不要加“名字：”前缀。用用户的语言（默认中文）。',
  ].join('')
}

/**
 * 开场轮的 slots：只有 host 一个（addendum A 的 kickoffSlots）。
 * 没有 host / host 不在成员里时返回 []，调用方据此不开轮。
 */
export function kickoffSlots(
  room: Pick<KickoffRoom, 'hostBotId' | 'members'> & { dm?: unknown },
): RoundSlot[] {
  const hostBotId =
    room.hostBotId ?? room.members.find((member) => member.role === 'host')?.botId ?? null
  if (hostBotId === null) return []
  const host = room.members.find((member) => member.botId === hostBotId)
  if (host === undefined) return []
  return [
    {
      botId: host.botId,
      ...(host.name === undefined ? {} : { name: host.name }),
      status: 'waiting',
    },
  ]
}

/** 交给 host 的开场 prompt：DM 用私聊文案，群复用 packages/rooms 的 buildKickoffPrompt。 */
export function kickoffPromptFor(room: KickoffRoom, member: RoomMember): string {
  if (isDmRoom(room)) return dmKickoffPrompt(room, member)
  return buildKickoffPrompt({ room, member })
}

/**
 * 把开场落成一轮只有 host 的 round。重复调用是幂等的：
 *   - 有 running 的轮次 → 直接返回它（一次只跑一轮）；
 *   - 已经有过 startSeq=0 的 kickoff 轮（done/stopped）→ 返回它，不重复开场；
 *   - 房间没有成员 / 没有 host → null（没什么可开场的）。
 *
 * 房间不存在抛 StoreError('ROOM_NOT_FOUND')；at 仅测试与调用方注入时钟用。
 */
export function openKickoffRound(store: Store, roomId: string, at: number = Date.now()): RoomRound | null {
  const detail = getRoomDetail(store, roomId)
  if (detail === null) throw new StoreError('ROOM_NOT_FOUND', `unknown room ${roomId}`)

  const existing = activeRound(store, roomId)
  if (existing !== null) return existing

  // kickoff 轮的 startSeq 固定为“建群时日志的最新 seq”，没有消息就是 0。
  // 已经有一轮 startSeq=0 的开场（哪怕已经跑完）就不再开第二轮。
  const previous = latestRound(store, roomId)
  if (previous !== null && previous.startSeq === 0) return previous

  const slots = kickoffSlots({
    ...(detail.extras.hostBotId === null ? {} : { hostBotId: detail.extras.hostBotId }),
    members: detail.members,
  })
  if (slots.length === 0) return null

  const messages = readMessages(store, { roomId, limit: 1000 })
  const startSeq = messages.length === 0 ? 0 : messages[messages.length - 1]!.seq

  const round = createRound({
    roomId,
    startSeq,
    slots,
    at,
  })
  saveRound(store, round)
  noteRoundOpened(store, round)
  return round
}
