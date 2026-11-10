// 轻量内存 trace ring buffer：给「为什么这一轮这么慢」提供请求级时间线。
// 只保留最近若干条，进程重启即丢；不做持久化，也不记录 body/凭据。

export interface TraceSpan {
  traceId: string
  name: string
  at: number
  durationMs: number
  attrs: Record<string, string | number | boolean>
}

const MAX_SPANS = 500
const spans: TraceSpan[] = []

export function recordTrace(span: TraceSpan): void {
  spans.push(span)
  if (spans.length > MAX_SPANS) spans.splice(0, spans.length - MAX_SPANS)
}

export function recentTraceSpans(limit = 100): TraceSpan[] {
  const n = Number.isFinite(limit) ? Math.max(1, Math.min(MAX_SPANS, Math.trunc(limit))) : 100
  return spans.slice(-n)
}
