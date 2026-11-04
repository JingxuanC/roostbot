// 记忆 claim 抽取与校验（docs/design/memory.md §3–§5、§8；docs/build/wave2.md §A）。
//
// 一条 claim = 判断（subject/predicate/object）+ 可证伪条件（falsifier）+ 置信度 + 出处引用。
// 本模块只做规则校验：不调模型、不读 DB、不写事件。抽取器（便宜档模型）把候选交过来，
// 调用方再把 claims 交给 store.writeMemory（memory.md §5 的写入路径）。
//
// 拒绝规则（rejected[].reason）：
//   * falsifier_missing：falsifier 去空白后 < 10 字符，或命中空话清单 EMPTY_FALSIFIERS；
//   * daily_cap：超出当日剩余配额（dailyCap − alreadyToday），配额只被真正接受的 claim 占用；
//   * duplicate：同文本重复（subject/predicate/object 归一化后比较，也对比 alreadyToday 里的文本）；
//   * malformed：行/字段不完整（少于 4 段、缺 subject/predicate/object 等）。
//
// 文本格式（抽取器与调用方的约定）：
//   1) JSON：整段是 `[...]` 或 `{"claims":[...]}`，字段 subject/predicate/object/falsifier/
//      confidence/sourceQuote；允许 ```json 围栏（模型输出常见）。
//   2) 竖线行：`subject | predicate | object | falsifier | confidence`，可带 `- `/`* `/`1. ` 前缀；
//      confidence 可省略（默认 0.5）；空行与 `#` 开头的注释行跳过。
//
// confidence 一律夹在 [0, 1]（非数字 → 默认值），不因为越界拒收；falsifier 才是硬门槛。

/** falsifier 去掉空白后的最少字符数（wave2 §A）。 */
export const CLAIM_MIN_FALSIFIER_CHARS = 10
/** 每日抽取上限，与 store 的 MEMORY_DAILY_LIMIT 对齐（memory.md §5、§7）。 */
export const CLAIM_DAILY_CAP = 50
/** “这类话不算可证伪条件”（wave2 §A）。比较前会去空白与首尾标点。 */
export const EMPTY_FALSIFIERS = ['无法证伪', '待定', '观察', '不确定'] as const
/** 与 store 的 MEMORY_CLAIM_MAX / MEMORY_SUBJECT_MAX 对齐；只截断校验，不在这里入库。 */
export const CLAIM_TEXT_MAX = 2000
export const CLAIM_SUBJECT_MAX = 500
export const CLAIM_QUOTE_MAX = 500
export const CLAIM_DEFAULT_CONFIDENCE = 0.5

export type ClaimRejectionReason = 'falsifier_missing' | 'daily_cap' | 'duplicate' | 'malformed'

export interface ExtractClaimsInput {
  /** 抽取器输出：JSON 块或竖线行（见文件头）。 */
  text: string
  /** epoch 毫秒；每条 claim 的 at 都用它。默认 Date.now()。 */
  now?: number
  /** 每日上限；默认 CLAIM_DAILY_CAP。 */
  dailyCap?: number
  /**
   * 今天已经写过的条数，或已经写过的 claim 文本（字符串数组）。
   * 传数组时长度计入配额，文本同时用于去重。
   */
  alreadyToday?: number | readonly string[]
}

export interface ExtractedClaim {
  subject: string
  predicate: string
  object: string
  falsifier: string
  confidence: number
  sourceQuote: string
  at: number
}

export interface RejectedClaim {
  reason: ClaimRejectionReason
  /** 出问题的原文行（截断到 CLAIM_QUOTE_MAX）；JSON 输入用整段的前缀。 */
  sourceQuote: string
  /** 行号（从 1 开始）；JSON 输入用数组下标 + 1。 */
  line: number
}

export interface ExtractClaimsResult {
  claims: ExtractedClaim[]
  rejected: RejectedClaim[]
}

/** claims/cleanup 的输入错误；调用方映射为 INVALID_INPUT。 */
export class ClaimError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ClaimError'
  }
}

interface Candidate {
  subject: string
  predicate: string
  object: string
  falsifier: unknown
  confidence: unknown
  sourceQuote: string
  line: number
}

