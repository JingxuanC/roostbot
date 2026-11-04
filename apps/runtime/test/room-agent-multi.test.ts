// room-agent 的多成员派发、单 Bot 回退、会话常驻与退避。

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  classifySlotResult,
  nextBackoff,
  replyIdem,
  roomMembers,
  sessionIdFor,
  startRoomAgent
} from '../room-agent.mjs'
import { createFakeControlPlane } from './fake-control-plane.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

function tempLog() {
  const dir = mkdtempSync(join(tmpdir(), 'roost-room-agent-'))
  return { dir, path: join(dir, 'fake-dsh.jsonl') }
}

function readLog(path: string): Array<{ kind: string; sessionId?: string; text?: string }> {
  try {
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line))
  } catch {
    return []
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 6000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.ok(predicate(), 'condition not reached before timeout')
}

test('classifySlotResult：posted / passed / missed', () => {
  assert.deepEqual(classifySlotResult('  你好  '), { kind: 'posted', text: '  你好  ' })
  assert.deepEqual(classifySlotResult('[PASS]'), { kind: 'passed' })
  assert.deepEqual(classifySlotResult('  [PASS]\n'), { kind: 'passed' })
  assert.deepEqual(classifySlotResult('【pass】'), { kind: 'passed' })
  assert.deepEqual(classifySlotResult('pass'), { kind: 'posted', text: 'pass' })
  assert.deepEqual(classifySlotResult(undefined), { kind: 'missed' })
  assert.deepEqual(classifySlotResult('   '), { kind: 'missed' })
})

test('退避按 1s→2s→4s… 增长，30s 封顶', () => {
  let delay = 1000
  const seen: number[] = []
  for (let i = 0; i < 8; i += 1) {
    seen.push(delay)
    delay = nextBackoff(delay)
  }
  assert.deepEqual(seen, [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000])
  assert.equal(nextBackoff(0), 2000)
})

test('roomMembers 兼容 string/{botId}，去重且标记 host', () => {
  assert.deepEqual(roomMembers({ members: [{ botId: 'a', role: 'host' }, { botId: 'b' }, { botId: 'a' }, 'c'] }), [
    { botId: 'a', role: 'host' },
    { botId: 'b', role: 'member' },
    { botId: 'c', role: 'member' }
  ])
  assert.deepEqual(roomMembers({}), [])
})

