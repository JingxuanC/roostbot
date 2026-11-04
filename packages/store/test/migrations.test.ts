import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
    assert.deepEqual(first.appliedMigrations, ['0001_core.sql', '0002_control_plane.sql', '0003_rooms.sql', '0004_bots.sql', '0005_rooms_rounds.sql', '0006_workspace_runtime.sql', '0007_dm_rooms.sql', '0008_approvals.sql', '0009_round_stopping.sql', '0010_bot_soft_delete.sql', '0011_approval_grants.sql', '0012_attachments.sql', '0013_marketplace.sql', '0014_budget.sql', '0015_schedules.sql', '0016_connectors.sql', '0017_memories.sql', '0018_budget_layers.sql', '0019_auth.sql', '0020_marketplace_jobs.sql'])
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
      'quotas',
      'reservations',
      'usage_rows',
      'workspace_schedules',
      'activations',
      'runs',
      'run_events',
      'connections',
      'connector_grants',
      'connector_calls',
      'memories',
      'memory_evidence',
      'memory_reads',
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
      'idx_quotas_scope',
      'idx_reservations_run',
      'idx_usage_rows_workspace_at',
      'idx_schedules_next_run',
      'idx_activations_workspace_created',
      'idx_runs_activation',
      'idx_run_events_run_at',
      'idx_connections_workspace',
      'idx_connector_grants_workspace',
      'idx_connector_calls_idem',
      'idx_connector_calls_workspace_at',
      'idx_memories_workspace',
      'idx_memory_evidence_memory',
      'idx_memory_reads_memory_at',
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

test('0018 重建 quotas：旧数据保留、scope 扩到 run/turn、usage_rows 新列', () => {
  const repoMigrations = new URL('../../../migrations/', import.meta.url)
  const migrations = tempMigrations({
    '0014_budget.sql': readFileSync(new URL('0014_budget.sql', repoMigrations), 'utf8'),
  })
  const dir = tempDir()
  try {
    const dbPath = join(dir, 'workspace.db')

    const before = openStore(dbPath, { migrationsDir: migrations })
    before.db
      .prepare(
        `INSERT INTO quotas (id, scope, scope_id, period, metric, limit_value, used_value, reserved, resets_at)
         VALUES ('qta_old', 'workspace', 'ws_old', 'day', 'tokens', 1000, 200, 50, 111)`,
      )
      .run()
    before.db
      .prepare(
        `INSERT INTO usage_rows (id, at, workspace_id, turn_id, input_tokens, source, idem)
         VALUES ('usg_old', 1, 'ws_old', 'turn_old', 10, 'provider_report', 'turn_old:provider_report')`,
      )
      .run()
    before.close()

    // 同一个迁移目录补上 0018 再打开：只补跑新迁移。
    writeFileSync(
      join(migrations, '0018_budget_layers.sql'),
      readFileSync(new URL('0018_budget_layers.sql', repoMigrations), 'utf8'),
      'utf8',
    )
    const store = openStore(dbPath, { migrationsDir: migrations })
    try {
      assert.deepEqual(store.appliedMigrations, ['0018_budget_layers.sql'])

      // 旧行原样保留。
      const old = store.db.prepare('SELECT * FROM quotas WHERE id = ?').get('qta_old') as Record<string, unknown>
      assert.equal(old.scope, 'workspace')
      assert.equal(old.limit_value, 1000)
      assert.equal(old.used_value, 200)
      assert.equal(old.reserved, 50)
      assert.equal(old.resets_at, 111)

      // 新 scope 可写入，非法 scope 仍被 CHECK 拦住。
      store.db
        .prepare(
          `INSERT INTO quotas (id, scope, scope_id, period, metric, limit_value, used_value, reserved)
           VALUES ('qta_run', 'run', 'run_1', 'day', 'tokens', 100, 0, 0),
                  ('qta_turn', 'turn', 'turn_1', 'day', 'tokens', 50, 0, 0)`,
        )
        .run()
      assert.throws(() =>
        store.db
          .prepare(
            `INSERT INTO quotas (id, scope, scope_id, period, metric, limit_value, used_value, reserved)
             VALUES ('qta_bad', 'bogus', 'x', 'day', 'tokens', 1, 0, 0)`,
          )
          .run(),
      )
      // UNIQUE (scope, scope_id, period, metric) 仍在。
      assert.throws(() =>
        store.db
          .prepare(
            `INSERT INTO quotas (id, scope, scope_id, period, metric, limit_value, used_value, reserved)
             VALUES ('qta_dup', 'run', 'run_1', 'day', 'tokens', 1, 0, 0)`,
          )
          .run(),
      )

      // 索引与新增列都在；旧 usage 行的新列为 NULL。
      const indexes = store.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_quotas_scope'")
        .all()
      assert.equal(indexes.length, 1)
      const columns = store.db
        .prepare('PRAGMA table_info(usage_rows)')
        .all()
        .map((row) => (row as { name: string }).name)
      assert.ok(columns.includes('container_seconds'))
      assert.ok(columns.includes('storage_bytes'))
      const oldUsage = store.db.prepare('SELECT * FROM usage_rows WHERE id = ?').get('usg_old') as Record<string, unknown>
      assert.equal(oldUsage.input_tokens, 10)
      assert.equal(oldUsage.container_seconds, null)
      assert.equal(oldUsage.storage_bytes, null)

      store.db
        .prepare('UPDATE usage_rows SET container_seconds = 12.5, storage_bytes = 4096 WHERE id = ?')
        .run('usg_old')
      const updated = store.db.prepare('SELECT * FROM usage_rows WHERE id = ?').get('usg_old') as Record<string, unknown>
      assert.equal(updated.container_seconds, 12.5)
      assert.equal(updated.storage_bytes, 4096)
    } finally {
      store.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(migrations, { recursive: true, force: true })
  }
})

test(':memory: 也能跑迁移（测试用）', () => {
  const store = openStore(':memory:')
  try {
    assert.equal(store.path, ':memory:')
    assert.deepEqual(store.appliedMigrations, ['0001_core.sql', '0002_control_plane.sql', '0003_rooms.sql', '0004_bots.sql', '0005_rooms_rounds.sql', '0006_workspace_runtime.sql', '0007_dm_rooms.sql', '0008_approvals.sql', '0009_round_stopping.sql', '0010_bot_soft_delete.sql', '0011_approval_grants.sql', '0012_attachments.sql', '0013_marketplace.sql', '0014_budget.sql', '0015_schedules.sql', '0016_connectors.sql', '0017_memories.sql', '0018_budget_layers.sql', '0019_auth.sql', '0020_marketplace_jobs.sql'])
  } finally {
    store.close()
  }
})
