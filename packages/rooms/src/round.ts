// 轮次：一条用户消息 = 一轮；slots 串行发言，@ 可以把人提前或再给一次 turn。
// 纯逻辑，不做 I/O（docs/design/rooms.md §3、§4；契约见 docs/build/m4-contract.md §4）。

import { randomUUID } from 'node:crypto'

import { ROUND_LIMITS, type RoomMember, type RoomRound, type RoundSlot, type SlotResult } from '../../contract/src/index.ts'
import { displayName, parseMentions } from './responder.ts'

/** 回复分类：去空白后正好是 [PASS] 才算静默。 */
export type ReplyClassification = { kind: 'passed' } | { kind: 'posted'; text: string }

// [PASS] 允许中英文方括号和大小写；裸写 pass 不算（避免把 "pass" 当静默吞掉）。
const PASS_LIKE = /^[[【]\s*pass\s*[\]】]$/i

export function classifyReply(text: string): ReplyClassification {
  const raw = typeof text === 'string' ? text : ''
  return PASS_LIKE.test(raw.trim()) ? { kind: 'passed' } : { kind: 'posted', text: raw }
}

export interface RoundSlotInput {
  botId: string
  name?: string
  status?: RoundSlot['status']
  note?: string
  by?: string
}

export interface CreateRoundInput {
  roomId: string
  startSeq: number
  slots: RoundSlotInput[]
  /** 创建时间，默认 Date.now()；测试传固定值。 */
  at?: number
  /** 轮次 id，默认 rnd_<uuid>；重放/测试可传固定值。 */
  id?: string
}

/** 开一轮：slots 依次进入 waiting，state=running。 */
export function createRound(input: CreateRoundInput): RoomRound {
  const at = input.at ?? Date.now()
  const slots: RoundSlot[] = (input.slots ?? []).map(slot => ({
    botId: slot.botId,
    ...(slot.name === undefined ? {} : { name: slot.name }),
    status: slot.status ?? 'waiting',
    ...(slot.note === undefined ? {} : { note: slot.note }),
    ...(slot.by === undefined ? {} : { by: slot.by })
  }))
  return {
    id: input.id ?? `rnd_${randomUUID()}`,
    roomId: input.roomId,
    startSeq: input.startSeq,
    state: 'running',
    slots,
    turns: 0,
    startedAt: at
  }
}

/** SlotResult.kind → slot.status 的映射（approval 落成契约里的 waiting-approval）。 */
export const SLOT_STATUS_BY_RESULT = {
  posted: 'posted',
  passed: 'passed',
  failed: 'failed',
  missed: 'missed',
  working: 'working',
  approval: 'waiting-approval'
} as const

export type AdvanceableResultKind = keyof typeof SLOT_STATUS_BY_RESULT

const isSpoken = (slot: RoundSlot): boolean => slot.status !== 'waiting'

/** 某成员本轮已经用掉的发言次数（已经处理过或正在说的 slot，不含排队中的）。 */
export function spokenTurns(round: Pick<RoomRound, 'slots'>, botId: string): number {
  return round.slots.filter(slot => slot.botId === botId && isSpoken(slot)).length
}

/**
 * 本轮总 turn 上限：每个成员按 perMemberTurns 计，再加两份额外 turn 预算。
 * 这是兜底阀（防 @ 风暴与失控轮次），正常轮次远达不到；按“出现过的人”算，
 * 所以插入的额外 slot 不会把上限一起抬高。
 */
export function turnLimit(round: Pick<RoomRound, 'slots'>): number {
  const members = new Set(round.slots.map(slot => slot.botId)).size
  return Math.max(1, members) * ROUND_LIMITS.perMemberTurns + ROUND_LIMITS.extraTurns + ROUND_LIMITS.hostExtraTurns
}

/** 本轮第一个还在 waiting 的 slot 下标；没有（或轮次已结束）返回 null。 */
export function nextSlot(round: Pick<RoomRound, 'state' | 'slots'>): number | null {
  if (round.state !== 'running') return null
  const index = round.slots.findIndex(slot => slot.status === 'waiting')
  return index === -1 ? null : index
}

