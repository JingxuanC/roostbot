// 轮次：回复分类、开轮、@ 插入与上限、slot 状态推进、收轮条件。

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { BASE, DATA, HOST, MEMBERS, OPS, member } from './helpers.ts'
import {
  advanceSlot,
  applyMentions,
  classifyReply,
  createRound,
  finishRound,
  nextSlot,
  spokenTurns,
  startSlot,
  turnLimit
} from '../src/index.ts'

const round3 = () => createRound({
  roomId: 'room_1',
  startSeq: 11,
  at: BASE,
  id: 'rnd_1',
  slots: [HOST, DATA, OPS].map(({ botId, name }) => ({ botId, name }))
})

test('[PASS] 分类：去空白后正好是 [PASS]（大小写/中英文括号都认）', () => {
  assert.deepEqual(classifyReply(' [PASS] '), { kind: 'passed' })
  assert.deepEqual(classifyReply('[pass]'), { kind: 'passed' })
  assert.deepEqual(classifyReply('【PASS】'), { kind: 'passed' })
})

test('[PASS] 分类：不是整条 [PASS] 就照常发言，原文不改', () => {
  assert.deepEqual(classifyReply('好的，我来'), { kind: 'posted', text: '好的，我来' })
  assert.deepEqual(classifyReply('[PASS] 另外补充一句'), { kind: 'posted', text: '[PASS] 另外补充一句' })
  assert.deepEqual(classifyReply('pass'), { kind: 'posted', text: 'pass' })
  assert.deepEqual(classifyReply(''), { kind: 'posted', text: '' })
})

test('开轮：running、turns=0、slots 全是 waiting，时间/id 可控', () => {
  const round = round3()
  assert.equal(round.id, 'rnd_1')
  assert.equal(round.state, 'running')
  assert.equal(round.turns, 0)
  assert.equal(round.startedAt, BASE)
  assert.deepEqual(round.slots.map(slot => slot.status), ['waiting', 'waiting', 'waiting'])
  assert.equal(round.endedAt, undefined)
})

test('开轮：拷贝输入 slots，之后改夹具不影响轮次', () => {
  const slots = [{ botId: 'b_host', name: '主持' }]
  const round = createRound({ roomId: 'room_1', startSeq: 1, slots })
  slots[0].name = '改过的名字'
  assert.equal(round.slots[0].name, '主持')
})

test('@ 插入：还没说话的人被提前到当前 slot 后面', () => {
  const round = advanceSlot(round3(), 0, { kind: 'posted', text: '主持的话' })
  const next = applyMentions(round, HOST, '@运营 你先说', { callerIsHost: true, members: MEMBERS })
  assert.deepEqual(next.slots.map(slot => slot.botId), ['b_host', 'b_ops', 'b_data'])
  assert.equal(next.slots[1].status, 'waiting')
  assert.equal(next.slots[1].by, 'b_host')
})

test('@ 插入：说过的人给一次额外 turn（插在当前 slot 后面）', () => {
  const round = createRound({
    roomId: 'room_1',
    startSeq: 11,
    at: BASE,
    slots: [
      { botId: 'b_host', name: '主持', status: 'posted' },
      { botId: 'b_data', name: '数据官', status: 'posted' },
      { botId: 'b_ops', name: '运营', status: 'speaking' }
    ]
  })
  const next = applyMentions(round, OPS, '@数据官 你补充一下', { members: MEMBERS })
  assert.deepEqual(next.slots.map(slot => slot.botId), ['b_host', 'b_data', 'b_ops', 'b_data'])
  assert.equal(next.slots[3].status, 'waiting')
  assert.equal(next.slots[3].by, 'b_ops')
})

test('@ 插入：不改入参（不可变）', () => {
  const round = advanceSlot(round3(), 0, { kind: 'posted', text: '主持的话' })
  const before = JSON.parse(JSON.stringify(round))
  applyMentions(round, HOST, '@运营 你先说', { callerIsHost: true, members: MEMBERS })
  assert.deepEqual(round, before)
})

