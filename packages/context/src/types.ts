// 设计见 docs/design/loop-and-context.md。
//
// 每一轮都要能回答：注入了什么、各占多少、哪些被丢弃、为什么。
// 没有这份 manifest，就无法解释“这次为什么贵”，也无法比较两次装配的差异。

/** 进入上下文的段。顺序即装配顺序（稳定段在前，便于缓存）。 */
export type ContextSegmentKind =
  | 'system'        // 系统提示与合规边界
  | 'persona'       // Bot 人设
  | 'skills-index'  // 技能索引（常驻）
  | 'skill-body'    // 技能正文（按需）
  | 'tool-schema'   // 工具 schema
  | 'memory'        // 记忆检索结果
  | 'conversation'  // 最近消息
  | 'summary'       // 压缩/摘要段
  | 'tool-result'   // 工具观察
  | 'workspace'     // 工作目录里的文件引用

export interface ContextSegment {
  kind: ContextSegmentKind
  /** 来源标识：技能名、工具名、记忆 id、消息 seq 范围等。 */
  source: string
  tokens: number
  /** 参与 prompt 缓存的稳定段。 */
  stable?: boolean
  /** 内容指纹：同一指纹表示这一轮这段没变，可用于解释 cache hit。 */
  fingerprint: string
}

/** 因为预算被丢弃或截断的段。 */
export interface DroppedSegment {
  kind: ContextSegmentKind
  source: string
  reason: 'budget' | 'audience' | 'cap' | 'dedupe'
  tokensSaved: number
}

export interface ContextManifest {
  /** 回合标识；与 Run 的 id 对齐。 */
  turnId: string
  workspaceId: string
  botId: string
  model: string
  /** 模型窗口大小（或本次预算）。 */
  window: number
  budget: number
  segments: ContextSegment[]
  dropped: DroppedSegment[]
  totals: {
    input: number
    stable: number
    /** 稳定段命中缓存的估算比例，0–1。 */
    cacheHitRatio?: number
    segments: number
    toolSchemas: number
  }
  /** 压缩是否在这一轮发生。 */
  compacted?: boolean
  at: string
}

export function manifestTotal(manifest: Pick<ContextManifest, 'segments'>): number {
  return manifest.segments.reduce((sum, segment) => sum + segment.tokens, 0)
}

/** 超过预算多少（负数表示还有余量）。 */
export function overBudget(manifest: Pick<ContextManifest, 'segments' | 'budget'>): number {
  return manifestTotal(manifest) - manifest.budget
}