/**
 * 开始一个 slot：waiting → speaking，并记下 round.speaking。
 * 纯逻辑，调用方（控制面/runtime）在投递 prompt 前调它；不占 turns，turns 在结果回来时 +1。
 */
export function startSlot(round: RoomRound, slotIndex: number): RoomRound {
  if (round.state !== 'running') return round
  if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= round.slots.length) return round
  const slot = round.slots[slotIndex]
  if (slot.status !== 'waiting') return round
  const slots = round.slots.map((current, index) => (index === slotIndex ? { ...current, status: 'speaking' as const } : current))
  return { ...round, slots, speaking: slot.botId }
}

/** 当前说话人所在 slot 的下标；没标 speaking 时退回它最后一个已处理的 slot。 */
function currentSlotIndex(slots: RoundSlot[], speakerId: string): number {
  const speaking = slots.findIndex(slot => slot.botId === speakerId && slot.status === 'speaking')
  if (speaking !== -1) return speaking
  for (let index = slots.length - 1; index >= 0; index -= 1) {
    if (slots[index].botId === speakerId && slots[index].status !== 'waiting') return index
  }
  for (let index = slots.length - 1; index >= 0; index -= 1) {
    if (slots[index].status !== 'waiting') return index
  }
  return -1
}

export interface ApplyMentionsOptions {
  /** 说话的人是不是 host：决定 @all 是否生效、以及额外 turn 预算用哪一档。 */
  callerIsHost?: boolean
  /** 房间全量成员。省略时只能从本轮 slots 推断，member 模式下没进 slots 的人就 @ 不到。 */
  members?: RoomMember[]
  /** 没标 host 成员时的 host id，用于判断被 @ 的人该用 hostTurns 还是 perMemberTurns。 */
  hostBotId?: string
  /** 插进去的 slot 的备注，默认 `被 @ 叫到`。 */
  note?: string
}

/**
 * 把回复里被 @ 的成员插到当前 slot 之后：
 * - 它还在后面排队 → 抽出来提前（不额外消耗 turn 预算）；
 * - 它已经说过 → 在名额允许时给一次额外 turn（消耗本轮额外 turn 预算）；
 * - 超过 perMemberTurns/hostTurns、或本轮额外预算用完 → 忽略。
 * 非 host 的 `@all` 忽略；host 的 `@all` 展开为其他全部成员（被点名的在前）。
 * 返回新 round，不改入参。
 */
export function applyMentions(
  round: RoomRound,
  speaker: string | Pick<RoomMember, 'botId' | 'name'>,
  text: string,
  options: ApplyMentionsOptions = {}
): RoomRound {
  const speakerId = typeof speaker === 'string' ? speaker : speaker.botId
  const callerIsHost = options.callerIsHost === true
  const roster = new Map<string, RoomMember>()
  const roleOf = (botId: string): 'host' | 'member' => {
    if (botId === options.hostBotId) return 'host'
    return options.members?.find(member => member.botId === botId)?.role ?? 'member'
  }
  for (const slot of round.slots) {
    if (roster.has(slot.botId)) continue
    const member: RoomMember = { botId: slot.botId, role: roleOf(slot.botId) }
    if (slot.name !== undefined) member.name = slot.name
    roster.set(slot.botId, member)
  }
  for (const member of options.members ?? []) {
    const existing = roster.get(member.botId)
    const merged: RoomMember = { botId: member.botId, role: member.role ?? existing?.role ?? 'member' }
    const name = member.name ?? existing?.name
    if (name !== undefined) merged.name = name
    roster.set(member.botId, merged)
  }
  const candidates = [...roster.values()]
  const parsed = parseMentions(text, candidates, { callerIsHost })
  const named = parsed.members.filter(member => member.botId !== speakerId)
  const callees = parsed.all
    ? [...named, ...candidates.filter(member => member.botId !== speakerId && !named.some(hit => hit.botId === member.botId))]
    : named

  const slots = round.slots.map(slot => ({ ...slot }))
  if (callees.length === 0) return { ...round, slots }
  const anchor = currentSlotIndex(slots, speakerId)
  let next = anchor + 1
  let budget = callerIsHost ? ROUND_LIMITS.hostExtraTurns : ROUND_LIMITS.extraTurns
  const note = options.note ?? '被 @ 叫到'
  for (const callee of callees) {
    const limit = callee.role === 'host' ? ROUND_LIMITS.hostTurns : ROUND_LIMITS.perMemberTurns
    if (spokenTurns({ slots }, callee.botId) >= limit) continue
    const queuedAt = slots.findIndex((slot, index) => index > anchor && slot.botId === callee.botId && slot.status === 'waiting')
    if (queuedAt !== -1) {
      const [moved] = slots.splice(queuedAt, 1)
      if (queuedAt < next) next -= 1
      moved.by = speakerId
      moved.note = note
      slots.splice(next, 0, moved)
      next += 1
      continue
    }
    if (budget <= 0) continue
    const slot: RoundSlot = { botId: callee.botId, status: 'waiting', by: speakerId, note }
    if (callee.name !== undefined) slot.name = callee.name
    slots.splice(next, 0, slot)
    next += 1
    budget -= 1
  }
  return { ...round, slots }
}