test('两个成员：assignments 依次投递，每人 advance 一次，prompt 不串会话', async () => {
  const log = tempLog()
  const cp = await createFakeControlPlane({
    rooms: [
      {
        id: 'rm_multi',
        members: [
          { botId: 'alpha', role: 'host' },
          { botId: 'beta', role: 'member' }
        ]
      }
    ],
    messages: [{ seq: 1, actor: { kind: 'user', id: 'acc_1' }, text: '大家好' }],
    assignments: {
      rm_multi: [
        {
          roundId: 'rd_1',
          roomId: 'rm_multi',
          botId: 'alpha',
          sessionId: sessionIdFor('rm_multi', 'alpha'),
          prompt: 'alpha 请回答第一问',
          index: 1,
          total: 3
        },
        {
          roundId: 'rd_1',
          roomId: 'rm_multi',
          botId: 'beta',
          sessionId: sessionIdFor('rm_multi', 'beta'),
          prompt: 'beta 请回答第二问',
          index: 2,
          total: 3
        }
      ]
    }
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
    await waitFor(() => cp.advances.length === 2)
    // 多成员路径：回复走 advance 写回 slot，不再直接 say
    assert.equal(cp.said.length, 0)
    assert.deepEqual(
      cp.advances.map((advance) => advance.slotIndex),
      [1, 2]
    )
    assert.deepEqual(
      cp.advances.map((advance) => [advance.roundId, advance.result.kind]),
      [
        ['rd_1', 'posted'],
        ['rd_1', 'posted']
      ]
    )
    assert.match(cp.advances[0].result.text, /alpha 请回答第一问/)
    assert.match(cp.advances[1].result.text, /beta 请回答第二问/)

    const entries = readLog(log.path)
    const prompts = entries.filter((entry) => entry.kind === 'prompt')
    assert.deepEqual(prompts.map((entry) => entry.sessionId).sort(), [
      sessionIdFor('rm_multi', 'alpha'),
      sessionIdFor('rm_multi', 'beta')
    ])
    // assignment.prompt 直接投递，不再套"房间里有人说"模板
    assert.deepEqual(prompts.map((entry) => entry.text).sort(), ['alpha 请回答第一问', 'beta 请回答第二问'])
    // 每个 (room, member) 启动时只 resume 一次
    const resumes = entries.filter((entry) => entry.kind === 'resume')
    assert.equal(resumes.filter((entry) => entry.sessionId === sessionIdFor('rm_multi', 'alpha')).length, 1)
    assert.equal(resumes.filter((entry) => entry.sessionId === sessionIdFor('rm_multi', 'beta')).length, 1)

    // 回复 idem 对同 seq 的不同 Bot 不同
    assert.equal(replyIdem('rm_multi', 1, 'alpha'), 'reply-rm_multi-1-alpha')
    assert.notEqual(replyIdem('rm_multi', 1, 'alpha'), replyIdem('rm_multi', 1, 'beta'))
  } finally {
    await agent.stop()
    await cp.close()
    rmSync(log.dir, { recursive: true, force: true })
  }
})

test('单 Bot 回退：assignments 404 时仍按旧路径 say', async () => {
  const cp = await createFakeControlPlane({
    rooms: [{ id: 'rm_solo', members: [] }],
    messages: [{ seq: 1, actor: { kind: 'user', id: 'acc_1' }, text: '在吗' }]
    // 不配 assignments → 404
  })
  const agent = await startRoomAgent({
    apiBase: cp.base,
    runtimeToken: 'rt',
    botId: 'selector',
    dshBin: join(HERE, 'fake-dsh.mjs'),
    pollMs: 10,
    log: () => {}
  })
  try {
    await waitFor(() => cp.said.length === 1)
    assert.equal(cp.advances.length, 0)
    assert.equal(cp.said[0].botId, 'selector')
    assert.equal(cp.said[0].idem, 'reply-rm_solo-1-selector')
    assert.match(cp.said[0].text, /房间里有人说：在吗/)
  } finally {
    await agent.stop()
    await cp.close()
  }
})

test('会话常驻：第二轮仍用同一个 sessionId，不会重复 resume', async () => {
  const log = tempLog()
  const cp = await createFakeControlPlane({
    rooms: [{ id: 'rm_resume', members: [{ botId: 'selector', role: 'host' }] }],
    messages: [
      { seq: 1, actor: { kind: 'user', id: 'acc_1' }, text: '第一句' },
      { seq: 3, actor: { kind: 'user', id: 'acc_1' }, text: '第二句' }
    ]
    // assignments 404 → 单 Bot 路径，便于观察 sessionId
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
    await waitFor(() => cp.said.length === 2)
    assert.match(cp.said[1].text, /第 2 轮/)
    const sessionId = sessionIdFor('rm_resume', 'selector')
    const entries = readLog(log.path)
    const prompts = entries.filter((entry) => entry.kind === 'prompt')
    assert.equal(prompts.length, 2)
    assert.deepEqual(prompts.map((entry) => entry.sessionId), [sessionId, sessionId])
    // 启动时按成员 prepare 一次；两轮之间复用同一会话
    assert.equal(entries.filter((entry) => entry.kind === 'resume' && entry.sessionId === sessionId).length, 1)
  } finally {
    await agent.stop()
    await cp.close()
    rmSync(log.dir, { recursive: true, force: true })
  }
})

test('控制面先失败后成功：日志一行 + 退避后恢复，不崩', async () => {
  const lines: string[] = []
  const cp = await createFakeControlPlane({
    rooms: [{ id: 'rm_backoff', members: [] }],
    messages: [{ seq: 1, actor: { kind: 'user', id: 'acc_1' }, text: '恢复了吗' }],
    failRooms: 2
  })
  const agent = await startRoomAgent({
    apiBase: cp.base,
    runtimeToken: 'rt',
    botId: 'selector',
    dshBin: join(HERE, 'fake-dsh.mjs'),
    pollMs: 5,
    backoffBaseMs: 10,
    backoffMaxMs: 40,
    log: (line: string) => lines.push(line)
  })
  try {
    await waitFor(() => cp.said.length === 1)
    assert.equal(cp.said[0].idem, 'reply-rm_backoff-1-selector')
    assert.ok(cp.state.roomsRequests >= 3)
    const failures = lines.filter((line) => line.includes('poll failed'))
    assert.equal(failures.length, 2)
    // 日志一行（不刷屏），且带状态码
    assert.ok(failures.every((line) => line.startsWith('poll failed:') && line.includes('500')))
  } finally {
    await agent.stop()
    await cp.close()
  }
})

test('本轮没有 assignments 时不再回退 say（避免越过轮次引擎）', async () => {
  const lines: string[] = []
  const cp = await createFakeControlPlane({
    rooms: [{ id: 'rm_empty', members: [{ botId: 'alpha', role: 'host' }] }],
    messages: [{ seq: 1, actor: { kind: 'user', id: 'acc_1' }, text: '这轮没人说' }],
    assignments: { rm_empty: [] }
  })
  const agent = await startRoomAgent({
    apiBase: cp.base,
    runtimeToken: 'rt',
    botId: 'selector',
    dshBin: join(HERE, 'fake-dsh.mjs'),
    pollMs: 10,
    log: (line: string) => lines.push(line)
  })
  try {
    await waitFor(() => lines.some((line) => line.includes('no assignments for rm_empty')))
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(cp.said.length, 0)
    assert.equal(cp.advances.length, 0)
  } finally {
    await agent.stop()
    await cp.close()
  }
})

test('[PASS] 通过 advance 报 passed，不写日志', async () => {
  const cp = await createFakeControlPlane({
    rooms: [{ id: 'rm_pass', members: [{ botId: 'alpha', role: 'host' }] }],
    messages: [{ seq: 1, actor: { kind: 'user', id: 'acc_1' }, text: '有补充吗' }],
    assignments: {
      rm_pass: [
        {
          roundId: 'rd_pass',
          roomId: 'rm_pass',
          botId: 'alpha',
          sessionId: sessionIdFor('rm_pass', 'alpha'),
          prompt: '有补充吗',
          index: 0,
          total: 1
        }
      ]
    }
  })
  const agent = await startRoomAgent({
    apiBase: cp.base,
    runtimeToken: 'rt',
    botId: 'selector',
    dshBin: join(HERE, 'fake-dsh.mjs'),
    dshEnv: { FAKE_DSH_ANSWER: '[PASS]' },
    pollMs: 10,
    log: () => {}
  })
  try {
    await waitFor(() => cp.advances.length === 1)
    assert.deepEqual(cp.advances[0].result, { kind: 'passed' })
    assert.equal(cp.said.length, 0)
  } finally {
    await agent.stop()
    await cp.close()
  }
})

const MODE_CASES: Array<{ mode: string; expected: string }> = [
  { mode: 'working', expected: 'working' },
  { mode: 'approval', expected: 'approval' },
  { mode: 'silent', expected: 'missed' },
  { mode: 'error', expected: 'failed' }
]

for (const { mode, expected } of MODE_CASES) {
  test(`会话状态映射：${mode} → ${expected}`, async () => {
    const cp = await createFakeControlPlane({
      rooms: [{ id: `rm_${mode}`, members: [{ botId: 'alpha', role: 'host' }] }],
      messages: [{ seq: 1, actor: { kind: 'user', id: 'acc_1' }, text: '现在怎么样' }],
      assignments: {
        [`rm_${mode}`]: [
          {
            roundId: `rd_${mode}`,
            roomId: `rm_${mode}`,
            botId: 'alpha',
            sessionId: sessionIdFor(`rm_${mode}`, 'alpha'),
            prompt: '现在怎么样',
            index: 0,
            total: 1
          }
        ]
      }
    })
    const agent = await startRoomAgent({
      apiBase: cp.base,
      runtimeToken: 'rt',
      botId: 'selector',
      dshBin: join(HERE, 'fake-dsh.mjs'),
      dshEnv: { FAKE_DSH_MODE: mode },
      turnTimeoutMs: 80,
      pollMs: 10,
      log: () => {}
    })
    try {
      await waitFor(() => cp.advances.length === 1)
      assert.equal(cp.advances[0].result.kind, expected)
      if (expected === 'failed') assert.equal(cp.advances[0].result.code, 'SESSION')
    } finally {
      await agent.stop()
      await cp.close()
    }
  })
}

test('advance 终态 4xx（轮次已停）：不重投同一消息，只记一行日志', async () => {
  const lines: string[] = []
  const cp = await createFakeControlPlane({
    rooms: [{ id: 'rm_stopped', members: [{ botId: 'alpha', role: 'host' }] }],
    messages: [{ seq: 1, actor: { kind: 'user', id: 'acc_1' }, text: '这轮被停了' }],
    assignments: {
      rm_stopped: [
        {
          roundId: 'rd_stopped',
          roomId: 'rm_stopped',
          botId: 'alpha',
          sessionId: sessionIdFor('rm_stopped', 'alpha'),
          prompt: '这轮被停了',
          index: 0,
          total: 1
        }
      ]
    },
    advanceStatus: 409
  })
  const agent = await startRoomAgent({
    apiBase: cp.base,
    runtimeToken: 'rt',
    botId: 'selector',
    dshBin: join(HERE, 'fake-dsh.mjs'),
    pollMs: 10,
    log: (line: string) => lines.push(line)
  })
  try {
    await waitFor(() => lines.some((line) => line.includes('advance skipped rd_stopped')))
    const before = cp.state.requests.filter((request) => request.path.endsWith('/advance')).length
    await new Promise((resolve) => setTimeout(resolve, 200))
    const after = cp.state.requests.filter((request) => request.path.endsWith('/advance')).length
    assert.equal(before, 1)
    assert.equal(after, 1, '终态 4xx 不应触发同一条消息重投')
    assert.equal(cp.advances.length, 0)
  } finally {
    await agent.stop()
    await cp.close()
  }
})
