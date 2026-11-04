// 每个成员每轮看到的 prompt：按 docs/design/rooms.md §5 的 9 段装配。
// 纯字符串拼装，不做 I/O；上下文条数上限一律取自 ROUND_LIMITS / ROOM_LIMITS。

import { ROOM_LIMITS, ROUND_LIMITS, type Room, type RoomMember, type RoomRound, type RoundSlot } from '../../contract/src/index.ts'
import { displayName, isHostMember } from './responder.ts'
import { slotLabel, slotName } from './round.ts'

export type PromptLineKind =
  | 'message'
  | 'lookup'
  | 'failed'
  | 'working'
  | 'approval'
  | 'missed'
  | 'stopped'
  | 'done'
  | 'left'
  | 'system'

/** 群日志的一行（apps/runtime 从 events 投影出来时只填需要的字段）。 */
export interface PromptLine {
  who?: string
  botId?: string
  text?: string
  kind?: PromptLineKind
  seq?: number
}

export type WorkingMember = string | { name: string; minutes?: number }
export type PromptReference = string | { label?: string; text: string }

export interface BuildMemberPromptInput {
  room: Room
  member: RoomMember
  round: RoomRound
  /** 本轮增量（最早在前），最多 deltaMax 条。 */
  delta?: PromptLine[]
  /** 本轮之前的上下文（最早在前），最多 earlierMax 条。 */
  earlier?: PromptLine[]
  /** 谁还在做事。 */
  working?: WorkingMember[]
  /** 覆盖 room.notice（运行时可以传组装好的公告）。 */
  notice?: string
  /** 用户在本轮引用的会话/文件。 */
  references?: PromptReference[]
}

export interface BuildKickoffPromptInput {
  room: Room
  member: RoomMember
}

const LINE_TEXT_MAX = 4000

