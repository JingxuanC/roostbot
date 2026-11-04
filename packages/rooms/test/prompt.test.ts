// prompt：按 rooms.md §5 的 9 段装配，含条数上限、位置说明与 [PASS] 指令。

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { BASE, DATA, HOST, MEMBERS, OPS, makeRoom } from './helpers.ts'
import { buildKickoffPrompt, buildMemberPrompt, createRound, formatLine } from '../src/index.ts'

const room = makeRoom({ notice: '这个群只讨论 A 股，结论要给出处。' })

const round = createRound({
  roomId: room.id,
  startSeq: 11,
  at: BASE,
  slots: [HOST, DATA, OPS].map(({ botId, name }) => ({ botId, name }))
})

const delta = [
  { who: '用户', text: '看一下这周的行情' },
  { who: '主持', botId: 'b_host', text: '我来分一下工。' }
]

const earlier = Array.from({ length: 10 }, (_, index) => ({ who: '用户', text: `第${index + 1}条更早消息` }))

test('成员 prompt 包含 §5 的 9 段，且顺序正确', () => {
  const prompt = buildMemberPrompt({
    room,
    member: DATA,
    round,
    delta,
    earlier,
    working: [{ name: '运营', minutes: 3 }],
    references: [{ label: '研究记录', text: '营收增长 20%' }]
  })
  const markers = [
    '群成员：',
    '群公告（所有成员共同遵守）：',
    '更早的群聊',
    '本轮到目前为止',
    '用户在本轮引用的内容',
    '还在做事、完成后会自己发到群里',
    '本轮发言顺序',
    '行为要求：'
  ]
  let last = -1
  for (const marker of markers) {
    const at = prompt.indexOf(marker)
    assert.notEqual(at, -1, `缺少段落：${marker}`)
    assert.ok(at > last, `段落顺序不对：${marker}`)
    last = at
  }
})

test('成员清单写明 host 与自己；公告、增量、引用、工作状态都在', () => {
  const prompt = buildMemberPrompt({
    room,
    member: DATA,
    round,
    delta,
    working: [{ name: '运营', minutes: 3 }],
    references: [{ label: '研究记录', text: '营收增长 20%' }]
  })
  assert.match(prompt, /群成员：用户、主持（host）、数据官2、运营，还有你（数据官）/)
  assert.ok(prompt.includes('这个群只讨论 A 股，结论要给出处。'))
  assert.ok(prompt.includes('用户：看一下这周的行情'))
  assert.ok(prompt.includes('主持：我来分一下工。'))
  assert.ok(prompt.includes('【研究记录】营收增长 20%'))
  assert.ok(prompt.includes('运营（约 3 分钟）'))
})

test('只有 host 的 prompt 有 host 附加说明', () => {
  const hostPrompt = buildMemberPrompt({ room, member: HOST, round, delta })
  const memberPrompt = buildMemberPrompt({ room, member: DATA, round, delta })
  assert.ok(hostPrompt.includes('你是这个群的 host（主持人）'))
  assert.ok(hostPrompt.includes('只有你的“@all”能叫全员'))
  assert.ok(!memberPrompt.includes('你是这个群的 host（主持人）'))
})

test('发言顺序与“我是第几个”：数据官是第 2 个，标出“你，现在”', () => {
  const prompt = buildMemberPrompt({ room, member: DATA, round, delta })
  assert.ok(prompt.includes('本轮发言顺序：主持（等待） → 数据官（你，现在） → 运营（等待）'))
  assert.ok(prompt.includes('你是第 2 个，共 3 个；前面 1 人已经说过，后面 1 人会在你之后看到你的消息。'))
})

test('不在本轮队列里的成员也有明确说明', () => {
  const prompt = buildMemberPrompt({ room, member: HOST, round: createRound({ roomId: 'room_1', startSeq: 1, at: BASE, slots: [DATA] }), delta: [] })
  assert.ok(prompt.includes('你不在本轮的发言队列里'))
})

test('没有新消息时本轮增量段仍然说明“还没有”', () => {
  const prompt = buildMemberPrompt({ room, member: DATA, round, delta: [] })
  assert.ok(prompt.includes('本轮到目前为止还没有新消息。'))
})

test('上下文条数受 ROUND_LIMITS 限制：更早 8 条、增量 24 条', () => {
  const manyDelta = Array.from({ length: 30 }, (_, index) => ({ who: '用户', text: `D${String(index + 1).padStart(2, '0')}` }))
  const manyEarlier = Array.from({ length: 10 }, (_, index) => ({ who: '用户', text: `E${String(index + 1).padStart(2, '0')}` }))
  const prompt = buildMemberPrompt({ room, member: DATA, round, delta: manyDelta, earlier: manyEarlier })
  assert.ok(prompt.includes('D30'))
  assert.ok(prompt.includes('D07'))
  assert.ok(!prompt.includes('D06'))
  assert.ok(prompt.includes('E03'))
  assert.ok(!prompt.includes('E01'))
})

test('公告按 ROOM_LIMITS.noticeMax 截断', () => {
  const long = makeRoom({ notice: 'x'.repeat(3000) })
  const prompt = buildMemberPrompt({ room: long, member: DATA, round, delta: [] })
  assert.ok(prompt.includes('…（截断）'))
  assert.ok(!prompt.includes('x'.repeat(2500)))
})

test('行为指令含 [PASS] 与 @ 的说明', () => {
  const prompt = buildMemberPrompt({ room, member: DATA, round, delta })
  assert.ok(prompt.includes('整条回复只写 [PASS]'))
  assert.ok(prompt.includes('写“@名字”会叫那个成员接着发言'))
})

test('状态行显式说出失败/工作中，不假装成员没说话', () => {
  assert.equal(formatLine({ who: '数据官', kind: 'failed', text: 'boom' }), '[数据官 回答失败：boom]')
  assert.equal(formatLine({ who: '运营', kind: 'working' }), '[运营 还在做事，完成后会发到群里]')
  assert.equal(formatLine({ who: '用户', text: '继续' }), '用户：继续')
})

test('kickoff：host 打招呼并问“这个群要做什么”，不先 @、不 [PASS]', () => {
  const prompt = buildKickoffPrompt({ room, member: HOST })
  assert.ok(prompt.includes('这个群刚建好'))
  assert.ok(prompt.includes('这个群要一起做什么'))
  assert.ok(prompt.includes('不要回复 [PASS]'))
  assert.ok(prompt.includes('这个群只讨论 A 股，结论要给出处。'))
  assert.ok(prompt.includes('主持'))
  assert.ok(prompt.includes('host'))
})

test('kickoff：非 host 成员等 host 先开口', () => {
  const prompt = buildKickoffPrompt({ room: makeRoom(), member: OPS })
  assert.ok(prompt.includes('请等 host 先开口'))
  assert.ok(!prompt.includes('请用一条短消息向用户打招呼'))
})

test('成员清单来自房间成员，不会把用户漏掉', () => {
  const prompt = buildMemberPrompt({ room: makeRoom({ members: [HOST, MEMBERS[1]] }), member: HOST, round, delta: [] })
  assert.ok(prompt.includes('群成员：用户、数据官，还有你（主持，host）'))
})
