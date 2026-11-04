import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  memberById,
  responderBotId,
  responderKind,
  roomMembers,
  roomOriginLabel,
  roomOriginTitle,
  roundStateLabel,
  roundStatusItems,
  slotStatusLabel,
  speakingSlot,
  whoAnswersLabel,
} from '../lib/rooms.js'

const members = [
  { botId: 'chief', role: 'host', name: 'Chief' },
  { botId: 'selector', role: 'member', name: '选股师' },
  { botId: 'risk', role: 'member', name: '风控官' },
]

test('member 模式：指名成员会回答（ui.md §3.12）', () => {
  const room = { responder: { kind: 'member', botId: 'selector' }, members, hostBotId: 'chief' }
  assert.equal(whoAnswersLabel(room), '选股师 会回答')
  assert.equal(responderBotId(room), 'selector')
})

test('member 模式缺 botId 时按 fallback 取 host', () => {
  const room = { responder: { kind: 'member' }, members, hostBotId: 'chief' }
  assert.equal(responderBotId(room), 'chief')
  assert.equal(whoAnswersLabel(room), 'Chief 会回答')
})

test('everyone / mentions / auto 的文案', () => {
  assert.equal(whoAnswersLabel({ responder: { kind: 'everyone' }, members }), '所有人轮流回答')
  assert.equal(whoAnswersLabel({ responder: { kind: 'mentions' }, members }), '只回答被 @ 的人')
  assert.equal(whoAnswersLabel({ responder: { kind: 'auto' }, members }), '由系统决定谁回答')
})

test('没有成员时不假装有人回答', () => {
  assert.equal(whoAnswersLabel({ responder: { kind: 'everyone' }, members: [] }), '还没有成员会回答')
  assert.equal(whoAnswersLabel({ responder: { kind: 'member', botId: 'x' }, members: [] }), '还没有成员会回答')
  assert.equal(whoAnswersLabel({ members: [] }), '还没有成员会回答')
  assert.equal(whoAnswersLabel(null), '')
})

test('成员名缺失时用中性文案（不把内部 id 显示给用户）', () => {
  const room = { responder: { kind: 'member', botId: 'selector' }, members: [{ botId: 'selector', role: 'member' }] }
  assert.equal(whoAnswersLabel(room), '指定的成员 会回答')
})

test('M3 的 replyMode 也能映射（admin 视为指名 host）', () => {
  assert.equal(responderKind({ replyMode: 'admin' }), 'member')
  assert.equal(responderKind({ replyMode: 'everyone' }), 'everyone')
  assert.equal(responderKind({ replyMode: 'mentions' }), 'mentions')
  const room = { replyMode: 'admin', hostBotId: 'chief', members }
  assert.equal(whoAnswersLabel(room), 'Chief 会回答')
})

test('成员数组过滤残缺项', () => {
  const parsed = roomMembers({
    members: [null, {}, { botId: '' }, { botId: 'a', role: 'weird', name: '  甲  ' }, { botId: 'b' }],
  })
  assert.deepEqual(parsed, [
    { botId: 'a', role: 'member', name: '甲' },
    { botId: 'b', role: 'member', name: '' },
  ])
  assert.equal(memberById({ members }, 'risk').name, '风控官')
  assert.equal(memberById({ members }, 'nope'), null)
})

test('slot 状态文案：认识的状态给中文，未知的原样显示', () => {
  assert.equal(slotStatusLabel('speaking'), '正在说')
  assert.equal(slotStatusLabel('waiting'), '排队中')
  assert.equal(slotStatusLabel('passed'), '静默')
  assert.equal(slotStatusLabel('failed'), '失败')
  assert.equal(slotStatusLabel('waiting-approval'), '等审批')
  assert.equal(slotStatusLabel('custom-state'), 'custom-state')
  assert.equal(slotStatusLabel(undefined), '未知状态')
  assert.equal(roundStateLabel('running'), '本轮进行中')
  assert.equal(roundStateLabel('done'), '本轮已结束')
  assert.equal(roundStateLabel(''), '')
})

test('roundStatusItems 从 slot/nameOf 取名字，缺数据给空数组', () => {
  assert.deepEqual(roundStatusItems(null), [])
  assert.deepEqual(roundStatusItems({ slots: [] }), [])
  const round = {
    state: 'running',
    slots: [
      { botId: 'selector', status: 'speaking' },
      { botId: 'risk', status: 'failed', note: '会话丢失', name: '风控官' },
      { botId: 'chief', status: 'waiting' },
    ],
  }
  const items = roundStatusItems(round, (botId) => (botId === 'selector' ? '选股师' : botId === 'chief' ? 'Chief' : ''))
  assert.deepEqual(
    items.map((item) => [item.name, item.label, item.kind]),
    [
      ['选股师', '正在说', 'active'],
      ['风控官', '失败', 'danger'],
      ['Chief', '排队中', 'pending'],
    ]
  )
  assert.equal(items[1].note, '会话丢失')
})

test('speakingSlot 认 status=speaking 或 round.speaking', () => {
  assert.equal(speakingSlot({ slots: [{ botId: 'a', status: 'speaking' }] }).botId, 'a')
  assert.equal(speakingSlot({ speaking: 'b', slots: [{ botId: 'b', status: 'waiting' }] }).botId, 'b')
  assert.equal(speakingSlot({ slots: [{ botId: 'a', status: 'waiting' }] }), null)
  assert.equal(speakingSlot(null), null)
})

test('房间来源：只有 Bot 建的房间有徽章，title 带 createdBy', () => {
  const botRoom = { createdByKind: 'bot', createdBy: 'bot_selector' }
  assert.equal(roomOriginLabel(botRoom), '由 Bot 创建')
  assert.equal(roomOriginTitle(botRoom), '由 Bot 创建 · 创建者 bot_selector')

  assert.equal(roomOriginLabel({ createdByKind: 'user', createdBy: 'you' }), '')
  assert.equal(roomOriginTitle({ createdByKind: 'user', createdBy: 'you' }), '')
  assert.equal(roomOriginLabel({}), '')
  assert.equal(roomOriginLabel(null), '')
  assert.equal(roomOriginTitle(null), '')

  // 缺 createdBy 时也不编一个 id 出来。
  assert.equal(roomOriginLabel({ createdByKind: 'bot' }), '由 Bot 创建')
  assert.equal(roomOriginTitle({ createdByKind: 'bot' }), '由 Bot 创建')
  assert.equal(roomOriginTitle({ createdByKind: 'bot', createdBy: '   ' }), '由 Bot 创建')
})
