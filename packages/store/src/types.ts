// 本包用到的 node:sqlite 最小结构子集。
//
// 刻意不 import @types/node 的类型：仓库零依赖、只做类型擦除运行，不跑 tsc。
// 把依赖面写成结构类型，openStore 里把 DatabaseSync 断言成它。

export interface Statement {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint }
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
}

export interface Database {
  exec(sql: string): void
  prepare(sql: string): Statement
  close(): void
}

export interface StoreOptions {
  /** 迁移目录；默认是本仓库根下的 migrations/。 */
  migrationsDir?: string
  /** 文件库是否开 WAL（events.md §2 要求 WAL）；:memory: 忽略。默认 true。 */
  wal?: boolean
  /** 写锁等待毫秒数。默认 5000。 */
  busyTimeoutMs?: number
}

export interface Store {
  /** 已解析为绝对路径（或 ':memory:'）。 */
  readonly path: string
  readonly migrationsDir: string
  readonly db: Database
  /** openStore 本次实际执行的迁移文件，按文件名升序。 */
  readonly appliedMigrations: string[]
  readonly closed: boolean
  /** 幂等：重复调用不抛错。 */
  close(): void
}

export interface Actor {
  kind: string
  id: string
}

export interface Subject {
  kind: string
  id: string
}

/** 事件信封（events.md §3），seq 由存储层填。 */
export interface Event {
  id: string
  seq: number
  at: string
  domain: string
  kind: string
  actor: Actor | null
  subject: Subject | null
  audience: string | null
  parent: number | null
  idem: string | null
  trace: Record<string, unknown> | null
  v: number
  payload: Record<string, unknown>
}

export interface NewEvent {
  id?: string
  at?: string
  domain: string
  kind: string
  actor?: Actor | null
  subject?: Subject | null
  audience?: string | null
  parent?: number | null
  idem?: string | null
  trace?: Record<string, unknown> | null
  payload?: Record<string, unknown> | null
  v?: number
}

export interface ReadEventsQuery {
  afterSeq?: number
  domain?: string
  audience?: string
  /** 前向分页；与 afterSeq 一起用。 */
  limit?: number
}

export type HomeMode = 'cloud' | 'local'

export type WorkspaceState = 'absent' | 'stopped' | 'starting' | 'running' | 'stopping' | 'migrating'

export interface Workspace {
  id: string
  tenantId: string
  name: string
  homeMode: HomeMode
  state: WorkspaceState
  volumeId: string | null
  profileVersion: string
  createdAt: number
}

export interface CreateWorkspaceInput {
  id?: string
  tenantId: string
  name: string
  homeMode?: HomeMode
  state?: WorkspaceState
  volumeId?: string | null
  /** workspace.md §8: profile_ver NOT NULL，即镜像里的产品版本。 */
  profileVersion: string
  createdAt?: number
}

export interface PairingCode {
  code: string
  accountId: string
  workspaceId: string | null
  createdAt: number
  expiresAt: number
  usedAt: number | null
  attempts: number
}

export interface CreatePairingCodeInput {
  accountId: string
  workspaceId?: string | null
  /** 6 位数字（auth.md §3）。 */
  code: string
  /** epoch 毫秒，必须晚于 now。 */
  expiresAt: number
  /** 也用作 created_at；默认 Date.now()。 */
  now?: number
}

export interface ClaimPairingInput {
  code: string
  /** epoch 毫秒；默认 Date.now()。 */
  now?: number
  /** 尝试上限；默认 PAIRING_MAX_ATTEMPTS（5）。 */
  maxAttempts?: number
}

export interface PairingClaim {
  code: string
  accountId: string
  workspaceId: string | null
  createdAt: number
  usedAt: number
  attempts: number
}

export interface Session {
  id: string
  accountId: string
  deviceId: string
  /** 只存 sha256(token)；明文只在 claim 响应里出现一次。 */
  tokenHash: string
  createdAt: number
  lastSeenAt: number | null
  expiresAt: number
  revokedAt: number | null
}

export interface CreateSessionInput {
  id: string
  accountId: string
  deviceId: string
  tokenHash: string
  createdAt: number
  expiresAt: number
}
