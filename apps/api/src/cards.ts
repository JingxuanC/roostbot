// 房间里的选项卡 / 审批卡（docs/design/architecture-v2.md §6）。
//
// 卡片是 chat.message 的一个 part，不是第二张消息表。
// 审批决策仍走 approvals 表和 POST /api/approvals/:id。
// 等人的时候 slot 记 needs_input，进程重启后 activeRound 还能读到。

import type { RoomRound } from '../../../packages/contract/src/index.ts'
import { createApproval, getApproval } from '../../../packages/store/src/approvals.ts'
import type { Approval } from '../../../packages/store/src/approvals.ts'
import { newRoostId } from '../../../packages/store/src/ids.ts'
import { appendRoomSignal, readRoomEvents } from '../../../packages/store/src/room-log.ts'
import { getRoom, sendMessage } from '../../../packages/store/src/rooms.ts'
import { activeRound, saveRound } from '../../../packages/store/src/rounds.ts'
import type { MessagePart, RoomMessage, Store } from '../../../packages/store/src/types.ts'
import { openRoundForMessage } from './round-orchestrator.ts'
import { noteRoundAdvanced } from './round-signals.ts'

export interface ChoiceOption {
  id: string
  label: string
}

export interface ChoiceCardInput {
  type: 'choice'
  prompt?: string
  options: ChoiceOption[]
}

export interface ApprovalCardInput {
  type: 'approval'
  title?: string
  kind?: string
  action?: string
  target?: string
  consequence?: string
}

export type CardInput = ChoiceCardInput | ApprovalCardInput

export interface PostCardInput {
  store: Store
  roomId: string
  botId: string
  text?: string
  card: CardInput
  at?: number
}

export interface PostCardResult {
  message: RoomMessage
  cardId: string
  approvalId?: string
  round: RoomRound | null
}

export interface AnswerCardInput {
  store: Store
  roomId: string
  cardId: string
  optionId: string
  accountId: string
  at?: number
}

export interface AnswerCardResult {
  optionId: string
  label: string
  message: RoomMessage
  round: RoomRound | null
  alreadyAnswered: boolean
}

interface FoundChoice {
  seq: number
  prompt: string
  options: ChoiceOption[]
}

function asOptions(value: unknown): ChoiceOption[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > 8) {
    throw new Error('card.options must contain 2..8 options')
  }
  const seen = new Set<string>()
  return value.map((option, index) => {
    if (option === null || typeof option !== 'object') throw new Error(`card.options[${index}] must be an object`)
    const record = option as { id?: unknown; label?: unknown }
    const id = typeof record.id === 'string' ? record.id.trim() : ''
    const label = typeof record.label === 'string' ? record.label.trim() : ''
    if (id === '' || id.length > 32 || label === '' || label.length > 80) {
      throw new Error(`card.options[${index}] needs an id and a label`)
    }
    if (seen.has(id)) throw new Error(`card.options[${index}].id is duplicated`)
    seen.add(id)
    return { id, label }
  })
}

export function parseCard(value: unknown): CardInput {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('card must be an object')
  }
  const record = value as Record<string, unknown>
  if (record.type === 'choice') {
    return { type: 'choice', ...(typeof record.prompt === 'string' ? { prompt: record.prompt.trim() } : {}), options: asOptions(record.options) }
  }
  if (record.type === 'approval') {
    const text = (key: string, max: number): string | undefined => {
      const raw = record[key]
      if (raw === undefined || raw === null) return undefined
      if (typeof raw !== 'string') throw new Error(`card.${key} must be a string`)
      const trimmed = raw.trim()
      if (trimmed.length > max) throw new Error(`card.${key} is too long`)
      return trimmed === '' ? undefined : trimmed
    }
    return {
      type: 'approval',
      ...(text('title', 120) === undefined ? {} : { title: text('title', 120) }),
      ...(text('kind', 64) === undefined ? {} : { kind: text('kind', 64) }),
      ...(text('action', 200) === undefined ? {} : { action: text('action', 200) }),
      ...(text('target', 200) === undefined ? {} : { target: text('target', 200) }),
      ...(text('consequence', 400) === undefined ? {} : { consequence: text('consequence', 400) }),
    }
  }
  throw new Error('card.type must be choice or approval')
}

function findChoice(store: Store, roomId: string, cardId: string): FoundChoice | null {
  const events = readRoomEvents(store, { roomId, afterSeq: 0, limit: 1000 })
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!
    if (event.kind !== 'chat.message' || !Array.isArray(event.payload.parts)) continue
    for (const part of event.payload.parts) {
      if (part === null || typeof part !== 'object') continue
      const record = part as MessagePart
      if (record.type === 'choice' && record.cardId === cardId && Array.isArray(record.options)) {
        return {
          seq: event.seq,
          prompt: typeof record.prompt === 'string' ? record.prompt : '',
          options: record.options.filter((option) => typeof option?.id === 'string' && typeof option?.label === 'string'),
        }
      }
    }
  }
  return null
}

