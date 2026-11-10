import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'

import { applyMigrations } from '../src/migrations.ts'
import { StoreError } from '../src/errors.ts'
import type { Database } from '../src/types.ts'

test('a changed migration file is rejected once its checksum is recorded', () => {
  const db = new DatabaseSync(':memory:') as unknown as Database
  applyMigrations(db, [{ name: '0001_demo.sql', sql: 'CREATE TABLE demo (id INTEGER PRIMARY KEY)' }])
  assert.throws(
    () => applyMigrations(db, [{ name: '0001_demo.sql', sql: 'CREATE TABLE demo (id INTEGER PRIMARY KEY); SELECT 1' }]),
    (error: unknown) => error instanceof StoreError && error.code === 'MIGRATION_FAILED',
  )
  db.close()
})

test('two processes opening a new database both succeed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'roost-migrate-race-'))
  const repo = join(import.meta.dirname, '..', '..', '..')
  try {
    for (let round = 0; round < 6; round += 1) {
      const dbPath = join(dir, `race-${round}.db`)
      const results = await Promise.all([0, 1].map(() => runOpen(repo, dbPath)))
      for (const result of results) {
        assert.equal(result.code, 0, result.stderr)
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

function runOpen(repo: string, dbPath: string): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ['--experimental-strip-types', '-e', "import { openStore } from './packages/store/src/index.ts'; const s = openStore(process.argv[1]); s.close()", dbPath],
      { cwd: repo },
    )
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('close', (code) => resolve({ code, stderr }))
  })
}
