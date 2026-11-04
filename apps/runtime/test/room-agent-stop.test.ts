// room-agent：advance 408/超时兜底 missed，以及可选的 stop 轮询
// （GET /api/internal/rooms/:id/round 返回 stopping: slotIndex，docs/build/m4-addendum.md §D）。

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { sessionIdFor, startRoomAgent } from '../room-agent.mjs'
import { createFakeControlPlane } from './fake-control-plane.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

async function waitFor(predicate: () => boolean, timeoutMs = 6000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.ok(predicate(), 'condition not reached before timeout')
}

function tempLog() {
  const dir = mkdtempSync(join(tmpdir(), 'roost-room-agent-stop-'))
  return { dir, path: join(dir, 'fake-dsh.jsonl') }
}

function promptCount(path: string): number {
  try {
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as { kind: string })
      .filter((entry) => entry.kind === 'prompt').length
  } catch {
    return 0
  }
}

function oneSlot(roomId: string, roundId: string) {
  return {
    [roomId]: [
      {
        roundId,
        roomId,
        botId: 'alpha',
        sessionId: sessionIdFor(roomId, 'alpha'),
        prompt: '请回答',
        index: 0,
        total: 1
      }
    ]
  }
}

test('advance 408：补报 missed 收尾，不重跑同一 slot', async () => {
  const log = tempLog()
  const cp = await createFakeControlPlane({
    rooms: [{ id: 'rm_408', members: [{ botId: 'alpha', role: 'host' }] }],
    messages: [{ seq: 1, actor: { kind: 'user', id: 'acc_1' }, text: '在吗' }],
    assignments: oneSlot('rm_408', 'rd_408'),
    advanceStatus: 408,
    advanceFailCount: 1
  })
  const agent = await startRoomAgent({
    apiBase: cp.base,
    runtimeToken: 'rt',
    botId: 'selector',
    dshBin: join(HERE, 'fake-dsh.mjs'),
    dshEnv: { FAKE_DSH_LOG: log.path },
    pollMs: 10,
    log: () => {}
  })
  try {
    await waitFor(() => cp.advances.length === 1)
    assert.deepEqual(cp.advances[0].result, { kind: 'missed' })
    assert.equal(cp.advances[0].slotIndex, 0)
    // 第一次 408 + 一次 missed 补报；没有第三次
    assert.equal(cp.state.advanceAttempts.length, 2)
    assert.equal(cp.state.advanceAttempts[0].status, 408)
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.equal(cp.state.advanceAttempts.length, 2)
    // slot 只执行一次（同一成员不会说两遍）
    assert.equal(promptCount(log.path), 1)
  } finally {
    await agent.stop()
    await cp.close()
    rmSync(log.dir, { recursive: true, force: true })
  }
})

test('advance 请求超时：按 missed 收尾，不重跑同一 slot', async () => {
  const cp = await createFakeControlPlane({
    rooms: [{ id: 'rm_to', members: [{ botId: 'alpha', role: 'host' }] }],
    messages: [{ seq: 1, actor: { kind: 'user', id: 'acc_1' }, text: '在吗' }],
    assignments: oneSlot('rm_to', 'rd_to'),
    advanceDelayMs: 250,
    advanceDelayCount: 1
  })
  const agent = await startRoomAgent({
    apiBase: cp.base,
    runtimeToken: 'rt',
    botId: 'selector',
    dshBin: join(HERE, 'fake-dsh.mjs'),
    pollMs: 10,
    advanceTimeoutMs: 50,
    log: () => {}
  })
  try {
    await waitFor(() => cp.advances.length === 1)
    assert.deepEqual(cp.advances[0].result, { kind: 'missed' })
    assert.equal(cp.advances[0].slotIndex, 0)
    assert.equal(cp.state.advanceAttempts.length, 2)
    // 被 abort 的第一次不算成功
    assert.equal(cp.advances.length, 1)
  } finally {
    await agent.stop()
    await cp.close()
  }
})