function existingAnswer(store: Store, roomId: string, cardId: string): { optionId: string; label: string } | null {
  const events = readRoomEvents(store, { roomId, afterSeq: 0, limit: 1000 })
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!
    if (event.kind !== 'chat.card.answered') continue
    if (event.payload.cardId !== cardId) continue
    const optionId = typeof event.payload.optionId === 'string' ? event.payload.optionId : ''
    const label = typeof event.payload.label === 'string' ? event.payload.label : ''
    if (optionId === '') continue
    return { optionId, label }
  }
  return null
}

/** 把等这张卡的 slot 从 needs_input 放回 waiting。没有进行中的轮次就返回 null。 */
export function resumeParkedSlot(store: Store, roomId: string, awaitingId: string): RoomRound | null {
  const round = activeRound(store, roomId)
  if (round === null) return null
  let changed = false
  const slots = round.slots.map((slot) => {
    if (slot.status !== 'needs_input' || slot.awaiting?.id !== awaitingId) return slot
    changed = true
    const next = { ...slot, status: 'waiting' as const }
    delete next.awaiting
    return next
  })
  if (!changed) return round
  const updated = { ...round, slots }
  saveRound(store, updated)
  noteRoundAdvanced(store, round, updated)
  return updated
}

function parkSlot(store: Store, roomId: string, botId: string, awaiting: { kind: 'choice' | 'approval'; id: string }): RoomRound | null {
  const round = activeRound(store, roomId)
  if (round === null) return null
  const index = round.slots.findIndex(
    (slot) => slot.botId === botId && (slot.status === 'waiting' || slot.status === 'speaking' || slot.status === 'needs_input'),
  )
  if (index < 0) return round
  const slots = round.slots.map((slot, slotIndex) =>
    slotIndex === index ? { ...slot, status: 'needs_input' as const, awaiting } : slot,
  )
  const updated: RoomRound = { ...round, slots }
  delete updated.speaking
  saveRound(store, updated)
  return updated
}

/** Bot 发一张卡，并把进行中的轮次停在 needs_input。 */
export function postCard(input: PostCardInput): PostCardResult {
  const room = getRoom(input.store, input.roomId)
  if (room === null) throw new Error(`unknown room ${input.roomId}`)
  const card = input.card
  const textFromCaller = typeof input.text === 'string' ? input.text.trim() : ''
  let cardId = ''
  let approvalId: string | undefined
  let parts: MessagePart[] = []
  let text = textFromCaller

  if (card.type === 'choice') {
    cardId = newRoostId('crd', input.at)
    const prompt = card.prompt && card.prompt !== '' ? card.prompt : text
    if (prompt === '') throw new Error('choice card needs a prompt or text')
    if (text === '') text = prompt
    parts = [
      { type: 'text', text },
      { type: 'choice', cardId, prompt, options: card.options },
    ]
  } else {
    const prompt = card.title && card.title !== '' ? card.title : text
    if (prompt === '') throw new Error('approval card needs a title or text')
    if (text === '') text = prompt
    const approval: Approval = createApproval(input.store, {
      workspaceId: room.workspaceId,
      kind: card.kind ?? 'room.card',
      requester: input.botId,
      requesterKind: 'bot',
      action: card.action ?? null,
      target: card.target ?? null,
      consequence: card.consequence ?? null,
      payload: { roomId: input.roomId, source: 'room-card', title: prompt },
      ...(input.at === undefined ? {} : { at: input.at }),
    })
    approvalId = approval.id
    cardId = approval.id
    parts = [
      { type: 'text', text },
      {
        type: 'approval',
        approvalId: approval.id,
        title: prompt,
        ...(card.action === undefined ? {} : { action: card.action }),
        ...(card.target === undefined ? {} : { target: card.target }),
        ...(card.consequence === undefined ? {} : { consequence: card.consequence }),
        status: 'pending',
      },
    ]
    appendRoomSignal(input.store, {
      roomId: input.roomId,
      domain: 'approval',
      kind: 'approval.requested',
      actor: { kind: 'bot', id: input.botId },
      idem: `room-approval:${approval.id}:requested`,
      payload: { approvalId: approval.id, title: prompt },
    })
  }

  const message = sendMessage(input.store, {
    roomId: input.roomId,
    text,
    actor: { kind: 'bot', id: input.botId },
    parts,
    idem: `card:${cardId}:message`,
    ...(input.at === undefined ? {} : { at: input.at }),
  })
  const round = parkSlot(input.store, input.roomId, input.botId, {
    kind: card.type === 'choice' ? 'choice' : 'approval',
    id: cardId,
  })
  return { message, cardId, ...(approvalId === undefined ? {} : { approvalId }), round }
}

