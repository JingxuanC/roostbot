// 迁移执行器：按文件名升序执行 migrations/*.sql，已执行的记进 schema_migrations。
//
// 只做「执行 + 记账」；不解析 SQL，也不做 down 迁移（设计文档没有回滚要求，
// 变更一律用新的迁移文件追加）。

import { createHash } from 'node:crypto'
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

function migrationChecksum(sql: string): string {
  return createHash('sha256').update(sql).digest('hex')
}

function ensureMigrationsTable(db: Database): void {
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)',
  )
  const columns = db.prepare('PRAGMA table_info(schema_migrations)').all() as Array<{ name: string }>
  if (!columns.some((column) => column.name === 'checksum')) {
    db.exec('ALTER TABLE schema_migrations ADD COLUMN checksum TEXT')
  }
}

function recordedChecksum(db: Database, name: string): string | null {
  const row = db.prepare('SELECT checksum FROM schema_migrations WHERE name = ?').get(name) as
    | { checksum: string | null }
    | undefined
  if (row === undefined || row === null) return null
  return row.checksum ?? null
}

function assertChecksum(name: string, recorded: string | null, checksum: string): void {
  if (recorded !== null && recorded !== checksum) {
    throw new StoreError('MIGRATION_FAILED', `migration ${name} checksum mismatch`)
  }
}

/** 返回本次实际执行的迁移文件名（升序）。 */
export function applyMigrations(
  db: Database,
  migrations: Migration[],
  now: number = Date.now(),
): string[] {
  ensureMigrationsTable(db)

  const before = new Set(
    db
      .prepare('SELECT name FROM schema_migrations')
      .all()
      .map((row) => (row as { name: string }).name),
  )

  const applied: string[] = []
  for (const migration of migrations) {
    const checksum = migrationChecksum(migration.sql)
    if (before.has(migration.name)) {
      assertChecksum(migration.name, recordedChecksum(db, migration.name), checksum)
      continue
    }

    let ran = false
    try {
      // 锁内再读一次。两个进程同时打开新库时，后到的那个会看到先到的已经记过账。
      db.exec('BEGIN IMMEDIATE')
      const recorded = recordedChecksum(db, migration.name)
      if (recorded !== null || beforeNamePresent(db, migration.name)) {
        assertChecksum(migration.name, recorded, checksum)
        db.exec('COMMIT')
        continue
      }
      db.exec(migration.sql)
      db.prepare('INSERT INTO schema_migrations (name, applied_at, checksum) VALUES (?, ?, ?)').run(
        migration.name,
        now,
        checksum,
      )
      db.exec('COMMIT')
      ran = true
    } catch (err) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // 事务可能已经被 sqlite 自动回滚；原始错误更重要。
      }
      if (err instanceof StoreError) throw err
      throw new StoreError(
        'MIGRATION_FAILED',
        `migration ${migration.name} failed: ${errorMessage(err)}`,
        { cause: err },
      )
    }

    if (ran) applied.push(migration.name)
  }

  return applied
}

function beforeNamePresent(db: Database, name: string): boolean {
  return db.prepare('SELECT 1 AS ok FROM schema_migrations WHERE name = ?').get(name) !== undefined
}
