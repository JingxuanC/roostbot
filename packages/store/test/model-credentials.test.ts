import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { openStore } from '../src/index.ts'
import {
  deleteWorkspaceModelCredential,
  getWorkspaceModelCredential,
  saveWorkspaceModelCredential
} from '../src/model-credentials.ts'

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'roost-model-cred-'))
  return { store: openStore(join(dir, 'db.sqlite')), dir }
}

test('保存/更新/删除 workspace 模型凭据，密文原样读写', () => {
  const { store, dir } = setup()
  try {
    const first = saveWorkspaceModelCredential(store, {
      workspaceId: 'ws_1',
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-v4-flash',
      keyCiphertext: 'cipher',
      keyIv: 'iv',
      keyTag: 'tag',
      keyHint: '…abcd',
      updatedBy: 'acc_1',
      at: 1000
    })
    assert.equal(first.workspaceId, 'ws_1')
    assert.equal(first.model, 'deepseek-v4-flash')
    assert.equal(first.keyCiphertext, 'cipher')
    assert.equal(first.createdAt, 1000)
    const loaded = getWorkspaceModelCredential(store, 'ws_1')
    assert.equal(loaded?.keyHint, '…abcd')

    const updated = saveWorkspaceModelCredential(store, {
      workspaceId: 'ws_1',
      provider: 'openai-compatible',
      baseUrl: 'https://router.example/v1',
      model: 'my-model',
      keyCiphertext: 'cipher2',
      keyIv: 'iv2',
      keyTag: 'tag2',
      keyHint: '…wxyz',
      updatedBy: 'acc_2',
      at: 2000
    })
    assert.equal(updated.createdAt, 1000)
    assert.equal(updated.updatedAt, 2000)
    assert.equal(getWorkspaceModelCredential(store, 'ws_1')?.provider, 'openai-compatible')

    assert.equal(deleteWorkspaceModelCredential(store, 'ws_1'), true)
    assert.equal(getWorkspaceModelCredential(store, 'ws_1'), null)
    assert.equal(deleteWorkspaceModelCredential(store, 'ws_1'), false)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('输入校验：空字段抛 INVALID_INPUT', () => {
  const { store, dir } = setup()
  try {
    assert.throws(
      () => saveWorkspaceModelCredential(store, {
        workspaceId: '',
        provider: 'deepseek',
        baseUrl: 'https://api.deepseek.com',
        model: 'm',
        keyCiphertext: 'c',
        keyIv: 'i',
        keyTag: 't',
        keyHint: '…1234'
      }),
      /workspaceId/
    )
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