/** 把已经落库的审批（例如沙箱 tool.call）投影成房间里的审批卡，不重复建审批。 */
export function postApprovalCardMessage(
  store: Store,
  input: { roomId: string; botId: string; approval: Approval; title: string; action?: string | null; target?: string | null; consequence?: string | null; at?: number },
): RoomMessage {
  const text = input.title.trim() === '' ? '需要你确认' : input.title.trim()
  const part: MessagePart = {
    type: 'approval',
    approvalId: input.approval.id,
    title: text,
    ...(typeof input.action === 'string' && input.action !== '' ? { action: input.action } : {}),
    ...(typeof input.target === 'string' && input.target !== '' ? { target: input.target } : {}),
    ...(typeof input.consequence === 'string' && input.consequence !== '' ? { consequence: input.consequence } : {}),
    status: 'pending',
  }
  return sendMessage(store, {
    roomId: input.roomId,
    text,
    actor: { kind: 'bot', id: input.botId },
    parts: [{ type: 'text', text }, part],
    idem: `approval-card:${input.approval.id}`,
    ...(input.at === undefined ? {} : { at: input.at }),
  })
}

/** 用户点选。幂等：同一张卡再点一次返回第一次的选项。 */
export function answerChoiceCard(input: AnswerCardInput): AnswerCardResult {
  const found = findChoice(input.store, input.roomId, input.cardId)
  if (found === null) throw new Error(`unknown card ${input.cardId}`)
  const prior = existingAnswer(input.store, input.roomId, input.cardId)
  if (prior !== null) {
    const messages = readRoomEvents(input.store, { roomId: input.roomId, afterSeq: 0, limit: 1000 })
    const messageEvent = [...messages].reverse().find((event) => event.idem === `card:${input.cardId}:answer-message`)
    const message: RoomMessage = {
      seq: messageEvent?.seq ?? found.seq,
      at: messageEvent?.at ?? new Date(input.at ?? Date.now()).toISOString(),
      actor: { kind: 'user', id: input.accountId },
      roomId: input.roomId,
      text: prior.label,
    }
    return { ...prior, message, round: activeRound(input.store, input.roomId), alreadyAnswered: true }
  }
  const option = found.options.find((item) => item.id === input.optionId)
  if (option === undefined) throw new Error(`unknown option ${input.optionId}`)

  const message = sendMessage(input.store, {
    roomId: input.roomId,
    text: option.label,
    actor: { kind: 'user', id: input.accountId },
    idem: `card:${input.cardId}:answer-message`,
    ...(input.at === undefined ? {} : { at: input.at }),
  })
  appendRoomSignal(input.store, {
    roomId: input.roomId,
    domain: 'chat',
    kind: 'chat.card.answered',
    actor: { kind: 'user', id: input.accountId },
    parent: found.seq,
    idem: `card:${input.cardId}:answered`,
    payload: { cardId: input.cardId, optionId: option.id, label: option.label },
    ...(input.at === undefined ? {} : { at: new Date(input.at).toISOString() }),
  })
  const resumed = resumeParkedSlot(input.store, input.roomId, input.cardId)
  let round = resumed
  if (activeRound(input.store, input.roomId) === null) {
    const room = getRoom(input.store, input.roomId)
    if (room !== null) {
      round = openRoundForMessage({
        store: input.store,
        room,
        seq: message.seq,
        text: message.text,
        ...(input.at === undefined ? {} : { at: input.at }),
      })
    }
  }
  return { optionId: option.id, label: option.label, message, round, alreadyAnswered: false }
}

/** 审批落定后：把房间投影补上，并放开等这张审批的 slot。 */
export function projectApprovalDecision(store: Store, approval: Approval, decision: 'approved' | 'rejected', by: string): void {
  if (approval.payload.source !== 'room-card') return
  const roomId = typeof approval.payload.roomId === 'string' ? approval.payload.roomId : ''
  if (roomId === '') return
  appendRoomSignal(store, {
    roomId,
    domain: 'approval',
    kind: 'approval.decided',
    actor: { kind: 'user', id: by },
    idem: `room-approval:${approval.id}:decided`,
    payload: { approvalId: approval.id, decision },
  })
  resumeParkedSlot(store, roomId, approval.id)
}

export function answerMap(store: Store, roomId: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const event of readRoomEvents(store, { roomId, afterSeq: 0, limit: 1000 })) {
    if (event.kind !== 'chat.card.answered') continue
    const cardId = typeof event.payload.cardId === 'string' ? event.payload.cardId : ''
    const optionId = typeof event.payload.optionId === 'string' ? event.payload.optionId : ''
    if (cardId !== '' && optionId !== '') map.set(cardId, optionId)
  }
  return map
}

/** 读模型：选项卡补上已选选项，审批卡补上 approvals 表里的状态。 */
export function decorateParts(store: Store, roomId: string, parts: MessagePart[] | undefined): MessagePart[] | undefined {
  if (parts === undefined || parts.length === 0) return parts
  const answers = answerMap(store, roomId)
  return parts.map((part) => {
    if (part.type === 'choice' && typeof part.cardId === 'string' && answers.has(part.cardId)) {
      return { ...part, selectedOptionId: answers.get(part.cardId) }
    }
    if (part.type === 'approval' && typeof part.approvalId === 'string') {
      const approval = getApproval(store, part.approvalId)
      if (approval !== null) return { ...part, status: approval.status }
    }
    return part
  })
}
