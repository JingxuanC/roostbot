import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { openStore } from '../../../packages/store/src/index.ts'
import { createBot } from '../../../packages/store/src/bots.ts'
import { createWorkspace } from '../../../packages/store/src/workspaces.ts'
import { botCredentialEnvMap, parseBotCredentialFile } from '../src/bot-credentials.ts'

test('credential file parses only allowlisted vendor env', () => {
  const registry = parseBotCredentialFile(JSON.stringify({
    'vault://claude-a': { ANTHROPIC_API_KEY: 'sk-a', ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic' },
    'env://codex-b': { OPENAI_API_KEY: 'sk-b', OPENAI_BASE_URL: 'https://api.deepseek.com/v1' },
  }))
  assert.equal(registry['vault://claude-a']?.ANTHROPIC_API_KEY, 'sk-a')
  assert.equal(registry['env://codex-b']?.OPENAI_BASE_URL, 'https://api.deepseek.com/v1')
  assert.throws(() => parseBotCredentialFile(JSON.stringify({ 'vault://x': { AWS_SECRET: 'no' } })), /unsupported env/)
  assert.throws(() => parseBotCredentialFile('[]'), /JSON object/)
})

test('workspace has one credential map per Bot, not global', () => {
  const dir = mkdtempSync(join(tmpdir(), 'roost-bot-creds-'))
  const store = openStore(join(dir, 'store.db'))
  try {
    const workspace = createWorkspace(store, { tenantId: 't', name: 'W', profileVersion: 'dev' })
    const a = createBot(store, { workspaceId: workspace.id, name: 'A', model: 'deepseek-chat', credentialRef: 'vault://a', createdBy: 'acc_t' })
    createBot(store, { workspaceId: workspace.id, name: 'B', model: 'deepseek-chat', credentialRef: 'vault://b', createdBy: 'acc_t' })
    const env = botCredentialEnvMap(store, workspace.id, {
      'vault://a': { ANTHROPIC_API_KEY: 'key-a' },
      'vault://b': { OPENAI_API_KEY: 'key-b' },
    })
    assert.deepEqual(env, {
      [a.id]: { ANTHROPIC_API_KEY: 'key-a' },
      [Object.keys(env).find((id) => id !== a.id)!]: { OPENAI_API_KEY: 'key-b' },
    })
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