test('stop 轮询：stopping 命中当前 slot → missed 结束，下一 slot 继续', async () => {
  const log = tempLog()
  const cp = await createFakeControlPlane({
    rooms: [
      {
        id: 'rm_stop',
        members: [
          { botId: 'alpha', role: 'host' },
          { botId: 'beta', role: 'member' }
        ]
      }
    ],
    messages: [{ seq: 1, actor: { kind: 'user', id: 'acc_1' }, text: '开始' }],
    assignments: {
      rm_stop: [
        {
          roundId: 'rd_stop',
          roomId: 'rm_stop',
          botId: 'alpha',
          sessionId: sessionIdFor('rm_stop', 'alpha'),
          prompt: 'alpha 先说',
          index: 0,
          total: 2
        },
        {
          roundId: 'rd_stop',
          roomId: 'rm_stop',
          botId: 'beta',
          sessionId: sessionIdFor('rm_stop', 'beta'),
          prompt: 'beta 接着说',
          index: 1,
          total: 2
        }
      ]
    },
    round: {
      id: 'rd_stop',
      roomId: 'rm_stop',
      startSeq: 1,
      state: 'running',
      slots: [
        { botId: 'alpha', status: 'speaking' },
        { botId: 'beta', status: 'waiting' }
      ],
      turns: 0,
      startedAt: 1
    },
    // 用户点了 alpha 的停止；advance 命中 slot 0 后清空（模拟控制面行为）
    stopping: { rm_stop: 0 }
  })
  const agent = await startRoomAgent({
    apiBase: cp.base,
    runtimeToken: 'rt',
    botId: 'selector',
    dshBin: join(HERE, 'fake-dsh.mjs'),
    dshEnv: { FAKE_DSH_LOG: log.path, FAKE_DSH_DELAY_MS: '250' },
    pollMs: 10,
    stopPollMs: 10,
    turnTimeoutMs: 5000,
    log: () => {}
  })
  try {
    await waitFor(() => cp.advances.length === 2)
    assert.deepEqual(
      cp.advances.map((advance) => [advance.slotIndex, advance.result.kind]),
      [
        [0, 'missed'],
        [1, 'posted']
      ]
    )
    // 下一个成员照常发言，没有被 stop 波及
    assert.match(cp.advances[1].result.text, /beta 接着说/)
    assert.ok(cp.state.roundRequests >= 1)
    assert.ok(promptCount(log.path) >= 2)
  } finally {
    await agent.stop()
    await cp.close()
    rmSync(log.dir, { recursive: true, force: true })
  }
})

test('stop 轮询：round 没有 stopping 字段时行为不变（不提前结束 slot）', async () => {
  const cp = await createFakeControlPlane({
    rooms: [
      {
        id: 'rm_nostop',
        members: [
          { botId: 'alpha', role: 'host' },
          { botId: 'beta', role: 'member' }
        ]
      }
    ],
    messages: [{ seq: 1, actor: { kind: 'user', id: 'acc_1' }, text: '继续' }],
    assignments: {
      rm_nostop: [
        {
          roundId: 'rd_nostop',
          roomId: 'rm_nostop',
          botId: 'alpha',
          sessionId: sessionIdFor('rm_nostop', 'alpha'),
          prompt: 'alpha 先说',
          index: 0,
          total: 2
        },
        {
          roundId: 'rd_nostop',
          roomId: 'rm_nostop',
          botId: 'beta',
          sessionId: sessionIdFor('rm_nostop', 'beta'),
          prompt: 'beta 接着说',
          index: 1,
          total: 2
        }
      ]
    },
    round: {
      id: 'rd_nostop',
      roomId: 'rm_nostop',
      startSeq: 1,
      state: 'running',
      slots: [
        { botId: 'alpha', status: 'waiting' },
        { botId: 'beta', status: 'waiting' }
      ],
      turns: 0,
      startedAt: 1
    }
  })
  const agent = await startRoomAgent({
    apiBase: cp.base,
    runtimeToken: 'rt',
    botId: 'selector',
    dshBin: join(HERE, 'fake-dsh.mjs'),
    dshEnv: { FAKE_DSH_DELAY_MS: '40' },
    pollMs: 10,
    stopPollMs: 10,
    log: () => {}
  })
  try {
    await waitFor(() => cp.advances.length === 2)
    assert.deepEqual(
      cp.advances.map((advance) => advance.result.kind),
      ['posted', 'posted']
    )
    // 轮询确实发生了，只是没有 stopping
    assert.ok(cp.state.roundRequests >= 2)
  } finally {
    await agent.stop()
    await cp.close()
  }
})