/**
 * 报告一个 slot 的结果并更新状态：
 * posted/passed/failed/missed/working/approval → 对应状态（approval 落成 waiting-approval）。
 * 不可变；下标越界或结果不认识的 kind 原样返回。turns 只在该 slot 真的被推进时 +1，
 * 重复上报同一个 slot 不会重复计数。
 */
export function advanceSlot(round: RoomRound, slotIndex: number, result: SlotResult): RoomRound {
  if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= round.slots.length) return round
  const status = SLOT_STATUS_BY_RESULT[result.kind as AdvanceableResultKind]
  if (status === undefined) return round
  const current = round.slots[slotIndex]
  const counted = current.status === 'waiting' || current.status === 'speaking'
  const slots = round.slots.map((slot, index) => (index === slotIndex ? { ...slot, status } : slot))
  const speaking = round.speaking === current.botId ? undefined : round.speaking
  const next: RoomRound = { ...round, slots, turns: round.turns + (counted ? 1 : 0) }
  if (speaking === undefined) delete next.speaking
  else next.speaking = speaking
  return next
}

export interface FinishRoundOptions {
  /** 用户/系统停止本轮：state=stopped。 */
  stopped?: boolean
  at?: number
}

/**
 * 收轮：显式停止 → stopped；否则所有 slot 都结束（没有 waiting/speaking）或
 * turns 达到 turnLimit → done；否则原样返回（还在跑）。
 * 已在 done/stopped 的轮次幂等返回。
 */
export function finishRound(round: RoomRound, options: FinishRoundOptions = {}): RoomRound {
  if (round.state !== 'running') return round
  const stopped = options.stopped === true
  const pending = round.slots.some(slot => slot.status === 'waiting' || slot.status === 'speaking')
  if (!stopped && pending && round.turns < turnLimit(round)) return round
  const next: RoomRound = {
    ...round,
    state: stopped ? 'stopped' : 'done',
    endedAt: options.at ?? Date.now()
  }
  delete next.speaking
  return next
}

/** 一个 slot 的展示标签（prompt 的发言顺序用；也方便 UI 复用）。 */
export function slotLabel(slot: RoundSlot): string {
  const name = slot.name ?? slot.botId
  switch (slot.status) {
    case 'speaking':
      return `${name}（现在在说）`
    case 'posted':
      return `${name}（已发言）`
    case 'passed':
      return `${name}（静默）`
    case 'missed':
      return `${name}（没有回答）`
    case 'working':
      return `${name}（在做事，完成后发）`
    case 'waiting-approval':
      return `${name}（等用户批准，完成后发）`
    case 'failed':
      return `${name}（失败了）`
    case 'left':
      return `${name}（已离开）`
    default:
      return `${name}（等待）`
  }
}

/** 便于测试/调用方拿名字；slot 上没存名字时退回 botId。 */
export const slotName = (slot: RoundSlot): string => displayName({ botId: slot.botId, name: slot.name })
