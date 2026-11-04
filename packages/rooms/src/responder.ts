// 谁回答、谁先开口：responder 的 fallback 链与 @ 解析（docs/design/rooms.md §4）。
// 纯逻辑：不读数据库、不发网络请求；参数一律取自契约里的类型。

import type { RoomMember, RoomResponder } from '../../contract/src/index.ts'

/** "@all" 的几种写法，大小写不敏感。 */
export const MENTION_ALL_WORDS: readonly string[] = ['all', 'everyone', '所有人', '全体']

// 名字后面紧跟字母/数字/下划线/连字符/汉字，说明 @ 的是更长的名字。
// 中文没有词边界，这条规则就是 `@数据官` 不匹配 `@数据官2` 的办法。
const NAME_CONTINUES = /^[\p{L}\p{N}_-]$/u
// 前面是邮箱或网址的一部分时，@ 不是呼叫（a@b、medium.com/@Writer）。
const ADDRESS_BEFORE = /^[A-Za-z0-9_./]$/

export interface ParsedMentions {
  /** 出现了 @all；非 host 调用时恒为 false（rooms.md §4 的防 @ 风暴规则）。 */
  all: boolean
  /** 按出现顺序去重后的被 @ 成员。 */
  members: RoomMember[]
}

/** openingSpeakers 需要的最小房间形状（Room 满足它，测试可以只给这些字段）。 */
export interface OpeningRoom {
  members: RoomMember[]
  replyMode?: 'admin' | 'everyone' | 'mentions'
  responder?: RoomResponder
  hostBotId?: string
}

/** 成员的显示名；没有名字时退回 botId，保证 prompt 里不出现空位。 */
export const displayName = (member: Pick<RoomMember, 'botId' | 'name'>): string => {
  const name = (member.name ?? '').trim()
  return name === '' ? member.botId : name
}

/** 成员是不是 host（role 优先，hostBotId 兜底）。 */
export function isHostMember(member: RoomMember, hostBotId?: string): boolean {
  return member.role === 'host' || (hostBotId !== undefined && member.botId === hostBotId)
}

/** 房间的 host；没有标 host 时返回 undefined。 */
export function hostMember(room: OpeningRoom): RoomMember | undefined {
  const members = room.members ?? []
  return members.find(member => isHostMember(member, room.hostBotId))
}

/** host 排到最前，其余保持原有顺序（everyone 模式与发言顺序都以这个为准）。 */
export function hostFirst(members: RoomMember[]): RoomMember[] {
  const list = members ?? []
  const host = list.find(member => member.role === 'host')
  return host === undefined ? [...list] : [host, ...list.filter(member => member !== host)]
}

/** 没人被指定时默认说话的人：host，其次第一个成员。 */
export function defaultLead(members: RoomMember[]): RoomMember | undefined {
  const list = members ?? []
  return list.find(member => member.role === 'host') ?? list[0]
}

function dedupeMembers(members: RoomMember[]): RoomMember[] {
  const seen = new Set<string>()
  const out: RoomMember[] = []
  for (const member of members) {
    if (seen.has(member.botId)) continue
    seen.add(member.botId)
    out.push(member)
  }
  return out
}

/**
 * responder 的 fallback 链（rooms.md §4，照 OMB 的写法）：
 *   1. `member` 指定的成员在列表里 → 就是它；
 *   2. `auto` 有 fallbackBotId 且在列表里 → 用它；
 *   3. `everyone` → 全部成员（host 第一），因为这个模式字面意思就是全员；
 *   4. 其他（含 mentions 的“没人 @”态、未配置、指定的成员已不在房间）→ 第一个成员；
 *   5. 没有成员 → 空列表（房间里没人，调用方不应开轮）。
 *
 * 注意：这是“一条普通消息默认谁回答”，不是本轮的 slots；mentions 模式下真正被 @ 的人由
 * openingSpeakers/parseMentions 决定。
 */
