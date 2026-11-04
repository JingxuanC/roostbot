// 轮次编排（控制面）：把「一条用户消息」变成「一轮 + 若干成员 prompt」，
// 并把成员的结果写回轮次状态。纯逻辑 + store，不含 HTTP。
//
// 事实源：docs/design/rooms.md §3/§4/§5、docs/build/m4-contract.md §4。
// 派发决策在控制面（可审计、可回放）；沙箱里的 room-agent 只是执行器。

import type { RoomRound, RoundAssignment, SlotResult } from '../../../contract/src/index.ts'
import { activeRound, botSession, getRound, markSeen, saveRound, seenSeq, setBotSession } from '../../../packages/store/src/rounds.ts'
import { getRoomDetail } from '../../../packages/store/src/rooms-ext.ts'
import { readMessages, sendMessage } from '../../../packages/store/src/rooms.ts'
import {
  advanceSlot,
  applyMentions,
  buildMemberPrompt,
  createRound,
  finishRound,
  nextSlot,
  openingSpeakers
} from '../../../packages/rooms/src/index.ts'
import type { Room, Store } from '../../../packages/store/src/types.ts'

/** 引擎与 prompt 需要的最小房间形状。 */
export interface EngineRoom {
  id: string
  name: string
  notice?: string
  replyMode?: Room['replyMode']
  responder?: ReturnType<typeof responderOf>
  hostBotId?: string
  members: Array<{ botId: string; role: 'host' | 'member'; name?: string }>
}

type RoomDetail = NonNullable<ReturnType<typeof getRoomDetail>>
type Responder = RoomDetail['extras']['responder']
function responderOf(detail: RoomDetail | null) {
  return detail?.extras.responder
}

function engineRoom(detail: RoomDetail): EngineRoom {
  const { room, extras, members } = detail
  return {
    id: room.id,
    name: room.name,
    ...(extras.notice === null ? {} : { notice: extras.notice }),
    replyMode: room.replyMode,
    members,
    responder: extras.responder,
    ...(extras.hostBotId === null ? {} : { hostBotId: extras.hostBotId })
  }
}

function detailOrThrow(store: Store, roomId: string): RoomDetail {
  const detail = getRoomDetail(store, roomId)
  if (detail === null) throw new Error(`unknown room ${roomId}`)
  return detail
}

/** 给 store 的 Room 补上扩展列与成员（API 返回房间详情时用）。 */
export function enrichRoom(store: Store, roomId: string): RoomDetail {
  return detailOrThrow(store, roomId)
}

export interface OpenRoundInput {
  store: Store
  room: Room
  /** 用户消息的 seq：轮次的起点。 */
  seq: number
  text: string
  at?: number
}

/**
 * 一条用户消息开启一轮。已有进行中的一轮时直接返回它（一次只跑一轮）；
 * 没有成员/没有发言人时返回 null，调用方不需要等结果。
 */
export function openRoundForMessage(input: OpenRoundInput): RoomRound | null {
  const existing = activeRound(input.store, input.room.id)
  if (existing !== null) return existing
  const detail = detailOrThrow(input.store, input.room.id)
  const engine = engineRoom(detail)
  if (engine.members.length === 0) return null
  const speakers = openingSpeakers(engine, { text: input.text })
  const slots = speakers.map((member: { botId: string; name?: string }) => ({
    botId: member.botId,
    ...(member.name === undefined ? {} : { name: member.name }),
    status: 'waiting' as const
  }))
  if (slots.length === 0) return null
  const round = createRound({
    roomId: input.room.id,
    startSeq: input.seq,
    slots,
    ...(input.at === undefined ? {} : { at: input.at })
  })
  saveRound(input.store, round)
  return round
}

/** 每个成员的会话 id：控制面存过的优先，否则用确定性约定。 */
export function sessionIdForMember(store: Store, roomId: string, botId: string): string {
  return botSession(store, roomId, botId) ?? `room-${roomId}-${botId}`
}

export function rememberSession(store: Store, roomId: string, botId: string, sessionId: string): void {
  setBotSession(store, roomId, botId, sessionId)
}

function lineOf(message: { actor: { kind: string; id: string }; text: string }): { who: string; text: string } {
  return { who: message.actor.kind === 'user' ? '用户' : message.actor.id, text: message.text }
}

/** 本轮所有还在等的 slot，按顺序给出可投递的指令。 */
export function assignmentsForRound(store: Store, roomId: string): RoundAssignment[] {
  const round = activeRound(store, roomId)
  if (round === null) return []
  const detail = detailOrThrow(store, roomId)
  const engine = engineRoom(detail)
  const messages = readMessages(store, { roomId, limit: 200 })
  const earlier = messages.filter((message) => message.seq < round.startSeq)
  const assignments: RoundAssignment[] = []
  round.slots.forEach((slot, index) => {
    if (slot.status !== 'waiting' && slot.status !== 'speaking') return
    const member = engine.members.find((candidate) => candidate.botId === slot.botId)
    if (member === undefined) return
    const seen = seenSeq(store, roomId, slot.botId)
    const unseen = messages.filter((message) => message.seq >= round.startSeq && message.seq > seen && message.botId !== slot.botId)
    const prompt = buildMemberPrompt({
      room: engine as never,
      member: { ...member, name: member.name ?? slot.name ?? member.botId } as never,
      round,
      earlier: earlier.slice(-8).map(lineOf),
      delta: unseen.slice(-24).map(lineOf),
      working: []
    })
    assignments.push({
      roundId: round.id,
      roomId,
      botId: slot.botId,
      sessionId: sessionIdForMember(store, roomId, slot.botId),
      prompt,
      index,
      total: round.slots.length
    })
  })
  return assignments
}

export interface AdvanceInput {
  store: Store
  roundId: string
  slotIndex: number
  result: SlotResult
  now?: number
}

/** 成员结果写回：推进 slot、处理 @ 调用、收轮。 */
export function applyAdvance(input: AdvanceInput): { round: RoomRound; next: number | null } {
  const current = getRound(input.store, input.roundId)
  if (current === null) throw new Error(`unknown round ${input.roundId}`)
  if (current.state !== 'running') return { round: current, next: null }
  const detail = detailOrThrow(input.store, current.roomId)
  const engine = engineRoom(detail)
  const speaker = current.slots[input.slotIndex]
  let next = advanceSlot(current, input.slotIndex, input.result)
  if (speaker !== undefined) {
    if (input.result.kind === 'posted' && input.result.text.trim() !== '') {
      // 成员的话进房间日志：idem 用轮次+slot，重投不会重复。
      sendMessage(input.store, {
        roomId: current.roomId,
        text: input.result.text,
        actor: { kind: 'bot', id: speaker.botId },
        idem: `round-${current.id}-slot-${input.slotIndex}`
      })
    }
    const latest = readMessages(input.store, { roomId: current.roomId, limit: 200 }).at(-1)
    if (latest !== undefined) markSeen(input.store, current.roomId, speaker.botId, latest.seq)
    if (input.result.kind === 'posted' && input.result.text.trim() !== '') {
      next = applyMentions(next, speaker.botId, input.result.text, {
        callerIsHost: engine.hostBotId === speaker.botId,
        members: engine.members,
        ...(engine.hostBotId === undefined ? {} : { hostBotId: engine.hostBotId })
      })
    }
  }
  const currentIndex = nextSlot(next)
  const finished = currentIndex === null ? finishRound(next, input.now === undefined ? {} : { at: input.now }) : next
  saveRound(input.store, finished)
  return { round: finished, next: currentIndex }
}
