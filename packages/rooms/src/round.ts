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

/**
 * 用户停止当前 slot 时写进 note 的文案。契约的 SlotStatus 没有 `stopped`
 * （docs/build/m4-addendum.md §D），所以状态落成已有的 `left`（“已离开”），
 * 用 note 标注是用户停止；不扩 contract。
 */
export const SLOT_STOP_NOTE = '用户停止'

/**
 * 停止一个 slot（用户点了“停止当前成员”）：waiting/speaking → left。
 * - 只动目标 slot，其它 slot 原样复用（同一轮里下一个人继续，docs/design/rooms.md §10）；
 * - 当前说话的 slot 被停时清掉 round.speaking；
 * - 被消费的 slot 计一次 turn，与 advanceSlot 口径一致（missed/failed 也计数）；
 * - 已经 posted/passed/... 的 slot、非 running 轮次、越界下标原样返回（幂等）。
 */
export function markSlotStopped(round: RoomRound, slotIndex: number): RoomRound {
  if (round.state !== 'running') return round
  if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= round.slots.length) return round
  const current = round.slots[slotIndex]
  if (current.status !== 'waiting' && current.status !== 'speaking') return round
  const note =
    current.note === undefined || current.note.trim() === '' ? SLOT_STOP_NOTE : `${current.note}；${SLOT_STOP_NOTE}`
  const slots = round.slots.map((slot, index) =>
    index === slotIndex ? { ...slot, status: 'left' as const, note } : slot
  )
  const next: RoomRound = { ...round, slots, turns: round.turns + 1 }
  // 只有停的正是“当前在说”的那个 slot 才清 speaking；同一成员还有别的 slot 在说时不动。
  if (current.status === 'speaking' && round.speaking === current.botId) delete next.speaking
  return next
}

/** classifyGrace 的判定：继续等 / 报 working（不阻塞轮次） / 记超时。 */
export type GraceVerdict = 'working' | 'timeout' | 'continue'

export interface GraceLimits {
  /** 单成员回复超时，默认 ROUND_LIMITS.replyTimeoutMs（240s）。 */
  replyTimeoutMs?: number
  /** 工作中宽限，默认 ROUND_LIMITS.workGraceMs（15s）。 */
  workGraceMs?: number
}

export interface GraceInput {
  /** 从投递 prompt 到现在的毫秒数。 */
  elapsedMs: number
  /** 该成员会话现在是否还在工作（session.status 是 working/审批等未结束状态）。 */
  working: boolean
  limits?: GraceLimits
}

/**
 * 宽限判定（docs/design/rooms.md §3：超时 240s，工作中宽限 15s）：
 * - `replyTimeoutMs` 以内 → `continue`：正常等结果；
 * - 到点仍在工作 → 再宽限 `workGraceMs`：这段窗口内仍返回 `continue`（等它收尾，
 *   晚到的结果还能按本轮结果处理）；
 * - 宽限期用完还在工作 → `working`：advance `{kind:'working'}`，轮次不阻塞，
 *   结果按 lateRounds 规则晚到回群；
 * - 到点已经不在工作（没有 idle/结果，会话掉线）→ `timeout`：按 missed 收尾。
 * `continue` 是“继续等”的判定，调用方在等结果的循环里用；不是“继续下一 slot”。
 */
export function classifyGrace(input: GraceInput): GraceVerdict {
  const replyTimeoutMs = positiveNumber(input.limits?.replyTimeoutMs) ?? ROUND_LIMITS.replyTimeoutMs
  const workGraceMs = nonNegativeNumber(input.limits?.workGraceMs) ?? ROUND_LIMITS.workGraceMs
  const elapsedMs =
    typeof input.elapsedMs === 'number' && Number.isFinite(input.elapsedMs) ? Math.max(0, input.elapsedMs) : 0
  if (elapsedMs < replyTimeoutMs) return 'continue'
  if (input.working !== true) return 'timeout'
  return elapsedMs < replyTimeoutMs + workGraceMs ? 'continue' : 'working'
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

export interface LateRoundOptions {
  /** 该轮之后又开了几轮（调用方算好的轮距）；省略时从 room.rounds 推断。 */
  lateRounds?: number
  /** 上限，默认 ROUND_LIMITS.lateRounds（10）。 */
  limit?: number
}

/** 判断晚到结果是否还允许回群所需的房间信息（真实的 Room 也结构兼容）。 */
export interface LateRoundRoom {
  id?: string
  /** 最近轮次（新的在后）；用来算轮距，省略时按同轮处理。 */
  rounds?: Array<{ id?: string }>
}

/**
 * 晚到的结果还能不能回群（docs/design/rooms.md §3：late rounds ≤ 10）。
 * 轮距 = `round` 之后又开了几轮：显式 `lateRounds` 优先，其次按 `room.rounds` 的位置差推断；
 * 房间带了轮次列表但这轮已经不在列表里（太旧）→ 不允许。
 * 跨房间的轮次一律不允许。返回 true 只表示“轮距还在上限内”，是否真的落库由调用方决定。
 */
export function lateRoundAllowed(
  room: LateRoundRoom | null | undefined,
  round: Pick<RoomRound, 'id' | 'roomId'> | null | undefined,
  options: LateRoundOptions = {}
): boolean {
  if (room === null || room === undefined || round === null || round === undefined) return false
  const roomId = typeof room.id === 'string' && room.id !== '' ? room.id : undefined
  const roundRoomId = typeof round.roomId === 'string' && round.roomId !== '' ? round.roomId : undefined
  if (roomId !== undefined && roundRoomId !== undefined && roomId !== roundRoomId) return false
  const limit = nonNegativeInteger(options.limit) ?? ROUND_LIMITS.lateRounds
  const explicit = nonNegativeInteger(options.lateRounds)
  if (explicit !== undefined) return explicit <= limit
  const rounds = Array.isArray(room.rounds) ? room.rounds : []
  if (rounds.length === 0) return true
  const index = rounds.findIndex(item => item?.id === round.id)
  if (index === -1) return false
  return rounds.length - 1 - index <= limit
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
  const pending = round.slots.some(
    slot => slot.status === 'waiting' || slot.status === 'speaking' || slot.status === 'needs_input'
  )
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
    case 'needs_input':
      return `${name}（在等你选择）`
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
