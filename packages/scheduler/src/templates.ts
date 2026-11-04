// 每日复盘 routine 模板（docs/design/scheduling.md §2–§4、§7；docs/build/wave2.md §A）。
//
// 复盘闭环（memory.md §8、§14）：
//   1. 复核：拿每条 claim 的 falsifier 去核对当天事件/行情/产出，被推翻的记 falsifiedAt；
//   2. 清理：planCleanup({ claims, now, falsifiedOlderThanMs, keepRecent })，只删 remove 里的 id；
//   3. lesson：从被推翻的条目抽 0..3 条候选，每条必须带可证伪条件，走 extractClaims 校验后写入。
//
// 幂等：`clockIdem(\`routine-<workspace>-<YYYY-MM-DD>\`, 当天 20:00)`
//   * 同一个 workspace 的同一天，无论几点调用 reviewRoutineInput，都得到同一个 idem；
//   * 准点跑与补跑撞键是故意的（activation.ts：scheduledFor 永远是原定时刻）；
//   * scheduledFor 用模板 cron 在当天的那次触发，不随 `at` 漂移。
//
// 纯函数：不读 DB、不建 activation；返回的是「创建 activation 需要的输入」。
// 默认时区 Asia/Shanghai（wave2 §A）。

import { clockIdem } from './activation.ts'
import { CATCH_UP_MS } from './constants.ts'
import { CronError, nextRunAt } from './cron.ts'
import type { ActivationBudget } from './types.ts'

export type ReviewRoutineStepKey = 'review' | 'cleanup' | 'lessons'

export interface ReviewRoutineStep {
  key: ReviewRoutineStepKey
  title: string
  instruction: string
}

export interface ReviewCleanupPolicy {
  /** 否证后保留多久才允许删（毫秒）；与 @roost/memory 的默认值一致。 */
  falsifiedOlderThanMs: number
  /** 最近 N 条不动；与 @roost/memory 的默认值一致。 */
  keepRecent: number
}

export interface ReviewRoutineTemplate {
  /** routine 家族的稳定 id；每天的具体 routineId 由 reviewRoutineInput 拼上日期。 */
  id: string
  source: string
  /** 每天什么时候跑；幂等键里的 scheduledFor 就取这个时刻。 */
  cron: string
  timezone: string
  overlap: 'skip'
  catchUpMs: number
  budget: ActivationBudget
  doneWhen: string
  steps: readonly ReviewRoutineStep[]
  cleanup: ReviewCleanupPolicy
  /** 每次复盘最多写几条 lesson 候选。 */
  lessonCandidates: number
}

/** 6.5.6 的每日复盘模板；Lead 用它建默认 schedule，或用 reviewRoutineInput 生成单日输入。 */
export const REVIEW_ROUTINE_TEMPLATE: ReviewRoutineTemplate = {
  id: 'daily-review',
  source: 'routine:daily-review',
  cron: 'daily 20:00',
  timezone: 'Asia/Shanghai',
  overlap: 'skip',
  catchUpMs: CATCH_UP_MS,
  budget: { tokens: 20_000, wallMs: 180_000, toolCalls: 12 },
  doneWhen: '产出一份复盘摘要：核对条数、清理条数、lesson 候选条数；没有候选时明确写“无”。',
  steps: [
    {
      key: 'review',
      title: '复核',
      instruction:
        '用每条 active claim 的 falsifier 核对本日事件与产出；被推翻的记 falsifiedAt 并置 retracted，产出 memory.retracted 事件。',
    },
    {
      key: 'cleanup',
      title: '清理',
      instruction:
        '对已过保留期的否证条目调用 @roost/memory 的 planCleanup，只删除返回的 remove 里的 id；keep 与 retracted 不动。',
    },
    {
      key: 'lessons',
      title: '写 lesson 候选',
      instruction:
        '从被推翻的条目抽 0..3 条 lesson 候选，每条都要有 ≥10 字且可验证的 falsifier，用 extractClaims 校验后写入；没有合格候选就写“无”。',
    },
  ],
  cleanup: { falsifiedOlderThanMs: 30 * 86_400_000, keepRecent: 20 },
  lessonCandidates: 3,
}

export interface ReviewRoutineArgs {
  workspaceId: string
  /** epoch 毫秒；决定复盘属于哪一天。默认 Date.now()。 */
  at?: number
  /** IANA 时区；默认 REVIEW_ROUTINE_TEMPLATE.timezone（Asia/Shanghai）。 */
  timezone?: string
}

/** 单日复盘 routine 的输入：直接映射成 Activation（差一个 id，由 store 分配）。 */
export interface ReviewRoutineInput {
  routineId: string
  kind: 'clock'
  source: string
  workspaceId: string
  timezone: string
  /** 复盘归属的本地日期 YYYY-MM-DD。 */
  date: string
  scheduledFor: string
  scheduledForMs: number
  idem: string
  at: number
  payload: { brief: string; inputs: ReviewRoutineStep[] }
  budget: ActivationBudget
  doneWhen: string
  cleanup: ReviewCleanupPolicy
  lessonCandidates: number
}

/** routine 输入不合法（workspaceId/at/timezone 形状问题）；CronError 仍用于未知时区。 */
export class TemplateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TemplateError'
  }
}

/** `routine-<workspace>-<YYYY-MM-DD>`：复盘 routine 的每日实例 id。 */
export function reviewRoutineId(workspaceId: string, date: string): string {
  return `routine-${workspaceId}-${date}`
}