test('@ 上限：每成员 2 次，说满后再说也不插', () => {
  const round = createRound({
    roomId: 'room_1',
    startSeq: 11,
    at: BASE,
    slots: [
      { botId: 'b_data', name: '数据官', status: 'posted' },
      { botId: 'b_data', name: '数据官', status: 'posted' },
      { botId: 'b_host', name: '主持', status: 'speaking' }
    ]
  })
  const next = applyMentions(round, HOST, '@数据官 再说一句', { callerIsHost: true, members: MEMBERS })
  assert.equal(next.slots.length, 3)
  assert.equal(spokenTurns(next, 'b_data'), 2)
})

test('@ 上限：host 4 次，成员叫不动已经说满 4 次的 host', () => {
  const round = createRound({
    roomId: 'room_1',
    startSeq: 11,
    at: BASE,
    slots: [
      { botId: 'b_host', name: '主持', status: 'posted' },
      { botId: 'b_host', name: '主持', status: 'posted' },
      { botId: 'b_host', name: '主持', status: 'posted' },
      { botId: 'b_host', name: '主持', status: 'posted' },
      { botId: 'b_ops', name: '运营', status: 'speaking' }
    ]
  })
  const next = applyMentions(round, OPS, '@主持 你再说一句', { members: MEMBERS })
  assert.equal(next.slots.length, 5)
})

test('@ 上限：每轮额外 turn 预算 4，多出来的 @ 忽略', () => {
  const roster = [HOST, member('b_a1', '甲'), member('b_a2', '乙'), member('b_a3', '丙'), member('b_a4', '丁'), member('b_a5', '戊')]
  const round = createRound({
    roomId: 'room_1',
    startSeq: 11,
    at: BASE,
    slots: [{ botId: 'b_host', name: '主持', status: 'posted' }]
  })
  const next = applyMentions(round, HOST, '@甲 @乙 @丙 @丁 @戊 都来说', { members: roster })
  assert.equal(next.slots.length, 5) // 1 + 4，第 5 个被预算挡掉
  assert.deepEqual(next.slots.map(slot => slot.name), ['主持', '甲', '乙', '丙', '丁'])
})

test('@all：非 host 忽略（防 @ 风暴），host 展开为其他全部成员', () => {
  const quiet = createRound({
    roomId: 'room_1',
    startSeq: 11,
    at: BASE,
    slots: [
      { botId: 'b_host', name: '主持', status: 'posted' },
      { botId: 'b_data', name: '数据官', status: 'posted' },
      { botId: 'b_ops', name: '运营', status: 'speaking' }
    ]
  })
  const ignored = applyMentions(quiet, OPS, '@all 都来说', { members: MEMBERS })
  assert.equal(ignored.slots.length, 3)

  const running = createRound({
    roomId: 'room_1',
    startSeq: 11,
    at: BASE,
    slots: [
      { botId: 'b_host', name: '主持', status: 'speaking' },
      { botId: 'b_data', name: '数据官', status: 'posted' },
      { botId: 'b_ops', name: '运营', status: 'waiting' }
    ]
  })
  const called = applyMentions(running, HOST, '@all 都来说', { callerIsHost: true, members: MEMBERS })
  assert.equal(called.slots.length, 5) // host 在说 + 数据官额外 turn + 运营被提前 + 数据官2 + 原数据官
  // 数据官额外 turn 紧跟 host，运营被从队尾提前，数据官2 新插进来，原来的数据官退到最后
  assert.deepEqual(called.slots.map(slot => slot.botId), ['b_host', 'b_data', 'b_ops', 'b_data2', 'b_data'])
  assert.ok(called.slots.every(slot => slot.status === 'waiting' || slot.status === 'speaking' || slot.status === 'posted'))
})

