// 迁移执行器：按文件名升序执行 migrations/*.sql，已执行的记进 schema_migrations。
//
// 只做「执行 + 记账」；不解析 SQL，也不做 down 迁移（设计文档没有回滚要求，
// 变更一律用新的迁移文件追加）。

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { StoreError } from './errors.ts'
import { errorMessage } from './internal.ts'
import type { Database } from './types.ts'

export interface Migration {
  name: string
  sql: string
}

export function discoverMigrations(dir: string): Migration[] {
  const names = readdirSync(dir)
    .filter((name) => name.endsWith('.sql') && !name.startsWith('.'))
    .sort()

  if (names.length === 0) {
    throw new StoreError('MIGRATIONS_NOT_FOUND', `no .sql migrations found in ${dir}`)
  }

  return names.map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') }))
}

/** 返回本次实际执行的迁移文件名（升序）。 */
export function applyMigrations(
  db: Database,
  migrations: Migration[],
  now: number = Date.now(),
): string[] {
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)',
  )

  const before = new Set(
    db
      .prepare('SELECT name FROM schema_migrations')
      .all()
      .map((row) => (row as { name: string }).name),
  )

  const applied: string[] = []
  for (const migration of migrations) {
    if (before.has(migration.name)) continue

    try {
      db.exec('BEGIN IMMEDIATE')
      db.exec(migration.sql)
      db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(
        migration.name,
        now,
      )
      db.exec('COMMIT')
    } catch (err) {
      // 迁移失败整体回滚，且不记入 schema_migrations——下次打开会再试并再次报错，不静默跳过。
      try {
        db.exec('ROLLBACK')
      } catch {
        // 事务可能已经被 sqlite 自动回滚；原始错误更重要。
      }
      throw new StoreError(
        'MIGRATION_FAILED',
        `migration ${migration.name} failed: ${errorMessage(err)}`,
        { cause: err },
      )
    }

    applied.push(migration.name)
  }

  return applied
}
