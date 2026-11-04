import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  approvalActions,
  approvalDecisionHistory,
  approvalFacts,
  approvalGrantPayload,
  approvalGrantsView,
  approvalKindLabel,
  approvalListModel,
  approvalRequester,
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

test('action / target / consequence 作为主展示，标题用 action', () => {
  const facts = approvalFacts({
    ...pendingRoom,
    action: '发送邮件',
    target: 'research@example.com',
    consequence: '邮件发出后无法撤回',
  })
  assert.equal(facts.title, '发送邮件')
  assert.equal(facts.usedPrimaryFields, true)
  assert.deepEqual(
    facts.facts.map((field) => [field.label, field.value]),
    [
      ['要做什么', '发送邮件'],
      ['作用对象', 'research@example.com'],
      ['影响什么', '邮件发出后无法撤回'],
    ]
  )
})

test('三要素缺失时回退到 payload 摘要，不显示 undefined', () => {
  const facts = approvalFacts(pendingRoom)
  assert.equal(facts.title, '建群 · 盘前研究组')
  assert.equal(facts.usedPrimaryFields, false)
  assert.deepEqual(
    facts.facts.map((field) => [field.label, field.value]),
    [
      ['房间名', '盘前研究组'],
      ['用途', '每日盘前过一遍异动'],
      ['成员', '2 个'],
    ]
  )
  for (const field of facts.facts) {
    assert.equal(String(field.value).includes('undefined'), false)
  }
})

test('三要素部分缺失时只展示已有字段，不编造值', () => {
  const facts = approvalFacts({ ...pendingRoom, target: 'r_quant' })
  assert.equal(facts.title, '建群 · 盘前研究组')
  assert.deepEqual(
    facts.facts.map((field) => [field.label, field.value]),
    [['作用对象', 'r_quant']]
  )
})

test('请求方：bot 解析名字、user 加前缀、未知 kind 中性显示', () => {
  const bots = [{ id: 'bot_selector', name: '选股师' }]
  const bot = approvalRequester({ ...pendingRoom, requester: 'bot_selector', requesterKind: 'bot' }, bots)
  assert.equal(bot.name, '选股师')
  assert.deepEqual(bot.bot, bots[0])

  const unknownBot = approvalRequester({ ...pendingRoom, requester: 'bot_missing', requesterKind: 'bot' }, bots)
  assert.equal(unknownBot.name, '一个 Bot')
  assert.equal(unknownBot.bot, null)

  assert.equal(
    approvalRequester({ ...pendingRoom, requester: 'acct_1', requesterKind: 'user' }, bots).name,
    '用户 · acct_1'
  )
  assert.equal(
    approvalRequester({ ...pendingRoom, requester: 'x_1', requesterKind: 'weird' }, bots).name,
    '请求方 · x_1'
  )
  assert.equal(approvalRequester({}, bots).name, '未知请求方')
})

test('已决策历史行：状态 + 决策人 + 时间；pending 不生成历史', () => {
  const decidedAt = new Date(2026, 0, 2, 3, 4).getTime()
  const approved = approvalDecisionHistory({
    status: 'approved',
    decidedBy: 'acct_1',
    decidedAt,
  })
  assert.equal(approved?.text, '已允许（一次） · 决策人 acct_1 · 2026-01-02 03:04')
  assert.equal(approvalDecisionHistory({ status: 'rejected', decidedBy: 'acct_2' })?.label, '已拒绝（一次）')
  assert.equal(
    approvalDecisionHistory({ status: 'approved', decidedAt }).text,
    '已允许（一次） · 决策人未知 · 2026-01-02 03:04'
  )
  assert.equal(approvalDecisionHistory({ status: 'pending' }), null)
  assert.equal(approvalDecisionHistory(null), null)
})

test('列表模型：pending 在前（新请求优先），已决策按时间倒序并截断', () => {
  const rows = [
    { id: 'p_old', status: 'pending', createdAt: 100 },
    { id: 'p_new', status: 'pending', createdAt: 200 },
    { id: 'd_a', status: 'approved', decidedAt: 1000 },
    { id: 'd_b', status: 'rejected', decidedAt: 3000 },
    { id: 'd_c', status: 'approved', decidedAt: 2000 },
    { id: 'bad', status: 'pending', createdAt: 'not-a-date' },
  ]
  const model = approvalListModel(rows, { limit: 2 })
  assert.deepEqual(model.pending.map((row) => row.id), ['p_new', 'p_old', 'bad'])
  assert.deepEqual(model.decided.map((row) => row.id), ['d_b', 'd_c'])

  const filtered = approvalListModel([null, 'oops', 42, { id: 'p', status: 'pending' }])
  assert.equal(filtered.pending.length, 1)
  assert.deepEqual(filtered.decided, [])
})

test('长期授权展示：kind / action / target / 授权人 / 时间，空值用占位', () => {
  const grantedAt = new Date(2026, 0, 2, 3, 4).getTime()
  const view = approvalGrantsView([
    {
      id: 'apg_1',
      kind: 'create_room',
      action: 'create',
      target: '研究组',
      grantedBy: 'acct_1',
      grantedAt,
    },
    { id: 'apg_2', kind: 'other', action: null, target: '', grantedBy: null },
  ])
  assert.equal(view.count, 2)
  assert.deepEqual(
    view.rows.map((row) => [row.kindLabel, row.actionLabel, row.targetLabel, row.grantedBy, row.grantedAtLabel]),
    [
      ['建群', 'create', '研究组', 'acct_1', '2026-01-02 03:04'],
      ['other', '（未指定）', '（未指定）', '未知', '时间未知'],
    ]
  )
  assert.equal(approvalGrantsView([null, 'oops']).count, 0)
})

test('长期授权请求体：去空白、空 action/target 不发、缺 kind 返回 null', () => {
  assert.deepEqual(
    approvalGrantPayload({ workspaceId: ' ws_1 ', kind: ' create_room ', action: ' ', target: ' 研究组 ' }),
    { workspaceId: 'ws_1', kind: 'create_room', target: '研究组' }
  )
  assert.equal(approvalGrantPayload({ workspaceId: 'ws_1', kind: ' ' }), null)
  assert.equal(approvalGrantPayload({ workspaceId: '', kind: 'create_room' }), null)
})