test('advanceSlot：结果映射到状态，不可变，未动的 slot 复用对象', () => {
  const cases = [
    [{ kind: 'posted', text: 'x' }, 'posted'],
    [{ kind: 'passed' }, 'passed'],
    [{ kind: 'failed', code: 'SESSION', message: 'boom' }, 'failed'],
    [{ kind: 'missed' }, 'missed'],
    [{ kind: 'working' }, 'working'],
    [{ kind: 'approval' }, 'waiting-approval']
  ] as const
  for (const [result, status] of cases) {
    const round = round3()
    const before = JSON.parse(JSON.stringify(round))
    const next = advanceSlot(round, 1, result)
    assert.equal(next.slots[1].status, status)
    assert.equal(round.slots[1].status, 'waiting')
    assert.deepEqual(round, before)
    assert.notEqual(next, round)
    assert.notEqual(next.slots, round.slots)
    assert.equal(next.slots[0], round.slots[0])
  }
})

test('advanceSlot：下标越界原样返回；重复上报不重复计数', () => {
  const round = round3()
  assert.equal(advanceSlot(round, 9, { kind: 'posted', text: 'x' }), round)
  assert.equal(advanceSlot(round, -1, { kind: 'posted', text: 'x' }), round)
  const once = advanceSlot(round, 1, { kind: 'posted', text: 'x' })
  assert.equal(once.turns, 1)
  const twice = advanceSlot(once, 1, { kind: 'posted', text: 'x' })
  assert.equal(twice.turns, 1)
})

test('startSlot：waiting → speaking 并记下 speaking，不占 turns', () => {
  const round = startSlot(round3(), 1)
  assert.equal(round.slots[1].status, 'speaking')
  assert.equal(round.speaking, 'b_data')
  assert.equal(round.turns, 0)
  assert.equal(startSlot(round, 1), round) // 已经在说，幂等
  const posted = advanceSlot(round, 1, { kind: 'posted', text: 'x' })
  assert.equal(posted.speaking, undefined)
  assert.equal(posted.turns, 1)
})

test('nextSlot：第一个 waiting；没有了或轮次结束后是 null', () => {
  assert.equal(nextSlot(round3()), 0)
  assert.equal(nextSlot(advanceSlot(round3(), 0, { kind: 'passed' })), 1)
  assert.equal(nextSlot(startSlot(round3(), 0)), 1)
  const allDone = createRound({
    roomId: 'room_1',
    startSeq: 11,
    at: BASE,
    slots: [{ botId: 'b_host', name: '主持', status: 'posted' }]
  })
  assert.equal(nextSlot(allDone), null)
  assert.equal(nextSlot({ ...allDone, state: 'done' }), null)
})

test('收轮：还有 waiting 时不收，全部结束才 done 并写 endedAt', () => {
  const running = round3()
  assert.equal(finishRound(running), running)
  const done = finishRound({ ...running, slots: running.slots.map(slot => ({ ...slot, status: 'posted' as const })) }, { at: BASE + 1 })
  assert.equal(done.state, 'done')
  assert.equal(done.endedAt, BASE + 1)
  assert.equal(finishRound(done), done) // 幂等
})

test('收轮：显式 stopped 即使还有人没说话也收', () => {
  const stopped = finishRound(round3(), { stopped: true, at: BASE + 2 })
  assert.equal(stopped.state, 'stopped')
  assert.equal(stopped.endedAt, BASE + 2)
  assert.equal(stopped.slots[0].status, 'waiting')
})

test('收轮：turns 到 turnLimit 时即使还有 waiting 也 done', () => {
  const round = createRound({ roomId: 'room_1', startSeq: 11, at: BASE, slots: [HOST] })
  assert.equal(turnLimit(round), 2 + 4 + 4)
  const capped = { ...round, turns: turnLimit(round) }
  assert.equal(finishRound(capped).state, 'done')
})

test('turnLimit 按出现过的人数算，不随插入的额外 slot 一起抬高', () => {
  const round = createRound({
    roomId: 'room_1',
    startSeq: 11,
    at: BASE,
    slots: [HOST, DATA, DATA, DATA, OPS]
  })
  const distinct = createRound({ roomId: 'room_1', startSeq: 11, at: BASE, slots: [HOST, DATA, OPS] })
  assert.equal(turnLimit(round), turnLimit(distinct))
})
