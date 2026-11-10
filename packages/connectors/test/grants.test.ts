import assert from 'node:assert/strict'
import { test } from 'node:test'

import { isActionGranted, requiresApprovalForWrite } from '../src/types.ts'

const grant = { workspaceId: 'ws', botId: 'bot', slug: 'bank', access: 'write' as const }

test('an empty action list does not grant every action', () => {
  assert.equal(isActionGranted({ ...grant, actions: [] }, 'transfer_funds'), false)
  assert.equal(isActionGranted({ ...grant }, 'transfer_funds'), false)
  assert.equal(isActionGranted({ ...grant, actions: ['*'] }, 'transfer_funds'), true)
  assert.equal(isActionGranted({ ...grant, actions: ['list'] }, 'list'), true)
  assert.equal(isActionGranted(undefined, 'list'), false)
})

test('write access requires approval unless the action is on the read-only list', () => {
  for (const action of ['transfer_funds', 'remove_member', 'share_file', 'publish_release', 'refund', 'archive_repo']) {
    assert.equal(requiresApprovalForWrite('write', action), true, action)
  }
  assert.equal(requiresApprovalForWrite('write', 'list_issues'), false)
  assert.equal(requiresApprovalForWrite('read', 'delete_everything'), false)
})
