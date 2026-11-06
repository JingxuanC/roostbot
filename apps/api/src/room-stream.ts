// 房间事件 → SSE 帧，并附上 AG-UI 投影（docs/design/architecture-v2.md §5.3）。
//
// 存储信封不变。旧客户端只听 `message` / `round` / `speaking`；
// 新名字（round.started、message.delta）是额外的帧，同一条 seq 可以有多帧。

import type { Event } from '../../../packages/store/src/types.ts'

export interface SseFrame {
  seq: number
  event: string
  data: Record<string, unknown>
}

const SSE_NAME: Record<string, string> = {
  'chat.message.delta': 'message.delta',
  'chat.card.answered': 'card.answered',
  'approval.requested': 'approval.requested',
  'approval.decided': 'approval.decided',
  'turn.round.started': 'round.started',
  'turn.round.ended': 'round.ended',
  'turn.speaking': 'speaking',
  'schedule.routine.fired': 'routine.fired',
}

export function aguiFor(event: Pick<Event, 'kind' | 'seq' | 'payload' | 'audience'>): Record<string, unknown> | null {
  const payload = event.payload ?? {}
  const roomFromAudience = (event.audience ?? '').startsWith('room:') ? (event.audience ?? '').slice('room:'.length) : ''
  const threadId = typeof payload.roomId === 'string' ? payload.roomId : roomFromAudience
  if (event.kind === 'chat.message') {
    const text = typeof payload.text === 'string' ? payload.text : ''
    return {
      type: 'TEXT_MESSAGE_CONTENT',
      messageId: `msg_${event.seq}`,
      role: payload.role === 'user' ? 'user' : 'assistant',
      delta: text,
    }
  }
  if (event.kind === 'chat.message.delta') {
    const delta = typeof payload.delta === 'string' ? payload.delta : ''
    const messageSeq = typeof payload.messageSeq === 'number' ? payload.messageSeq : event.seq
    return { type: 'TEXT_MESSAGE_CONTENT', messageId: `msg_${messageSeq}`, role: 'assistant', delta }
  }
  if (event.kind === 'turn.round.started') {
    return { type: 'RUN_STARTED', threadId, runId: String(payload.roundId ?? '') }
  }
  if (event.kind === 'turn.round.ended') {
    return { type: 'RUN_FINISHED', threadId, runId: String(payload.roundId ?? '') }
  }
  if (event.kind === 'turn.speaking') {
    return { type: 'STEP_STARTED', stepName: String(payload.botId ?? '') }
  }
  return null
}

function withAgui(event: Event, data: Record<string, unknown>): Record<string, unknown> {
  const agui = aguiFor(event)
  return agui === null ? data : { ...data, agui }
}

/** 一条房间事件对应的 SSE 帧。chat.message 由调用方传入已经挂好附件的消息 JSON。 */
export function framesForRoomEvent(event: Event, message: Record<string, unknown> | null): SseFrame[] {
  if (event.kind === 'chat.message' && message !== null) {
    return [{ seq: event.seq, event: 'message', data: withAgui(event, message) }]
  }
  if (event.kind === 'turn.round.started' || event.kind === 'turn.round.ended') {
    const name = SSE_NAME[event.kind] ?? event.kind
    const round = event.payload.round ?? event.payload
    const data = withAgui(event, { round, kind: name, seq: event.seq })
    return [
      { seq: event.seq, event: name, data },
      { seq: event.seq, event: 'round', data },
      { seq: event.seq, event: 'status', data },
    ]
  }
  if (event.kind === 'turn.speaking') {
    const botId = typeof event.payload.botId === 'string' ? event.payload.botId : ''
    return [
      {
        seq: event.seq,
        event: 'speaking',
        data: withAgui(event, {
          botId,
          speaking: botId,
          roundId: event.payload.roundId ?? null,
          seq: event.seq,
        }),
      },
    ]
  }
  const name = SSE_NAME[event.kind] ?? event.kind
  return [
    {
      seq: event.seq,
      event: name,
      data: withAgui(event, { ...event.payload, seq: event.seq, kind: event.kind }),
    },
  ]
}

export function encodeSseFrame(frame: SseFrame): string {
  return `id: ${frame.seq}\nevent: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`
}

/** 沙箱长轮询的一条记录。message 仅在 chat.message 上出现，形状与旧 messages 接口一致。 */
export function internalEventJson(
  event: Event,
  message: Record<string, unknown> | null,
): Record<string, unknown> {
  const roomId = (event.audience ?? '').startsWith('room:') ? (event.audience ?? '').slice('room:'.length) : ''
  const agui = aguiFor(event)
  return {
    seq: event.seq,
    at: event.at,
    kind: event.kind,
    roomId,
    payload: event.payload,
    ...(agui === null ? {} : { agui }),
    ...(message === null ? {} : { message }),
  }
}