/** 抽取候选 claim：通过校验的按输入顺序返回，不合格的进 rejected。纯函数。 */
export function extractClaims(input: ExtractClaimsInput): ExtractClaimsResult {
  if (input === null || typeof input !== 'object') {
    throw new ClaimError('claims input must be an object')
  }
  if (typeof input.text !== 'string') {
    throw new ClaimError('claims.text must be a string')
  }
  const at = readAt(input.now, 'claims.now')
  const dailyCap = readCount(input.dailyCap, 'claims.dailyCap', CLAIM_DAILY_CAP)
  const already = readAlreadyToday(input.alreadyToday)

  const parsed = parseCandidates(input.text)
  const claims: ExtractedClaim[] = []
  const rejected: RejectedClaim[] = parsed.rejected.slice()
  const seen = new Set<string>(already.texts)

  for (const candidate of parsed.candidates) {
    const subject = candidate.subject.trim()
    const predicate = candidate.predicate.trim()
    const object = candidate.object.trim()
    if (subject === '' || predicate === '' || object === '') {
      rejected.push(reject(candidate, 'malformed'))
      continue
    }
    if (
      subject.length > CLAIM_SUBJECT_MAX ||
      predicate.length > CLAIM_TEXT_MAX ||
      object.length > CLAIM_TEXT_MAX
    ) {
      rejected.push(reject(candidate, 'malformed'))
      continue
    }

    const falsifier = typeof candidate.falsifier === 'string' ? candidate.falsifier.trim() : ''
    if (!isFalsifiable(falsifier)) {
      rejected.push(reject(candidate, 'falsifier_missing'))
      continue
    }

    const key = claimKey(subject, predicate, object)
    if (seen.has(key)) {
      rejected.push(reject(candidate, 'duplicate'))
      continue
    }

    if (already.count + claims.length >= dailyCap) {
      rejected.push(reject(candidate, 'daily_cap'))
      continue
    }

    seen.add(key)
    claims.push({
      subject,
      predicate,
      object,
      falsifier,
      confidence: clampConfidence(candidate.confidence),
      sourceQuote: candidate.sourceQuote.slice(0, CLAIM_QUOTE_MAX),
      at,
    })
  }

  return { claims, rejected }
}

/** falsifier 是否算“可证伪条件”：去空白后够长，且不是空话。 */
export function isFalsifiable(falsifier: string): boolean {
  const normalized = normalizeFalsifier(falsifier)
  if (normalized.length < CLAIM_MIN_FALSIFIER_CHARS) return false
  return !(EMPTY_FALSIFIERS as readonly string[]).includes(normalized)
}

// ---- 解析 --------------------------------------------------------------------

function parseCandidates(text: string): { candidates: Candidate[]; rejected: RejectedClaim[] } {
  const trimmed = text.trim()
  if (trimmed === '') return { candidates: [], rejected: [] }
  const jsonText = stripCodeFence(trimmed)
  if (jsonText.startsWith('[') || jsonText.startsWith('{')) {
    return parseJsonCandidates(jsonText)
  }
  return parseLineCandidates(text)
}

function stripCodeFence(text: string): string {
  const fenced = /^```(?:json|JSON)?\s*([\s\S]*?)\s*```$/.exec(text)
  return fenced === null ? text : fenced[1]!.trim()
}

function parseJsonCandidates(jsonText: string): { candidates: Candidate[]; rejected: RejectedClaim[] } {
  const candidates: Candidate[] = []
  const rejected: RejectedClaim[] = []
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch (err) {
    rejected.push({
      reason: 'malformed',
      sourceQuote: jsonText.slice(0, CLAIM_QUOTE_MAX),
      line: 1,
    })
    return { candidates, rejected }
  }

  let list: unknown
  if (Array.isArray(parsed)) list = parsed
  else if (parsed !== null && typeof parsed === 'object' && Array.isArray((parsed as { claims?: unknown }).claims)) {
    list = (parsed as { claims: unknown[] }).claims
  } else {
    rejected.push({ reason: 'malformed', sourceQuote: jsonText.slice(0, CLAIM_QUOTE_MAX), line: 1 })
    return { candidates, rejected }
  }

  const entries = list as unknown[]
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]
    const line = index + 1
    if (typeof entry === 'string') {
      const parsedLine = parseLine(entry, line)
      if (parsedLine === null) {
        rejected.push({ reason: 'malformed', sourceQuote: entry.slice(0, CLAIM_QUOTE_MAX), line })
      } else {
        candidates.push(parsedLine)
      }
      continue
    }
    if (entry === null || typeof entry !== 'object') {
      rejected.push({ reason: 'malformed', sourceQuote: JSON.stringify(entry).slice(0, CLAIM_QUOTE_MAX), line })
      continue
    }
    const record = entry as Record<string, unknown>
    const subject = textOrEmpty(record.subject)
    const predicate = textOrEmpty(record.predicate)
    const object = textOrEmpty(record.object)
    const quote = typeof record.sourceQuote === 'string' && record.sourceQuote.trim() !== ''
      ? record.sourceQuote.trim()
      : `${subject} ${predicate} ${object}`.trim()
    candidates.push({
      subject,
      predicate,
      object,
      falsifier: record.falsifier,
      confidence: record.confidence,
      sourceQuote: quote.slice(0, CLAIM_QUOTE_MAX),
      line,
    })
  }
  return { candidates, rejected }
}

