// Bot 侧发卡钩子（docs/design/architecture-v2.md §6）。
//
// 沙箱里的工具不碰审批表：组好 card，POST /api/rooms/:id/say（runtime token）。
// 控制面负责落消息、建审批、把轮次停在 needs_input。

export function choiceCard(prompt, options) {
  if (typeof prompt !== 'string' || prompt.trim() === '') {
    throw new TypeError('choiceCard prompt must be a non-empty string')
  }
  if (!Array.isArray(options) || options.length < 2) {
    throw new TypeError('choiceCard options must contain at least 2 entries')
  }
  return {
    type: 'choice',
    prompt: prompt.trim(),
    options: options.map((option) => {
      if (typeof option === 'string') return { id: option, label: option }
      return { id: String(option.id), label: String(option.label) }
    }),
  }
}

export function approvalCard(input) {
  if (input === null || typeof input !== 'object') throw new TypeError('approvalCard input must be an object')
  const title = typeof input.title === 'string' ? input.title.trim() : ''
  if (title === '') throw new TypeError('approvalCard title is required')
  return {
    type: 'approval',
    title,
    ...(typeof input.kind === 'string' ? { kind: input.kind } : {}),
    ...(typeof input.action === 'string' ? { action: input.action } : {}),
    ...(typeof input.target === 'string' ? { target: input.target } : {}),
    ...(typeof input.consequence === 'string' ? { consequence: input.consequence } : {}),
  }
}

/** 用 runtime token 把卡发进房间。返回控制面的 JSON。 */
export async function postCard(options) {
  const apiBase = String(options.apiBase ?? '').replace(/\/+$/, '')
  const roomId = options.roomId
  const response = await fetch(`${apiBase}/api/rooms/${encodeURIComponent(roomId)}/say`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-runtime-token': options.runtimeToken,
    },
    body: JSON.stringify({
      botId: options.botId,
      ...(options.text === undefined ? {} : { text: options.text }),
      card: options.card,
    }),
  })
  const text = await response.text()
  const body = text.trim() === '' ? null : JSON.parse(text)
  if (!response.ok) {
    const error = new Error(`postCard failed: ${response.status}`)
    error.status = response.status
    error.body = body
    throw error
  }
  return body
}