const cut = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max)}…（截断）`)

/** 一行日志的展示形式；状态行显式说出来，不假装成员没说话。 */
export function formatLine(line: PromptLine): string {
  const rawWho = (line.who ?? '').trim()
  const who = rawWho === '' ? (line.botId ?? '用户') : rawWho
  const text = cut((line.text ?? '').trim(), LINE_TEXT_MAX)
  switch (line.kind) {
    case 'lookup':
      return `[${who} 查了自己的私聊${text === '' ? '' : `：${text}`}]`
    case 'failed':
      return `[${who} 回答失败${text === '' ? '' : `：${text}`}]`
    case 'working':
      return `[${who} 还在做事，完成后会发到群里]`
    case 'approval':
      return `[${who} 在等用户批准，完成后会发到群里]`
    case 'missed':
      return `[${who} 没有回答]`
    case 'stopped':
      return `[用户停止了 ${who} 的工作]`
    case 'done':
      return `[${who} 完成了被要求的工作]`
    case 'left':
      return `[${who} 离开了这个群]`
    case 'system':
      return `[${text}]`
    default:
      return `${who}：${text}`
  }
}

const transcript = (lines: PromptLine[]): string => lines.map(formatLine).join('\n')

const workingLabel = (member: WorkingMember): string =>
  typeof member === 'string' ? member : (typeof member.minutes === 'number' ? `${member.name}（约 ${member.minutes} 分钟）` : member.name)

/** 第 1 段：成员清单 + 谁是 host + @ 的语义。 */
function membersSection(room: Room, member: RoomMember): string {
  const hostId = room.hostBotId
  const others = (room.members ?? []).filter(other => other.botId !== member.botId)
  const people = ['用户']
  for (const other of others) {
    people.push(`${displayName(other)}${isHostMember(other, hostId) ? '（host）' : ''}`)
  }
  const self = `${displayName(member)}${isHostMember(member, hostId) ? '，host' : ''}`
  return `群成员：${people.join('、')}，还有你（${self}）。一次只有一个人发言，每条消息都在下一个发言者开始前进入共享日志；写“@名字”会叫那个成员接着回答或做事，只想提到某人时不要加 @。`
}

/** 第 3 段：host 附加说明。 */
const HOST_NOTE =
  '你是这个群的 host（主持人）：普通消息由你接住，需要谁回答就用 @ 叫它；只有你的“@all”能叫全员，其他成员不能。群设置改动用工具做，不要在群里讨论。'

/** 第 9 段：行为指令，含 [PASS]。 */
export const BEHAVIOR_INSTRUCTIONS = [
  '行为要求：',
  '- 直接写要发到群里的话，不要加“名字：”前缀，也不要复述上面的上下文。',
  '- 一次只发一条短消息。讨论时一两句；用户要求做事就现在用工具做完，把结果发出来，不要只承诺“稍后”。',
  '- 没有新信息、或这条消息是给别人的：整条回复只写 [PASS]，不要写其他内容。',
  '- 写“@名字”会叫那个成员接着发言；只有 host 的“@all”能叫全员。'
].join('\n')

/** 自己在本轮 slots 里的位置：优先正在说/正在等自己的 slot。 */
function memberSlotIndex(round: RoomRound, botId: string): number {
  const speaking = round.slots.findIndex(slot => slot.botId === botId && slot.status === 'speaking')
  if (speaking !== -1) return speaking
  const waiting = round.slots.findIndex(slot => slot.botId === botId && slot.status === 'waiting')
  if (waiting !== -1) return waiting
  for (let index = round.slots.length - 1; index >= 0; index -= 1) {
    if (round.slots[index].botId === botId) return index
  }
  return -1
}

const orderLabel = (slot: RoundSlot, index: number, selfIndex: number): string =>
  index === selfIndex ? `${slotName(slot)}（你，现在）` : slotLabel(slot)

/** 第 8 段：发言顺序 + 自己是第几个。 */
function orderSection(round: RoomRound, member: RoomMember): string {
  const selfIndex = memberSlotIndex(round, member.botId)
  const order = round.slots.map((slot, index) => orderLabel(slot, index, selfIndex)).join(' → ')
  const header = `本轮发言顺序：${order === '' ? '（还没有人排队）' : order}`
  if (selfIndex === -1) return `${header}\n你不在本轮的发言队列里；之后的成员 @ 你时你会有机会发言。`
  const before = selfIndex
  const after = round.slots.length - selfIndex - 1
  const position = `你是第 ${selfIndex + 1} 个，共 ${round.slots.length} 个；前面 ${before} 人${before === 0 ? '（你是第一个）' : '已经说过'}，后面 ${after} 人${after === 0 ? '（你是最后一个）' : '会在你之后看到你的消息'}。`
  return `${header}\n${position}`
}

/**
 * 一个成员这一轮的 prompt，按 §5 的 9 段组装：
 * 成员清单/host → 公告 → host 说明 → 更早上下文 → 本轮增量 → 引用 → 谁在工作
 * → 发言顺序与位置 → 行为指令（含 [PASS]）。
 * 空段落省略，但第 1、8、9 段始终在（顺序与位置即使为空也会说明）。
 */
export function buildMemberPrompt(input: BuildMemberPromptInput): string {
  const { room, member, round } = input
  const isHost = isHostMember(member, room.hostBotId)
  const notice = cut(((input.notice ?? room.notice) ?? '').trim(), ROOM_LIMITS.noticeMax)
  const earlier = (input.earlier ?? []).slice(-ROUND_LIMITS.earlierMax)
  const delta = (input.delta ?? []).slice(-ROUND_LIMITS.deltaMax)
  const working = (input.working ?? []).map(workingLabel).filter(label => label.trim() !== '')
  const references = input.references ?? []
  const sections: string[] = []

  sections.push(membersSection(room, member))
  if (notice !== '') sections.push(`群公告（所有成员共同遵守）：\n${notice}`)
  if (isHost) sections.push(HOST_NOTE)
  if (earlier.length > 0) sections.push(`更早的群聊（本轮之前，只作背景，不要接着回答）：\n${transcript(earlier)}`)
  sections.push(delta.length > 0
    ? `本轮到目前为止（最早在前）：\n${transcript(delta)}`
    : '本轮到目前为止还没有新消息。')
  if (references.length > 0) {
    const lines = references.map((reference) => {
      if (typeof reference === 'string') return reference
      return `${reference.label === undefined ? '' : `【${reference.label}】`}${reference.text}`
    })
    sections.push(`用户在本轮引用的内容：\n${lines.join('\n\n')}`)
  }
  if (working.length > 0) sections.push(`还在做事、完成后会自己发到群里：${working.join('、')}。`)
  sections.push(orderSection(round, member))
  sections.push(BEHAVIOR_INSTRUCTIONS)
  return sections.join('\n\n')
}

/**
 * 建群后没有第一句话时，host 的开场：自我介绍一句 + 问“这个群要做什么”。
 * 与普通成员 prompt 一样先给成员清单和公告，但不要求 [PASS]，也不许先 @ 人。
 */
export function buildKickoffPrompt(input: BuildKickoffPromptInput): string {
  const { room, member } = input
  const isHost = isHostMember(member, room.hostBotId)
  const notice = cut((room.notice ?? '').trim(), ROOM_LIMITS.noticeMax)
  const purpose = cut((room.purpose ?? '').trim(), ROOM_LIMITS.noticeMax)
  const sections: string[] = [membersSection(room, member)]
  if (notice !== '') sections.push(`群公告（所有成员共同遵守）：\n${notice}`)
  if (purpose !== '') sections.push(`这个群创建时写的目的：${purpose}`)
  if (isHost) sections.push(HOST_NOTE)
  sections.push([
    '这个群刚建好，用户还没有发第一句话。',
    isHost
      ? '请用一条短消息向用户打招呼，并问清楚这个群要一起做什么：目标是什么、要交付什么、按什么节奏推进。'
      : '请等 host 先开口；如果你被问到，用一条短消息说明你能负责的部分。',
    '现在还不要 @ 任何成员，也不要回复 [PASS]。',
    '直接写要发到群里的话，不要加“名字：”前缀。用用户的语言（默认中文）。'
  ].join(''))
  return sections.join('\n\n')
}
