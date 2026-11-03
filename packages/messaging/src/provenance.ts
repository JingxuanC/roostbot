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
