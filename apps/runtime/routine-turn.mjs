// Routine 的隔离回合：只有这一条 prompt，不带房间历史。
// 模型仍走 room-agent 的 DSH 会话（同一套沙箱和工具策略，BYO 密钥留在控制面）。

export const ROUTINE_MAX_ATTEMPTS = 3

/** 交给模型的正文。刻意不拼接房间消息。 */
export function isolatedRoutinePrompt(prompt) {
  const text = typeof prompt === 'string' ? prompt.trim() : ''
  return text
}

/**
 * 把模型失败收成房间里看得见的一句。
 * 没有密钥不重试；超时和其它模型错误在次数用完之前重试。
 */
export function classifyRoutineFailure(message) {
  const text = typeof message === 'string' ? message.trim() : ''
  if (/超时|timed?\s*out|timeout/i.test(text)) {
    return { kind: 'timeout', retry: true, text: '失败：模型超时' }
  }
  if (/401|403|unauthorized|api[_ ]?key|model key|密钥|no BYO|platform_model_key|missing token/i.test(text)) {
    return { kind: 'missing_token', retry: false, text: '失败：还没有配置模型密钥' }
  }
  const detail = text === '' ? '模型没有返回' : text.slice(0, 180)
  return { kind: 'model', retry: true, text: `失败：${detail}` }
}

/**
 * 一次尝试之后做什么。
 * post 的文本由调用方用 runId 做幂等键，重试不会再写第二条。
 */
export function decideRoutineAttempt(input) {
  const attempt = Number.isInteger(input?.attempt) && input.attempt > 0 ? input.attempt : 1
  const maxAttempts = Number.isInteger(input?.maxAttempts) && input.maxAttempts > 0 ? input.maxAttempts : ROUTINE_MAX_ATTEMPTS
  const answer = typeof input?.answer === 'string' ? input.answer.trim() : ''
  if (answer !== '') return { action: 'post', text: answer, error: false }
  if (input?.timedOut !== true && (input?.error === undefined || input?.error === null || input?.error === '')) {
    return { action: 'silent' }
  }
  const failure = input?.timedOut === true
    ? { kind: 'timeout', retry: true, text: '失败：模型超时' }
    : classifyRoutineFailure(String(input.error))
  if (failure.retry && attempt < maxAttempts) return { action: 'retry', kind: failure.kind }
  return { action: 'post', text: failure.text, error: true, kind: failure.kind }
}
