import { existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { StoreError } from './errors.ts'
import { applyMigrations, discoverMigrations } from './migrations.ts'
import type { Database, Store, StoreOptions } from './types.ts'

/** 仓库根下的 migrations/（src → store → packages → 根）。 */
const DEFAULT_MIGRATIONS_DIR = resolve(import.meta.dirname, '..', '..', '..', 'migrations')

/**
 * 打开（必要时创建）一个 workspace 库，并把未执行的迁移跑完。
 *
 * - 文件库默认开 WAL（events.md §2）；`:memory:` 不适用。
 * - 迁移目录默认是仓库根的 migrations/，可用 options.migrationsDir 覆盖（测试/打包用）。
 * - 迁移失败会抛 StoreError('MIGRATION_FAILED')，不会留下半套 schema。
 */
export function openStore(path: string, options: StoreOptions = {}): Store {
  if (typeof path !== 'string' || path.trim() === '') {
    throw new StoreError('INVALID_PATH', 'openStore(path) requires a non-empty path')
  }

  const inMemory = path === ':memory:' || path.startsWith('file::memory:')
  const target = inMemory ? path : resolve(path)

  if (!inMemory && !target.startsWith('file:')) {
    mkdirSync(dirname(target), { recursive: true })
  }

  const migrationsDir =
    options.migrationsDir === undefined ? DEFAULT_MIGRATIONS_DIR : resolve(options.migrationsDir)
  if (!existsSync(migrationsDir)) {
    throw new StoreError('MIGRATIONS_NOT_FOUND', `migrations directory not found: ${migrationsDir}`)
  }

  const busyTimeoutMs = options.busyTimeoutMs ?? 5000
  if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 0) {
    throw new StoreError('INVALID_INPUT', 'busyTimeoutMs must be a non-negative integer')
  }

  const db = new DatabaseSync(target) as unknown as Database

  let applied: string[] = []
  try {
    db.exec('PRAGMA foreign_keys = ON')
    db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`)
    if (options.wal !== false && !inMemory) {
      db.exec('PRAGMA journal_mode = WAL')
    }
    applied = applyMigrations(db, discoverMigrations(migrationsDir))
  } catch (err) {
    try {
      db.close()
    } catch {
      // 打不开就关不掉是正常的；保留原始错误。
    }
    throw err
  }

  let closed = false

  return {
    path: target,
    migrationsDir,
    db,
    appliedMigrations: applied.slice(),
    get closed(): boolean {
      return closed
    },
    close(): void {
      if (closed) return
      closed = true
      db.close()
    },
  }
}
