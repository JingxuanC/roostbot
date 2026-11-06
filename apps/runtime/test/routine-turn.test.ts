import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { decideRoutineAttempt, isolatedRoutinePrompt } from '../routine-turn.mjs'
import { startRoomAgent } from '../room-agent.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

test('隔离 prompt 不带历史；失败有界，缺密钥不重试', () => {
  assert.equal(isolatedRoutinePrompt('  只看异动 \n'), '只看异动')
  assert.deepEqual(decideRoutineAttempt({ attempt: 1, answer: '无异动' }), { action: 'post', text: '无异动', error: false })
  assert.equal(decideRoutineAttempt({ attempt: 1 }).action, 'silent')
  const missing = decideRoutineAttempt({ attempt: 1, error: '401 unauthorized api key' })
  assert.equal(missing.action, 'post')
  assert.equal(missing.error, true)
  assert.match(missing.text, /模型密钥/)
  assert.equal(decideRoutineAttempt({ attempt: 1, error: 'upstream 500' }).action, 'retry')
  assert.equal(decideRoutineAttempt({ attempt: 3, error: 'upstream 500' }).action, 'post')
  assert.equal(decideRoutineAttempt({ attempt: 2, timedOut: true }).action, 'retry')
  assert.match(decideRoutineAttempt({ attempt: 3, timedOut: true }).text ?? '', /超时/)
})

test('routine.fired 用新会话跑模型，结果只提交一次', async () => {
  const results: Array<{ text?: string; error?: boolean }> = []
  let served = false
  const logPath = join(mkdtempSync(join(tmpdir(), 'roost-routine-')), 'dsh.jsonl')
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://local')
    if (url.pathname === '/api/internal/rooms') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ rooms: [{ id: 'rm_routine', members: [{ botId: 'selector' }] }] }))
      return
    }
    if (url.pathname === '/api/internal/events') {
      const events = served
        ? []
        : [{
            seq: 4,
            kind: 'schedule.routine.fired',
            roomId: 'rm_routine',
            payload: { runId: 'rrn_1', botId: 'selector', routineId: 'rtn_1', prompt: '只报告异动' },
          }]
      served = true
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ events }))
      return
    }
    if (req.method === 'POST' && url.pathname === '/api/internal/routine-runs/rrn_1/result') {
      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => {
        results.push(JSON.parse(body) as { text?: string; error?: boolean })
        res.setHeader('content-type', 'application/json')
        res.end('{}')
      })
      return
    }
    res.statusCode = 404
    res.end('{}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  const agent = await startRoomAgent({
    apiBase: `http://127.0.0.1:${port}`,
    runtimeToken: 'rt',
    botId: 'selector',
    dshBin: join(HERE, 'fake-dsh.mjs'),
    dshEnv: { FAKE_DSH_ANSWER: '无异动', FAKE_DSH_LOG: logPath },
    pollMs: 30,
    log: () => {},
  })
  try {
    const deadline = Date.now() + 5000
    while (Date.now() < deadline && results.length < 1) await new Promise((resolve) => setTimeout(resolve, 20))
    await new Promise((resolve) => setTimeout(resolve, 80))
    assert.equal(results.length, 1)
    assert.equal(results[0]?.text, '无异动')
    assert.notEqual(results[0]?.error, true)
    const lines = readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as { kind?: string; sessionId?: string; text?: string })
    const prompts = lines.filter((line) => line.kind === 'prompt')
    assert.equal(prompts.length, 1)
    assert.equal(prompts[0]?.text, '只报告异动')
    assert.match(prompts[0]?.sessionId ?? '', /^routine-rrn_1-/)
  } finally {
    await agent.stop()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('模型报错重试到上限后只交一张失败单', async () => {
  const results: Array<{ text?: string; error?: boolean }> = []
  let served = false
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://local')
    if (url.pathname === '/api/internal/rooms') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ rooms: [{ id: 'rm_routine', members: [{ botId: 'selector' }] }] }))
      return
    }
    if (url.pathname === '/api/internal/events') {
      const events = served
        ? []
        : [{
            seq: 2,
            kind: 'schedule.routine.fired',
            roomId: 'rm_routine',
            payload: { runId: 'rrn_err', botId: 'selector', prompt: '算一下' },
          }]
      served = true
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ events }))
      return
    }
    if (req.method === 'POST' && url.pathname === '/api/internal/routine-runs/rrn_err/result') {
      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => {
        results.push(JSON.parse(body) as { text?: string })
        res.setHeader('content-type', 'application/json')
        res.end('{}')
      })
      return
    }
    res.statusCode = 404
    res.end('{}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  const agent = await startRoomAgent({
    apiBase: `http://127.0.0.1:${port}`,
    runtimeToken: 'rt',
    botId: 'selector',
    dshBin: join(HERE, 'fake-dsh.mjs'),
    dshEnv: { FAKE_DSH_MODE: 'error' },
    pollMs: 20,
    log: () => {},
  })
  try {
    const deadline = Date.now() + 5000
    while (Date.now() < deadline && results.length < 1) await new Promise((resolve) => setTimeout(resolve, 20))
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(results.length, 1)
    assert.equal(results[0]?.error, true)
    assert.match(results[0]?.text ?? '', /失败/)
  } finally {
    await agent.stop()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
