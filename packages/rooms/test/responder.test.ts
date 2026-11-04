// responder：fallback 链、开局 slots、@ 解析（含中文名前缀歧义）。

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { DATA, DATA2, HOST, MEMBERS, OPS, member } from './helpers.ts'
import { openingSpeakers, parseMentions, resolveResponder } from '../src/index.ts'

test('fallback：指定成员在房间里就用它', () => {
  assert.deepEqual(resolveResponder({ kind: 'member', botId: 'b_data' }, MEMBERS), [DATA])
})

test('fallback：指定成员不在了，落回第一个成员', () => {
  assert.deepEqual(resolveResponder({ kind: 'member', botId: 'b_ghost' }, MEMBERS), [HOST])
})

test('fallback：auto 的 fallbackBotId 存在就用它', () => {
  assert.deepEqual(resolveResponder({ kind: 'auto', fallbackBotId: 'b_ops' }, MEMBERS), [OPS])
})

test('fallback：auto 的兜底也不在了，落回第一个成员', () => {
  assert.deepEqual(resolveResponder({ kind: 'auto', fallbackBotId: 'b_ghost' }, MEMBERS), [HOST])
})

test('fallback：everyone 是全员且 host 第一', () => {
  const members = [DATA, HOST, OPS]
  assert.deepEqual(resolveResponder({ kind: 'everyone' }, members), [HOST, DATA, OPS])
})

test('fallback：mentions 的默认 lead 是第一个成员（host 通常排第一）', () => {
  assert.deepEqual(resolveResponder({ kind: 'mentions' }, MEMBERS), [HOST])
})

test('fallback：没有成员返回空列表', () => {
  assert.deepEqual(resolveResponder({ kind: 'everyone' }, []), [])
  assert.deepEqual(resolveResponder({ kind: 'member', botId: 'b_data' }, []), [])
})

test('fallback：没有配置 responder 时也落回第一个成员', () => {
  assert.deepEqual(resolveResponder(undefined, MEMBERS), [HOST])
})

test('开局 everyone：全员，host 第一（不是 @ 的人先）', () => {
  const members = [DATA, HOST, OPS]
  const speakers = openingSpeakers({ members, responder: { kind: 'everyone' } }, { text: '@运营 你说' })
  assert.deepEqual(speakers, [HOST, DATA, OPS])
})

test('开局 admin（旧 replyMode）：只有 host', () => {
  const members = [DATA, HOST, OPS]
  const speakers = openingSpeakers({ members, replyMode: 'admin', hostBotId: 'b_host' })
  assert.deepEqual(speakers, [HOST])
})

test('开局 mentions：没人 @ 时默认 host（host 不在首位也一样）', () => {
  const members = [DATA, HOST, OPS]
  assert.deepEqual(openingSpeakers({ members, replyMode: 'mentions' }), [HOST])
  assert.deepEqual(openingSpeakers({ members, replyMode: 'mentions' }, { text: '大家看下' }), [HOST])
})

test('开局 mentions：只叫被 @ 的人，保持 @ 顺序', () => {
  const speakers = openingSpeakers({ members: MEMBERS, replyMode: 'mentions' }, { text: '@运营 先看，然后 @数据官2 复核' })
  assert.deepEqual(speakers, [OPS, DATA2])
})

test('开局 mentions：@all 展开为全员；只有 host 的 @all 生效由 applyMentions 把关', () => {
  const speakers = openingSpeakers({ members: MEMBERS, replyMode: 'mentions' }, { text: '@all 一起看' })
  assert.deepEqual(speakers, [HOST, DATA, DATA2, OPS])
})

test('开局 member：指定谁就是谁；不在了落回第一个成员', () => {
  const room = { members: MEMBERS, responder: { kind: 'member' as const, botId: 'b_ops' } }
  assert.deepEqual(openingSpeakers(room), [OPS])
  assert.deepEqual(openingSpeakers({ members: MEMBERS, responder: { kind: 'member', botId: 'b_ghost' } }), [HOST])
})

test('开局 auto：走 fallback 链', () => {
  assert.deepEqual(
    openingSpeakers({ members: MEMBERS, responder: { kind: 'auto', fallbackBotId: 'b_data2' } }),
    [DATA2]
  )
  assert.deepEqual(
    openingSpeakers({ members: MEMBERS, responder: { kind: 'auto', fallbackBotId: 'b_ghost' } }),
    [HOST]
  )
})

test('开局：没有成员时没人开口', () => {
  assert.deepEqual(openingSpeakers({ members: [] }), [])
})

test('@ 解析：中文名精确匹配，长名字优先（@数据官2 不会变成 @数据官）', () => {
  assert.deepEqual(parseMentions('@数据官2 复核一下', MEMBERS).members, [DATA2])
  assert.deepEqual(parseMentions('@数据官 先说', MEMBERS).members, [DATA])
  assert.deepEqual(parseMentions('@数据官，先说', MEMBERS).members, [DATA])
})

test('@ 解析：中文前缀歧义——@数据官 不匹配 @数据官2；@数据官长 也不算 @数据官', () => {
  const onlyData = [member('b_data', '数据官')]
  assert.deepEqual(parseMentions('@数据官2 你好', onlyData).members, [])
  assert.deepEqual(parseMentions('@数据官长 你好', onlyData).members, [])
  // 名字后面是标点/空格/结尾都算边界
  assert.deepEqual(parseMentions('@数据官。', onlyData).members, [onlyData[0]])
})

test('@ 解析：@all 只在调用者是 host 时生效，非 host 仍能看到具名 @', () => {
  assert.deepEqual(parseMentions('@all 大家看', MEMBERS), { all: true, members: [] })
  assert.deepEqual(parseMentions('@ALL', MEMBERS).all, true)
  assert.deepEqual(parseMentions('@all 大家看', MEMBERS, { callerIsHost: false }), { all: false, members: [] })
  assert.deepEqual(parseMentions('@all @运营', MEMBERS, { callerIsHost: false }).members, [OPS])
})

test('@ 解析：重复 @ 只算一次，大小写不敏感，邮箱里的 @ 不算', () => {
  assert.deepEqual(parseMentions('@运营 @运营', MEMBERS).members, [OPS])
  const analyst = member('b_analyst', 'Analyst')
  assert.deepEqual(parseMentions('@analyst 看看', [analyst]).members, [analyst])
  assert.deepEqual(parseMentions('a@数据官', MEMBERS).members, [])
})
