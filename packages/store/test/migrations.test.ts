import assert from 'node:assert/strict'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { appendEvent, openStore } from '../src/index.ts'
import { assertStoreError, tempDir, tempMigrations } from './helpers.ts'

function tableNames(store: ReturnType<typeof openStore>): string[] {
  return store.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => (row as { name: string }).name)
}

test('按文件名升序执行迁移；再次打开不重复执行', () => {
  const dir = tempDir()
  try {
    const dbPath = join(dir, 'workspace.db')

    const first = openStore(dbPath)
    assert.deepEqual(first.appliedMigrations, ['0001_core.sql', '0002_control_plane.sql', '0003_rooms.sql', '0004_bots.sql', '0005_rooms_rounds.sql', '0006_workspace_runtime.sql', '0007_dm_rooms.sql', '0008_approvals.sql', '0009_round_stopping.sql', '0010_bot_soft_delete.sql', '0011_approval_grants.sql', '0012_attachments.sql', '0013_marketplace.sql'])
    first.close()

    const second = openStore(dbPath)
    assert.deepEqual(second.appliedMigrations, [])
    assert.equal(second.migrationsDir.endsWith('/migrations'), true)
    second.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('核心表与索引都在', () => {
  const store = openStore(':memory:')
  try {
    const tables = tableNames(store)
    for (const name of [
      'events',
      'workspaces',
      'workspace_members',
      'accounts',
      'devices',
      'sessions',
      'pairing_codes',
      'runtimes',
      'capability_grants',
      'invites',
      'schema_migrations',
      'attachments',
      'attachment_refs',
      'artifacts',
      'message_attachments',
      'plugin_publishers',
      'plugin_market',
      'plugin_versions',
      'plugin_installs',
    ]) {
      assert.ok(tables.includes(name), `missing table ${name}`)
    }

    const indexes = store.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%' ORDER BY name")
      .all()
      .map((row) => (row as { name: string }).name)
    for (const name of [
      'idx_events_domain_seq',
      'idx_events_audience_seq',
      'idx_events_kind_seq',
      'idx_sessions_token',
      'idx_pairing_codes_expires',
      'idx_attachments_workspace',
      'idx_attachments_gc',
      'idx_message_attachments_message',
      'idx_plugin_market_category',
      'idx_plugin_market_tier',
      'idx_plugin_versions_slug',
      'idx_plugin_installs_workspace',
    ]) {
      assert.ok(indexes.includes(name), `missing index ${name}`)
    }

    // events.seq 必须是 AUTOINCREMENT：DDL 里声明，且写入后 sqlite_sequence 跟着走（删行也不复用序号）。
    const ddl = store.db
      .prepare("SELECT sql FROM sqlite_master WHERE name = 'events'")
      .get() as { sql: string }
    assert.match(ddl.sql, /AUTOINCREMENT/)
    assert.equal(
      store.db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'events'").get(),
      undefined,
    )
    const first = appendEvent(store, { domain: 'chat', kind: 'chat.message' })
    const sequence = store.db
      .prepare("SELECT seq FROM sqlite_sequence WHERE name = 'events'")
      .get() as { seq: number }
    assert.equal(sequence.seq, first.seq)

    // events.parent 是外键（时间线完整性的唯一外键）。
    const fks = store.db
      .prepare('PRAGMA foreign_key_list(events)')
      .all()
      .map((row) => (row as { table: string; from: string }).from)
    assert.deepEqual(fks, ['parent'])
  } finally {
    store.close()
  }
})

test('文件库开 WAL（events.md §2）', () => {
  const dir = tempDir()
  try {
    const store = openStore(join(dir, 'workspace.db'))
    try {
      const mode = store.db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }
      assert.equal(mode.journal_mode, 'wal')
    } finally {
      store.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('迁移失败整体回滚并抛 MIGRATION_FAILED，修好后可继续', () => {
  const migrations = tempMigrations({
    '0001_ok.sql': 'CREATE TABLE ok (id TEXT);',
    '0002_bad.sql': 'CREATE TABLE half (id TEXT);\nCREATE TABLE bad (',
  })
  const dir = tempDir()
  try {
    const dbPath = join(dir, 'workspace.db')
    assertStoreError(() => openStore(dbPath, { migrationsDir: migrations }), 'MIGRATION_FAILED')

    // 修好 0002 再打开：只补跑 0002，0001 不重复，失败那次建的 half 表已回滚掉。
    writeFileSync(join(migrations, '0002_bad.sql'), 'CREATE TABLE fixed (id TEXT);', 'utf8')
    const store = openStore(dbPath, { migrationsDir: migrations })
    try {
      assert.deepEqual(store.appliedMigrations, ['0002_bad.sql'])
      const tables = tableNames(store)
      assert.ok(tables.includes('ok'))
      assert.ok(tables.includes('fixed'))
      assert.equal(tables.includes('half'), false, 'failed migration must not leave partial schema')
    } finally {
      store.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(migrations, { recursive: true, force: true })
  }
})

test('迁移目录缺失或为空都抛 MIGRATIONS_NOT_FOUND', () => {
  const dir = tempDir()
  try {
    assertStoreError(
      () => openStore(join(dir, 'a.db'), { migrationsDir: join(dir, 'nope') }),
      'MIGRATIONS_NOT_FOUND',
    )

    const empty = tempMigrations({})
    try {
      assertStoreError(
        () => openStore(join(dir, 'b.db'), { migrationsDir: empty }),
        'MIGRATIONS_NOT_FOUND',
      )
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('openStore 会建父目录；空路径直接拒绝', () => {
  const dir = tempDir()
  try {
    const nested = join(dir, 'a', 'b', 'c', 'workspace.db')
    const store = openStore(nested)
    store.close()
    assert.equal(existsSync(nested), true)

    assertStoreError(() => openStore(''), 'INVALID_PATH')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test(':memory: 也能跑迁移（测试用）', () => {
  const store = openStore(':memory:')
  try {
    assert.equal(store.path, ':memory:')
    assert.deepEqual(store.appliedMigrations, ['0001_core.sql', '0002_control_plane.sql', '0003_rooms.sql', '0004_bots.sql', '0005_rooms_rounds.sql', '0006_workspace_runtime.sql', '0007_dm_rooms.sql', '0008_approvals.sql', '0009_round_stopping.sql', '0010_bot_soft_delete.sql', '0011_approval_grants.sql', '0012_attachments.sql', '0013_marketplace.sql'])
  } finally {
    store.close()
  }
})