export function resolveResponder(responder: RoomResponder | undefined, members: RoomMember[]): RoomMember[] {
  const list = members ?? []
  if (list.length === 0) return []
  if (responder?.kind === 'everyone') return hostFirst(list)
  if (responder?.kind === 'member' && responder.botId) {
    const found = list.find(member => member.botId === responder.botId)
    if (found !== undefined) return [found]
  }
  if (responder?.kind === 'auto' && responder.fallbackBotId) {
    const found = list.find(member => member.botId === responder.fallbackBotId)
    if (found !== undefined) return [found]
  }
  return [list[0]]
}

interface NamedMember {
  member: RoomMember
  name: string
}

const matchesAt = (text: string, at: number, word: string): boolean => {
  const end = at + 1 + word.length
  if (text.slice(at + 1, end).toLowerCase() !== word.toLowerCase()) return false
  const next = text.slice(end, end + 1)
  return next === '' || !NAME_CONTINUES.test(next)
}

/**
 * 解析 text 里的 `@名字` 与 `@all`。
 *
 * - 精确匹配成员名（大小写不敏感），长名字优先：成员同时有“数据官”和“数据官2”时，
 *   `@数据官2` 解析成后者。
 * - 中文前缀歧义用“后面的字符不能接名字”判定：`@数据官2` 不会匹配“数据官”，
 *   `@数据官长`（不是成员）也不会匹配“数据官”。
 * - 跳过邮箱/网址里的 @（`a@b`、`medium.com/@Writer`）。
 * - `@all` 只在调用者是 host 时生效；非 host 时 all 为 false，被 @ 的具名成员照常返回。
 */
export function parseMentions(
  text: string,
  members: RoomMember[],
  options: { callerIsHost?: boolean } = {}
): ParsedMentions {
  const value = typeof text === 'string' ? text : ''
  const callerIsHost = options.callerIsHost !== false
  const candidates: NamedMember[] = (members ?? [])
    .filter(member => typeof member?.name === 'string' && member.name.trim() !== '')
    .map(member => ({ member, name: (member.name ?? '').trim() }))
    .sort((a, b) => b.name.length - a.name.length)
  const found: RoomMember[] = []
  let all = false
  for (let at = value.indexOf('@'); at !== -1; at = value.indexOf('@', at + 1)) {
    if (at > 0 && ADDRESS_BEFORE.test(value[at - 1])) continue
    const hit = candidates.find(candidate => matchesAt(value, at, candidate.name))
    if (hit !== undefined) {
      if (!found.some(member => member.botId === hit.member.botId)) found.push(hit.member)
      at += hit.name.length
      continue
    }
    const word = MENTION_ALL_WORDS.find(candidate => matchesAt(value, at, candidate))
    if (word !== undefined) {
      all = true
      at += word.length
    }
  }
  return { all: all && callerIsHost, members: found }
}

/**
 * 一轮开始时进 slots 的人（顺序就是发言顺序）。
 *
 * - `everyone` → 全部成员，host 第一；
 * - `mentions` → 被 @ 的成员（按 @ 出现顺序）；没人 @ 或有 `@all` 时：host，其次第一个成员；
 *   `@all` 展开为全员；
 * - `member` → 指定的成员；它已不在房间时按 fallback 落回第一个成员；
 * - `auto` → resolveResponder 的 fallback 链；
 * - `replyMode: 'admin'`（旧字段语义）→ 只有 host。
 */
export function openingSpeakers(room: OpeningRoom, options: { text?: string } = {}): RoomMember[] {
  const members = hostFirst(room.members ?? [])
  if (members.length === 0) return []
  const host = hostMember(room)
  const responder = room.responder
  const mode = responder?.kind
    ?? (room.replyMode === 'everyone' ? 'everyone' : room.replyMode === 'mentions' ? 'mentions' : 'member')
  const text = options.text ?? ''
  if (mode === 'everyone') return members
  if (mode === 'mentions') {
    const parsed = parseMentions(text, members, { callerIsHost: true })
    if (parsed.all) return members
    if (parsed.members.length > 0) return dedupeMembers(parsed.members)
    return host === undefined ? members.slice(0, 1) : [host]
  }
  if (mode === 'auto') return resolveResponder(responder ?? { kind: 'auto' }, members)
  if (responder?.kind === 'member') return resolveResponder(responder, members)
  return host === undefined ? members.slice(0, 1) : [host]
}
