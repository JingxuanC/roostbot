// 清理计划：只清「被否证 + 超保留期」，retracted 与最近 N 条不动。

import assert from 'node:assert/strict'
import test from 'node:test'

import { ClaimError } from '../src/claims.ts'
import {
  DEFAULT_CLEANUP_KEEP_RECENT,
  DEFAULT_FALSIFIED_RETENTION_MS,
  planCleanup,
} from '../src/cleanup.ts'

const NOW = Date.UTC(2026, 10, 4, 12, 0, 0)
const DAY = 86_400_000

test('未被否证的条目一律 keep（不论多老）', () => {
  const plan = planCleanup({
    claims: [
      { id: 'a', status: 'active', createdAt: NOW - 90 * DAY },
      { id: 'b', status: 'superseded', createdAt: NOW - 90 * DAY },
      { id: 'c', status: 'expired', createdAt: NOW - 90 * DAY },
      { id: 'd', status: 'active', falsifiedAt: null, createdAt: NOW - 90 * DAY },
    ],
    now: NOW,
    falsifiedOlderThanMs: DAY,
    keepRecent: 0,
  })
  assert.deepEqual(plan, { remove: [], keep: ['a', 'b', 'c', 'd'] })
})

test('被否证且超过保留期 → remove；未超 → keep', () => {
  const plan = planCleanup({
    claims: [
      { id: 'old', status: 'active', falsifiedAt: NOW - 3 * DAY, createdAt: NOW - 30 * DAY },
      { id: 'fresh', status: 'active', falsifiedAt: NOW - 1 * DAY, createdAt: NOW - 30 * DAY },
    ],
    now: NOW,
    falsifiedOlderThanMs: 2 * DAY,
    keepRecent: 0,
  })
  assert.deepEqual(plan.remove, ['old'])
  assert.deepEqual(plan.keep, ['fresh'])
})

test('边界：正好等于保留期不清（“超过”才清），多 1ms 就清', () => {
  const at = planCleanup({
    claims: [{ id: 'edge', falsifiedAt: NOW - 1000, createdAt: 0 }],
    now: NOW,
    falsifiedOlderThanMs: 1000,
    keepRecent: 0,
  })
  assert.deepEqual(at, { remove: [], keep: ['edge'] })

  const over = planCleanup({
    claims: [{ id: 'edge', falsifiedAt: NOW - 1001, createdAt: 0 }],
    now: NOW,
    falsifiedOlderThanMs: 1000,
    keepRecent: 0,
  })
  assert.deepEqual(over, { remove: ['edge'], keep: [] })
})

test('retracted 不动（即使被否证且超期）', () => {
  const plan = planCleanup({
    claims: [
      { id: 'retracted', status: 'retracted', falsifiedAt: NOW - 60 * DAY, createdAt: NOW - 60 * DAY },
      { id: 'falsified', status: 'active', falsifiedAt: NOW - 60 * DAY, createdAt: NOW - 60 * DAY },
    ],
    now: NOW,
    falsifiedOlderThanMs: DAY,
    keepRecent: 0,
  })
  assert.deepEqual(plan.remove, ['falsified'])
  assert.deepEqual(plan.keep, ['retracted'])
})

test('最近 keepRecent 条不动（按 createdAt，缺省按输入顺序）', () => {
  const plan = planCleanup({
    claims: [
      { id: 'old', falsifiedAt: NOW - 60 * DAY, createdAt: NOW - 10 * DAY },
      { id: 'mid', falsifiedAt: NOW - 60 * DAY, createdAt: NOW - 5 * DAY },
      { id: 'new', falsifiedAt: NOW - 60 * DAY, createdAt: NOW - 1 * DAY },
    ],
    now: NOW,
    falsifiedOlderThanMs: DAY,
    keepRecent: 2,
  })
  assert.deepEqual(plan.remove, ['old'])
  assert.deepEqual(plan.keep, ['mid', 'new'])

  const noCreatedAt = planCleanup({
    claims: [
      { id: 'first', falsifiedAt: NOW - 60 * DAY },
      { id: 'second', falsifiedAt: NOW - 60 * DAY },
      { id: 'third', falsifiedAt: NOW - 60 * DAY },
    ],
    now: NOW,
    falsifiedOlderThanMs: DAY,
    keepRecent: 1,
  })
  assert.deepEqual(noCreatedAt.remove, ['first', 'second'])
  assert.deepEqual(noCreatedAt.keep, ['third'])
})

