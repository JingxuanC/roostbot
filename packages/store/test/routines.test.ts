import assert from 'node:assert/strict'
import { test } from 'node:test'

import { executeRoutineRun } from '../../../apps/api/src/routine-worker.ts'
import { createBot } from '../src/bots.ts'
import { readRoomEvents } from '../src/room-log.ts'
import { readMessages } from '../src/rooms.ts'
import { createRoomExt } from '../src/rooms-ext.ts'
import {
  claimDueRoutines,
  createRoutine,
  finishRoutineRun,
  getRoutine,
} from '../src/routines.ts'
import { openStore } from '../src/store.ts'
import { createWorkspace } from '../src/workspaces.ts'

const AT = Date.parse('2026-11-06T00:00:00.000Z')

function setup() {
  const store = openStore(':memory:')
  const workspace = createWorkspace(store, { tenantId: 'tenant_1', name: '研究', profileVersion: 'dev', createdAt: AT })
  const bot = createBot(store, {
    workspaceId: workspace.id,
    name: '数据官',
    role: '数据',
    model: 'deepseek-chat',
    createdBy: 'acc_1',
  })
  const peer = createBot(store, {
    workspaceId: workspace.id,
    name: '风控',
    role: '风控',
    model: 'deepseek-chat',
    createdBy: 'acc_1',
  })
  const room = createRoomExt(store, {
    workspaceId: workspace.id,
    memberBotIds: [bot.id, peer.id],
    hostBotId: bot.id,
    createdBy: 'acc_1',
  })
  return { store, workspace, bot, room: room.room }
}

test('默认时区是 Asia/Shanghai，到点只发 routine.fired，runner 看不到聊天记录', async () => {
  const { store, workspace, bot, room } = setup()
  try {
    const routine = createRoutine(store, {
      workspaceId: workspace.id,
      botId: bot.id,
      name: '盘前',
      cron: 'every 3600',
      prompt: '只报告异动',
      roomId: room.id,
      at: AT,
    })
    assert.equal(routine.timezone, 'Asia/Shanghai')
    assert.equal(routine.nextRunAt, AT + 3600_000)

    const tooSoon = claimDueRoutines(store, AT + 1000)
    assert.equal(tooSoon.length, 0)

    const claimed = claimDueRoutines(store, AT + 3600_000)
    assert.equal(claimed.length, 1)
    const events = readRoomEvents(store, { roomId: room.id, afterSeq: 0 })
    assert.ok(events.some((event) => event.kind === 'schedule.routine.fired' && event.payload.runId === claimed[0]!.id))
    const before = readMessages(store, { roomId: room.id }).length

    const seen: string[] = []
    const posted = await executeRoutineRun(store, claimed[0]!, async (job) => {
      seen.push(job.prompt)
      assert.equal('messages' in job, false)
      assert.deepEqual(Object.keys(job).sort(), ['botId', 'prompt', 'roomId', 'routineId', 'runId', 'scheduledFor'])
      return { text: '无异动' }
    })
    assert.deepEqual(seen, ['只报告异动'])
    assert.equal(posted.status, 'posted')
    const messages = readMessages(store, { roomId: room.id })
    assert.equal(messages.length, before + 1)
    assert.equal(messages.at(-1)?.text, '无异动')
    assert.equal(messages.at(-1)?.actor?.id, bot.id)
    assert.equal(messages.at(-1)?.routine?.routineId, routine.id)
    assert.equal(messages.at(-1)?.routine?.runId, claimed[0]!.id)
    assert.equal(messages.at(-1)?.routine?.timezone, 'Asia/Shanghai')
    assert.equal(messages.at(-1)?.routine?.error, undefined)

    const again = claimDueRoutines(store, AT + 3600_000)
    assert.equal(again.length, 0)
    assert.equal(getRoutine(store, routine.id)?.nextRunAt, AT + 7200_000)
  } finally {
    store.close()
  }
})

test('runner 没有可报告的内容时房间不出现新消息', async () => {
  const { store, workspace, bot, room } = setup()
  try {
    const routine = createRoutine(store, {
      workspaceId: workspace.id,
      botId: bot.id,
      name: '静默',
      cron: 'every 60',
      prompt: '没事就别说',
      roomId: room.id,
      at: AT,
    })
    const claimed = claimDueRoutines(store, routine.nextRunAt)
    const before = readMessages(store, { roomId: room.id }).length
    const finished = await executeRoutineRun(store, claimed[0]!, async () => ({ text: '   ' }))
    assert.equal(finished.status, 'silent')
    assert.equal(readMessages(store, { roomId: room.id }).length, before)
    const replay = finishRoutineRun(store, finished.id, '不该再发')
    assert.equal(replay.status, 'silent')
    assert.equal(readMessages(store, { roomId: room.id }).length, before)
  } finally {
    store.close()
  }
})

test('模型连着失败只留下一条错误消息，再交卷不会重复', async () => {
  const { store, workspace, bot, room } = setup()
  try {
    const routine = createRoutine(store, {
      workspaceId: workspace.id,
      botId: bot.id,
      name: '会失败',
      cron: 'every 60',
      prompt: '算一下',
      roomId: room.id,
      at: AT,
    })
    const claimed = claimDueRoutines(store, routine.nextRunAt)
    let calls = 0
    const finished = await executeRoutineRun(store, claimed[0]!, async () => {
      calls += 1
      throw new Error('401 unauthorized')
    })
    assert.equal(calls, 3)
    assert.equal(finished.status, 'failed')
    const messages = readMessages(store, { roomId: room.id })
    const posted = messages.filter((message) => message.routine?.runId === claimed[0]!.id)
    assert.equal(posted.length, 1)
    assert.match(posted[0]!.text, /401 unauthorized/)
    assert.equal(posted[0]!.routine?.error, true)
    const replay = finishRoutineRun(store, finished.id, '再写一条', AT, { error: true })
    assert.equal(replay.status, 'failed')
    assert.equal(readMessages(store, { roomId: room.id }).filter((message) => message.routine?.runId === claimed[0]!.id).length, 1)
  } finally {
    store.close()
  }
})
