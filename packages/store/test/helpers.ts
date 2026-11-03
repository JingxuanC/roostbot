// 测试助手：每个用例一个临时目录里的真库，结束后关库 + 删目录。
// 注意：本文件不叫 *.test.ts，不会被 node:test 当成用例文件。

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openStore, StoreError } from '../src/index.ts'
import type { Store } from '../src/index.ts'

export function tempDir(prefix = 'roost-store-'): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

export async function withStore(
  fn: (store: Store) => void | Promise<void>,
  options: { dir?: string } = {},
): Promise<void> {
  const dir = options.dir ?? tempDir()
  const store = openStore(join(dir, 'workspace.db'))
  try {
    await fn(store)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

export function assertStoreError(fn: () => unknown, code: string): void {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof StoreError, `expected StoreError, got ${String(err)}`)
    assert.equal(err.code, code, `expected code ${code}, got ${err.code} (${err.message})`)
    return true
  })
}

/** 临时迁移目录，用于测迁移失败/缺失。 */
export function tempMigrations(files: Record<string, string>): string {
  const dir = tempDir('roost-migrations-')
  mkdirSync(dir, { recursive: true })
  for (const [name, sql] of Object.entries(files)) {
    writeFileSync(join(dir, name), sql, 'utf8')
  }
  return dir
}
