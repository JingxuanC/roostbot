import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import {
  APPROVAL_KINDS,
  MANIFEST_SCHEMA,
  MEMORY_SCOPES,
  MODEL_TIERS,
  validateManifest,
} from '../src/index.ts'

const valid = {
  schema: 'roostbot.bot/v1',
  id: 'selector',
  name: '选股师',
  role: '选股',
  instructions: 'skills/selector.md',
}

test('example.bot.json 合法', () => {
  const example: unknown = JSON.parse(
    readFileSync(new URL('../example.bot.json', import.meta.url), 'utf8'),
  )
  const result = validateManifest(example)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.manifest.id, 'selector')
})

test('最小 manifest 合法，枚举表与 schema 一致', () => {
  assert.equal(validateManifest(valid).ok, true)
  assert.equal(MANIFEST_SCHEMA, 'roostbot.bot/v1')
  assert.deepEqual([...MODEL_TIERS], ['fast', 'standard', 'deep'])
  assert.deepEqual([...MEMORY_SCOPES], ['team', 'room', 'member'])
  assert.deepEqual([...APPROVAL_KINDS], [
    'write_outside_workspace', 'network_egress', 'spend', 'install_plugin', 'read_secret',
  ])
})

test('必填字段缺失按固定顺序报错', () => {
  assert.deepEqual(validateManifest({}), {
    ok: false,
    errors: [
      '$.schema: required',
      '$.id: required',
      '$.name: required',
      '$.role: required',
      '$.instructions: required',
    ],
  })
})

test('长度/枚举/结构错误一次性收集', () => {
  const result = validateManifest({
    schema: 'roostbot.bot/v2',
    id: 'Selector',
    name: '',
    role: 'x'.repeat(21),
    description: 'x'.repeat(401),
    instructions: 'ok',
    color: 'Blue',
    model: { tier: 'giant', providerRef: '' },
    tools: { allow: 'bash', deny: [1] },
    skills: Array.from({ length: 61 }, () => 's'),
    approvals: ['network_egress', 'root'],
    memory: { enabled: 'yes', scopes: ['team', 'galaxy'], retentionDays: 3651 },
    schedule: { cron: '', timezone: '', checks: ['ok', ''] },
  })
  assert.deepEqual(result, {
    ok: false,
    errors: [
      '$.schema: expected "roostbot.bot/v1"',
      '$.id: expected /^[a-z][a-z0-9-]{1,40}$/',
      '$.name: expected length >= 1',
      '$.role: expected length <= 20',
      '$.description: expected length <= 400',
      '$.color: expected /^[a-z]+$/',
      '$.model.tier: expected one of fast, standard, deep',
      '$.model.providerRef: expected length >= 1',
      '$.tools.allow: expected an array',
      '$.tools.deny[0]: expected a non-empty string',
      '$.skills: expected at most 60 items',
      '$.approvals[1]: expected one of write_outside_workspace, network_egress, spend, install_plugin, read_secret',
      '$.memory.enabled: expected a boolean',
      '$.memory.scopes[1]: expected one of team, room, member',
      '$.memory.retentionDays: expected an integer between 1 and 3650',
      '$.schedule.cron: expected length >= 1',
      '$.schedule.timezone: expected length >= 1',
      '$.schedule.checks[1]: expected a non-empty string',
    ],
  })
})

test('panels 结构校验', () => {
  const result = validateManifest({
    ...valid,
    panels: [
      { name: 'portfolio', title: '持仓', slot: 'main', path: '/portfolio' },
      {
        name: '',
        title: 'x'.repeat(201),
        slot: 's'.repeat(65),
        path: 'p'.repeat(513),
        extra: 1,
      },
      'nope',
    ],
  })
  assert.deepEqual(result, {
    ok: false,
    errors: [
      '$.panels[1]: unknown field "extra"',
      '$.panels[1].name: expected length >= 1',
      '$.panels[1].title: expected length <= 200',
      '$.panels[1].slot: expected length <= 64',
      '$.panels[1].path: expected length <= 512',
      '$.panels[2]: expected an object',
    ],
  })
})

test('未知顶层字段与未知子结构字段报错', () => {
  assert.deepEqual(validateManifest({ ...valid, extra: 1 }), {
    ok: false,
    errors: ['$: unknown field "extra"'],
  })
  assert.deepEqual(validateManifest({ ...valid, tools: { allow: [], delete: [] } }), {
    ok: false,
    errors: ['$.tools: unknown field "delete"'],
  })
})

test('非对象输入直接失败', () => {
  assert.deepEqual(validateManifest(null), { ok: false, errors: ['$: expected an object'] })
  assert.deepEqual(validateManifest([]), { ok: false, errors: ['$: expected an object'] })
})