/**
 * 生成某一天的复盘 routine 输入。
 * 同一天不同时刻调用 → 同 routineId/scheduledFor/idem；跨天必然不同。
 */
export function reviewRoutineInput(args: ReviewRoutineArgs): ReviewRoutineInput {
  if (args === null || typeof args !== 'object') {
    throw new TemplateError('review input must be an object')
  }
  const workspaceId = readWorkspaceId(args.workspaceId)
  const timezone = readTimezone(args.timezone)
  const at = readAt(args.at)
  const date = localDateIn(timezone, at)
  const scheduledForMs = reviewScheduledFor(at, timezone)
  const routineId = reviewRoutineId(workspaceId, date)
  const cleanup = { ...REVIEW_ROUTINE_TEMPLATE.cleanup }

  return {
    routineId,
    kind: 'clock',
    source: `routine:${routineId}`,
    workspaceId,
    timezone,
    date,
    scheduledFor: new Date(scheduledForMs).toISOString(),
    scheduledForMs,
    idem: clockIdem(routineId, new Date(scheduledForMs)),
    at,
    payload: {
      brief: renderBrief({ workspaceId, date, timezone, cleanup }),
      inputs: REVIEW_ROUTINE_TEMPLATE.steps.map((step) => ({ ...step })),
    },
    budget: { ...REVIEW_ROUTINE_TEMPLATE.budget },
    doneWhen: REVIEW_ROUTINE_TEMPLATE.doneWhen,
    cleanup,
    lessonCandidates: REVIEW_ROUTINE_TEMPLATE.lessonCandidates,
  }
}

/** 某一天该跑的那次复盘（模板 cron 在本地日期上的触发时刻，UTC 毫秒）。 */
export function reviewScheduledFor(at: number, timezone: string = REVIEW_ROUTINE_TEMPLATE.timezone): number {
  const date = localDateIn(timezone, at)
  let cursor = at - 36 * 3_600_000
  let candidate = nextRunAt(REVIEW_ROUTINE_TEMPLATE.cron, timezone, cursor)
  // 最多往前找 8 次（at 之前 36h 起，目标日期最多两天后到）。
  for (let i = 0; i < 8; i += 1) {
    const candidateDate = localDateIn(timezone, candidate)
    if (candidateDate === date) return candidate
    // 当天该时刻被 DST 跳过：落到下一次，仍按天稳定。
    if (candidateDate > date) return candidate
    cursor = candidate
    candidate = nextRunAt(REVIEW_ROUTINE_TEMPLATE.cron, timezone, cursor)
  }
  return candidate
}

/** 时区里的本地日期 YYYY-MM-DD；未知时区抛 CronError（与 cron.nextRunAt 一致）。 */
export function localDateIn(timezone: string, ms: number): string {
  const formatter = dateFormatter(timezone)
  const parts = formatter.formatToParts(new Date(ms))
  let year = ''
  let month = ''
  let day = ''
  for (const part of parts) {
    if (part.type === 'year') year = part.value
    else if (part.type === 'month') month = part.value
    else if (part.type === 'day') day = part.value
  }
  return `${year}-${month}-${day}`
}

// ---- 内部 --------------------------------------------------------------------

const dateFormatters = new Map<string, Intl.DateTimeFormat>()

function dateFormatter(timezone: string): Intl.DateTimeFormat {
  const cached = dateFormatters.get(timezone)
  if (cached !== undefined) return cached
  let formatter: Intl.DateTimeFormat
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
  } catch (err) {
    throw new CronError(
      `unknown time zone "${timezone}": ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  dateFormatters.set(timezone, formatter)
  return formatter
}

function renderBrief(input: {
  workspaceId: string
  date: string
  timezone: string
  cleanup: ReviewCleanupPolicy
}): string {
  const steps = REVIEW_ROUTINE_TEMPLATE.steps
  const lines = [
    `每日复盘：${input.date}（${input.timezone}），workspace ${input.workspaceId}。`,
    '',
    ...steps.map((step, index) => `${index + 1}. ${step.title}：${step.instruction}`),
    '',
    `清理参数：falsifiedOlderThanMs=${input.cleanup.falsifiedOlderThanMs}，keepRecent=${input.cleanup.keepRecent}。`,
    `完成条件：${REVIEW_ROUTINE_TEMPLATE.doneWhen}`,
  ]
  return lines.join('\n')
}

function readWorkspaceId(value: unknown): string {
  if (typeof value !== 'string') {
    throw new TemplateError('review.workspaceId must be a string')
  }
  const workspaceId = value.trim()
  if (workspaceId === '' || workspaceId.length > 200 || /[\u0000-\u001f\u007f]/u.test(workspaceId)) {
    throw new TemplateError('review.workspaceId must be 1..200 safe characters')
  }
  return workspaceId
}

function readTimezone(value: unknown): string {
  if (value === undefined || value === null) return REVIEW_ROUTINE_TEMPLATE.timezone
  if (typeof value !== 'string') {
    throw new TemplateError('review.timezone must be a string')
  }
  const timezone = value.trim()
  if (timezone === '' || timezone.length > 100) {
    throw new TemplateError('review.timezone must be 1..100 characters')
  }
  return timezone
}

function readAt(value: unknown): number {
  if (value === undefined || value === null) return Date.now()
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new TemplateError('review.at must be an integer >= 0')
  }
  return value
}
