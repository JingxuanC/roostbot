import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  approvalActions,
  approvalKindLabel,
  approvalStatusLabel,
  approvalSummary,
  approvalTimeLabel,
  canDecide,
} from '../lib/approvals.js'

const pendingRoom = {
  id: 'ap_1',
  kind: 'create_room',
  requester: 'bot_selector',
  status: 'pending',
  createdAt: new Date(2026, 0, 2, 3, 4).getTime(),
  payload: {
    name: '盘前研究组',
    purpose: '每日盘前过一遍异动',
    memberBotIds: ['bot_chief', 'bot_data', 'bot_chief'],
  },
}

test('create_room 摘要：名字 / 用途 / 成员数', () => {
  const summary = approvalSummary(pendingRoom)
  assert.equal(summary.kind, 'create_room')
  assert.equal(summary.kindLabel, '建群')
  assert.equal(summary.title, '建群 · 盘前研究组')
  assert.equal(summary.name, '盘前研究组')
  assert.equal(summary.purpose, '每日盘前过一遍异动')
  assert.deepEqual(summary.memberIds, ['bot_chief', 'bot_data'])
  assert.equal(summary.memberCount, 2)
  assert.deepEqual(
    summary.fields.map((field) => [field.label, field.value]),
    [
      ['房间名', '盘前研究组'],
      ['用途', '每日盘前过一遍异动'],
      ['成员', '2 个'],
    ]
  )
})

test('create_room 缺字段时给中性占位，不把 undefined 打出来', () => {
  const summary = approvalSummary({ id: 'ap_2', kind: 'create_room', status: 'pending', payload: {} })
  assert.equal(summary.title, '建群请求')
  assert.deepEqual(
    summary.fields.map((field) => field.value),
    ['（未命名，按成员名生成）', '（没写用途）', '（未指定）']
  )
  assert.deepEqual(summary.memberIds, [])
})

test('payload 缺失或类型不对也不抛异常', () => {
  for (const payload of [undefined, null, 'oops', 42, []]) {
    const summary = approvalSummary({ id: 'ap_3', kind: 'create_room', status: 'pending', payload })
    assert.equal(summary.kindLabel, '建群')
    assert.equal(summary.memberCount, 0)
    assert.equal(summary.fields.length, 3)
  }
  const empty = approvalSummary(null)
  assert.equal(empty.kind, '')
  assert.equal(empty.title, '请求')
  assert.equal(empty.fields.length, 1)
})

test('未知 kind 原样显示，并把可显示的 payload 字段摘出来', () => {
  const summary = approvalSummary({
    id: 'ap_4',
    kind: 'delete_room',
    status: 'pending',
    payload: { room: 'r_1', force: true, nested: { skip: true } },
  })
  assert.equal(summary.kindLabel, 'delete_room')
  assert.equal(summary.title, 'delete_room')
  assert.deepEqual(
    summary.fields.map((field) => [field.label, field.value]),
    [
      ['room', 'r_1'],
      ['force', 'true'],
    ]
  )
})

test('canDecide 只对 pending 且 id 可用的审批为真', () => {
  assert.equal(canDecide(pendingRoom), true)
  assert.equal(canDecide({ ...pendingRoom, status: 'approved' }), false)
  assert.equal(canDecide({ ...pendingRoom, status: 'rejected' }), false)
  assert.equal(canDecide({ ...pendingRoom, id: '' }), false)
  assert.equal(canDecide({ ...pendingRoom, id: undefined }), false)
  assert.equal(canDecide(null), false)
})

test('approvalActions：pending 是「批准 / 拒绝」，已处理为空', () => {
  assert.deepEqual(
    approvalActions(pendingRoom).map((action) => [action.decision, action.label, action.variant]),
    [
      ['approved', '批准', 'primary'],
      ['rejected', '拒绝', 'ghost'],
    ]
  )
  assert.deepEqual(approvalActions({ ...pendingRoom, status: 'approved' }), [])
  assert.deepEqual(approvalActions({ ...pendingRoom, id: '' }), [])
  assert.deepEqual(approvalActions(null), [])
})

test('状态与类型文案有兜底', () => {
  assert.equal(approvalStatusLabel('pending'), '待批准')
  assert.equal(approvalStatusLabel('approved'), '已批准')
  assert.equal(approvalStatusLabel('rejected'), '已拒绝')
  assert.equal(approvalStatusLabel(''), '状态未知')
  assert.equal(approvalStatusLabel('weird'), 'weird')
  assert.equal(approvalKindLabel('create_room'), '建群')
  assert.equal(approvalKindLabel(''), '请求')
  assert.equal(approvalKindLabel(undefined), '请求')
})

test('时间格式固定为本地 yyyy-mm-dd hh:mm，坏值不冒充当前时间', () => {
  const ms = new Date(2026, 0, 2, 3, 4).getTime()
  assert.equal(approvalTimeLabel(ms), '2026-01-02 03:04')
  assert.equal(approvalTimeLabel(new Date(ms)), '2026-01-02 03:04')
  assert.equal(approvalTimeLabel(undefined), '时间未知')
  assert.equal(approvalTimeLabel(0), '时间未知')
  assert.equal(approvalTimeLabel('not-a-date'), '时间未知')
})