function parseLineCandidates(text: string): { candidates: Candidate[]; rejected: RejectedClaim[] } {
  const candidates: Candidate[] = []
  const rejected: RejectedClaim[] = []
  const lines = text.split(/\r?\n/u)
  for (let index = 0; index < lines.length; index += 1) {
    const line = index + 1
    const raw = lines[index]!.trim()
    if (raw === '' || raw.startsWith('#')) continue
    const parsed = parseLine(raw, line)
    if (parsed === null) {
      rejected.push({ reason: 'malformed', sourceQuote: raw.slice(0, CLAIM_QUOTE_MAX), line })
    } else {
      candidates.push(parsed)
    }
  }
  return { candidates, rejected }
}

/** `subject | predicate | object | falsifier [| confidence]`；不合格返回 null。 */
function parseLine(raw: string, line: number): Candidate | null {
  const body = raw.replace(/^(?:[-*•]|\d+[.)])\s+/u, '').trim()
  const parts = body.split('|')
  if (parts.length < 4 || parts.length > 5) return null
  const subject = parts[0]!.trim()
  const predicate = parts[1]!.trim()
  const object = parts[2]!.trim()
  const falsifier = parts[3]!.trim()
  const confidence = parts.length === 5 ? parts[4]!.trim() : undefined
  if (subject === '' || predicate === '' || object === '') return null
  return { subject, predicate, object, falsifier, confidence, sourceQuote: body, line }
}

// ---- 归一化与校验 --------------------------------------------------------------

function reject(candidate: Candidate, reason: ClaimRejectionReason): RejectedClaim {
  return { reason, sourceQuote: candidate.sourceQuote.slice(0, CLAIM_QUOTE_MAX), line: candidate.line }
}

/** 去所有空白，再去首尾标点：`无法证伪。` 与 `无法证伪` 是同一句空话。 */
function normalizeFalsifier(value: string): string {
  return value
    .replace(/\s+/gu, '')
    .replace(/^[\p{P}\p{S}]+/u, '')
    .replace(/[\p{P}\p{S}]+$/u, '')
}

/** 去重键：三元组归一化（小写、空白折叠）后用单个空格拼接，便于与已有文本比较。 */
function claimKey(subject: string, predicate: string, object: string): string {
  return `${normalizeText(subject)} ${normalizeText(predicate)} ${normalizeText(object)}`
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/gu, ' ').toLowerCase()
}

function clampConfidence(value: unknown): number {
  let numeric: number
  if (typeof value === 'number') numeric = value
  else if (typeof value === 'string' && value.trim() !== '') numeric = Number(value.trim())
  else return CLAIM_DEFAULT_CONFIDENCE
  if (!Number.isFinite(numeric)) return CLAIM_DEFAULT_CONFIDENCE
  return Math.min(1, Math.max(0, numeric))
}

function textOrEmpty(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function readAlreadyToday(value: unknown): { count: number; texts: Set<string> } {
  if (value === undefined || value === null) return { count: 0, texts: new Set() }
  if (typeof value === 'number') {
    return { count: readCount(value, 'claims.alreadyToday'), texts: new Set() }
  }
  if (!Array.isArray(value)) {
    throw new ClaimError('claims.alreadyToday must be a count or an array of claim texts')
  }
  const texts = new Set<string>()
  for (const entry of value) {
    if (typeof entry !== 'string') {
      throw new ClaimError('claims.alreadyToday[] must be strings')
    }
    texts.add(normalizeText(entry))
  }
  return { count: value.length, texts }
}

function readAt(value: unknown, label: string): number {
  if (value === undefined || value === null) return Date.now()
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new ClaimError(`${label} must be an integer >= 0`)
  }
  return value
}

function readCount(value: unknown, label: string, fallback?: number): number {
  if (value === undefined || value === null) {
    if (fallback === undefined) throw new ClaimError(`${label} is required`)
    return fallback
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ClaimError(`${label} must be an integer >= 0`)
  }
  return value
}
