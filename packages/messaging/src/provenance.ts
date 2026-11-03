// 设计见 docs/design/messaging.md §14。决定 Bot 发来的消息上方那行标签怎么写。

/** 一条 Bot 消息在界面上被归为什么来源。 */
export type PeerDelivery =
  | 'message'    // A 直发 B
  | 'reply'      // B 回 A
  | 'delegate'   // 委派工作（带完成条件）
  | 'consult'    // 只问不做
  | 'room'       // 房间内发言（气泡上方标名字，不用标签行）
  | 'proactive'  // 自主发起（routine / 事件触发）
  | 'notice'     // 停止、重启、删除等事件行

export interface PeerLabel {
  /** 标签显示的名字。 */
  name: string
  /** 动词短语，例如「发来消息」「委派工作」。 */
  verb: string
  /** 主动消息必须能回答「为什么现在说话」。 */
  reason?: string
  /** 房间内不需要标签行，由气泡上方的名字承担。 */
  inline: boolean
}

const VERBS: Record<Exclude<PeerDelivery, 'room'>, string> = {
  message: '发来消息',
  reply: '回复',
  delegate: '委派工作',
  consult: '提问',
  proactive: '主动',
  notice: '',
}

export function peerLabel(input: { from: string; delivery: PeerDelivery; reason?: string }): PeerLabel {
  if (input.delivery === 'room') return { name: input.from, verb: '', inline: true }
  return {
    name: input.from,
    verb: VERBS[input.delivery],
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    inline: false,
  }
}

/** 主动消息的硬要求：没有触发原因的不要显示成主动消息。 */
export function needsReason(delivery: PeerDelivery): boolean {
  return delivery === 'proactive'
}

/** 只有这些来源会在房间/多人可见的界面里被投影。 */
export function isPubliclyVisible(delivery: PeerDelivery): boolean {
  return delivery === 'room' || delivery === 'notice'
}

/**
 * 私聊默认折叠，房间消息不折叠（design messaging.md §14.1）。
 * 折叠不等于隐藏：标签行仍给谁、什么动作、一句话摘要。
 */
export function collapsedByDefault(delivery: PeerDelivery): boolean {
  return delivery !== 'room' && delivery !== 'notice'
}

/** 折叠时标签行里那句话的截断长度。 */
export const PEER_SUMMARY_CHARS = 40

/** 房间的展示设置：折叠开关属于房间，不是设备偏好（design §14.2）。 */
export interface RoomDisplaySettings {
  /** 打开后：只留人的话与每条链的结论。 */
  collapseBotToBot: boolean
}

/** 一条房间里的话，按渲染需要分类。 */
export type RoomLineKind = 'human' | 'answer' | 'handoff' | 'final'

export interface RoomLineInput {
  authorKind: 'user' | 'bot'
  repliedToKind?: 'user' | 'bot'
  mentionsBots: boolean
  /** 由列表构建器判定：这条之后没有人说话、也没有 @ 别人。 */
  terminal?: boolean
}

export function classifyRoomLine(line: RoomLineInput): RoomLineKind {
  if (line.authorKind === 'user') return 'human'
  if (line.terminal === true) return 'final'
  if (line.mentionsBots || line.repliedToKind === 'bot') return 'handoff'
  return 'answer'
}

/**
 * 是否折叠这一行。结论永不折叠，否则开了开关就等于看不到结果。
 * 折叠只影响渲染，不影响模型上下文。
 */
export function shouldCollapseRoomLine(line: RoomLineInput, settings: RoomDisplaySettings): boolean {
  if (!settings.collapseBotToBot) return false
  const kind = classifyRoomLine(line)
  return kind === 'handoff'
}

/** 连续被折叠的行合并成一个计数行，而不是每行一个折叠条。 */
export function collapseRunLabel(count: number): string {
  return `${count} 条协作`
}