test('keepRecent 大于条数时全部保留；keepRecent=0 时不做保护', () => {
  const claims = [
    { id: 'a', falsifiedAt: NOW - 60 * DAY, createdAt: NOW - 2 * DAY },
    { id: 'b', falsifiedAt: NOW - 60 * DAY, createdAt: NOW - 1 * DAY },
  ]
  assert.deepEqual(planCleanup({ claims, now: NOW, falsifiedOlderThanMs: DAY, keepRecent: 10 }), {
    remove: [],
    keep: ['a', 'b'],
  })
  assert.deepEqual(planCleanup({ claims, now: NOW, falsifiedOlderThanMs: DAY, keepRecent: 0 }), {
    remove: ['a', 'b'],
    keep: [],
  })
})

test('remove 与 keep 覆盖每个 id 恰好一次、保持输入顺序、重复 id 去重', () => {
  const plan = planCleanup({
    claims: [
      { id: 'k1', createdAt: NOW - 5 * DAY },
      { id: 'r1', falsifiedAt: NOW - 60 * DAY, createdAt: NOW - 10 * DAY },
      { id: 'k2', createdAt: NOW - 4 * DAY },
      { id: 'r2', falsifiedAt: NOW - 60 * DAY, createdAt: NOW - 9 * DAY },
      { id: 'r1', falsifiedAt: NOW - 60 * DAY },
    ],
    now: NOW,
    falsifiedOlderThanMs: DAY,
    keepRecent: 0,
  })
  assert.deepEqual(plan.remove, ['r1', 'r2'])
  assert.deepEqual(plan.keep, ['k1', 'k2'])
  const all = [...plan.remove, ...plan.keep].sort()
  assert.deepEqual(all, ['k1', 'k2', 'r1', 'r2'])
  assert.equal(new Set(all).size, all.length)
})

test('空输入返回空计划', () => {
  assert.deepEqual(planCleanup({ claims: [], now: NOW }), { remove: [], keep: [] })
})

test('重复 id 以第一次出现为准：后面的重复行不占用“最近 N 条”保护', () => {
  const plan = planCleanup({
    claims: [
      { id: 'dup', falsifiedAt: NOW - 60 * DAY, createdAt: NOW - 10 * DAY },
      { id: 'new', createdAt: NOW - 1 * DAY },
      { id: 'dup', falsifiedAt: NOW - 60 * DAY, createdAt: NOW - 1 * DAY },
    ],
    now: NOW,
    falsifiedOlderThanMs: DAY,
    keepRecent: 1,
  })
  assert.deepEqual(plan.remove, ['dup'])
  assert.deepEqual(plan.keep, ['new'])
})

test('默认保留期 30 天、默认保护最近 20 条', () => {
  assert.equal(DEFAULT_FALSIFIED_RETENTION_MS, 30 * DAY)
  assert.equal(DEFAULT_CLEANUP_KEEP_RECENT, 20)

  const recent = planCleanup({
    claims: [{ id: 'a', falsifiedAt: NOW - 90 * DAY, createdAt: NOW - 90 * DAY }],
    now: NOW,
  })
  assert.deepEqual(recent, { remove: [], keep: ['a'] })

  const many = Array.from({ length: 21 }, (_, index) => ({
    id: `m${index}`,
    falsifiedAt: NOW - 90 * DAY,
    createdAt: NOW - (100 - index) * DAY,
  }))
  const plan = planCleanup({ claims: many, now: NOW })
  assert.deepEqual(plan.remove, ['m0'])
  assert.equal(plan.keep.length, 20)
})

test('输入形状非法抛 ClaimError', () => {
  assert.throws(() => planCleanup(null as never), ClaimError)
  assert.throws(() => planCleanup({ claims: 'nope' as never, now: NOW }), ClaimError)
  assert.throws(() => planCleanup({ claims: [{ id: '' }], now: NOW }), ClaimError)
  assert.throws(() => planCleanup({ claims: [], now: NOW, keepRecent: -1 }), ClaimError)
  assert.throws(() => planCleanup({ claims: [], now: NOW, falsifiedOlderThanMs: 1.5 }), ClaimError)
  assert.throws(() => planCleanup({ claims: [], now: -1 }), ClaimError)
  assert.throws(
    () => planCleanup({ claims: [{ id: 'a', falsifiedAt: 'yesterday' as never }], now: NOW }),
    ClaimError,
  )
})
