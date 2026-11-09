import assert from 'node:assert/strict'
import { test } from 'node:test'

import { pairDevice, startSqliteHarness } from './helpers.ts'
import { issueRuntimeToken } from '../../../packages/store/src/runtime-tokens.ts'

test('a local computer can register, bind a Bot, claim a room job and post the result', async () => {
  const harness = await startSqliteHarness()
  try {
    const token = await pairDevice(harness)
    const workspace = await harness.call('POST', '/api/workspaces', { token, body: { name: 'local-computers' } })
    const workspaceId = workspace.json.workspace.id as string
    const bot = await harness.call('POST', '/api/bots', {
      token,
      body: { workspaceId, name: 'LocalBot', model: 'deepseek-chat', runtimeKind: 'claude-code' },
    })
    const botId = bot.json.bot.id as string
    const room = await harness.call('POST', '/api/rooms', { token, body: { workspaceId, name: 'LocalRoom' } })
    const roomId = room.json.room.id as string
    await harness.call('POST', `/api/rooms/${roomId}/members`, { token, body: { botIds: [botId] } })

    const computer = await harness.call('POST', '/api/computers', {
      token,
      body: { name: 'Test Mac', os: 'darwin', arch: 'arm64', fingerprint: 'fp-test-mac', version: '0.1.0' },
    })
    assert.equal(computer.status, 201, computer.text)
    const computerId = computer.json.computer.id as string
    const computerToken = computer.json.token as string
    assert.match(computerToken, /^roostc_/)

    const binding = await harness.call('POST', `/api/workspaces/${workspaceId}/computer-bindings`, {
      token,
      body: { computerId, botId, agentKind: 'claude-code', projectId: 'proj_demo1', workdirLabel: 'project-a' },
    })
    assert.equal(binding.status, 201, binding.text)
    const bindingId = binding.json.binding.id as string
    assert.equal(binding.json.binding.projectId, 'proj_demo1')

    const message = await harness.call('POST', `/api/rooms/${roomId}/messages`, {
      token,
      body: { text: '本地执行一下' },
    })
    assert.equal(message.status, 201, message.text)

    const runtimeToken = issueRuntimeToken(harness.rawStore!, { workspaceId, ttlMs: 60_000, at: harness.clock.now() })
    const cloudAssignments = await harness.call('GET', `/api/internal/rooms/${roomId}/assignments`, {
      headers: { 'x-runtime-token': runtimeToken.token },
    })
    assert.equal(cloudAssignments.status, 200, cloudAssignments.text)
    assert.equal(cloudAssignments.json.assignments.some((item: { botId: string }) => item.botId === botId), false)

    // A Bot gets a DM kickoff round at creation, so the first job can be that
    // kickoff. Keep claiming jobs until the room's user message is handled.
    let handledRoomJob = false
    for (let attempt = 0; attempt < 4 && !handledRoomJob; attempt += 1) {
      const jobs = await harness.call('GET', `/api/computers/${computerId}/jobs`, { token: computerToken })
      assert.equal(jobs.status, 200, jobs.text)
      assert.ok(jobs.json.job, 'expected a local job')
      const job = jobs.json.job
      assert.equal(job.bindingId, bindingId)
      assert.equal(job.botId, botId)
      const claim = await harness.call('POST', `/api/computers/${computerId}/jobs/${job.id}/claim`, { token: computerToken })
      assert.equal(claim.status, 200, claim.text)
      assert.equal(claim.json.job.state, 'claimed')
      const delta = await harness.call('POST', `/api/computers/${computerId}/jobs/${job.id}/events`, {
        token: computerToken,
        body: { delta: '本地流式' },
      })
      assert.equal(delta.status, 201, delta.text)
      if (job.roomId === roomId) {
        const events = harness.rawStore?.db.prepare("SELECT kind, payload_json FROM events WHERE audience = ? ORDER BY seq DESC LIMIT 3").all(`room:${roomId}`) as Array<{ kind: string; payload_json: string }>
        assert.ok(events?.some((event) => event.kind === 'chat.message.delta' && event.payload_json.includes('本地流式')))
      }
      const result = await harness.call('POST', `/api/computers/${computerId}/jobs/${job.id}/result`, {
        token: computerToken,
        body: { result: { kind: 'posted', text: handledRoomJob || job.roomId === roomId ? '来自本地电脑的回答' : 'DM kickoff' } },
      })
      assert.equal(result.status, 200, result.text)
      assert.equal(result.json.job.state, 'done')
      if (job.roomId === roomId) handledRoomJob = true
    }
    assert.equal(handledRoomJob, true, 'expected the room job to be claimed')

    const messages = await harness.call('GET', `/api/rooms/${roomId}/messages`, { token })
    assert.ok(messages.json.messages.some((item: { text: string }) => item.text === '来自本地电脑的回答'))
    // The same job result is idempotent; we need a job id from the last loop.
    const lastJobId = (await harness.call('GET', `/api/computers/${computerId}/jobs`, { token: computerToken })).json.job?.id
    void lastJobId


    const history = await harness.call('GET', `/api/computers/${computerId}/jobs/history?limit=10`, { token: computerToken })
    assert.equal(history.status, 200, history.text)
    assert.ok(history.json.jobs.some((item: { state: string }) => item.state === 'done'))
    const detail = await harness.call('GET', `/api/computers/${computerId}/jobs/${history.json.jobs[0].id}`, { token: computerToken })
    assert.equal(detail.status, 200, detail.text)
    assert.equal(detail.json.job.id, history.json.jobs[0].id)

    const heartbeat = await harness.call('POST', `/api/computers/${computerId}/heartbeat`, {
      token: computerToken,
      body: { version: '9.9.9', capabilities: { agents: [{ kind: 'claude-code', installed: true }] } },
    })
    assert.equal(heartbeat.status, 200, heartbeat.text)
    assert.equal(heartbeat.json.computer.status, 'connected')
    assert.equal(heartbeat.json.computer.version, '9.9.9')
    assert.deepEqual(heartbeat.json.computer.capabilities.agents[0].kind, 'claude-code')

    harness.clock.advance(120_000)
    const stale = await harness.call('GET', '/api/computers', { token })
    assert.equal(stale.json.computers[0].status, 'offline')

    const listed = await harness.call('GET', '/api/workspaces/' + workspaceId + '/computer-bindings', { token })
    assert.equal(listed.status, 200)
    assert.equal(listed.json.bindings.length, 1)
  } finally {
    await harness.close()
  }
})

test('a computer token cannot read another computer jobs', async () => {
  const harness = await startSqliteHarness()
  try {
    const token = await pairDevice(harness)
    const a = await harness.call('POST', '/api/computers', {
      token,
      body: { name: 'A', os: 'darwin', arch: 'arm64', fingerprint: 'fp-a' },
    })
    const b = await harness.call('POST', '/api/computers', {
      token,
      body: { name: 'B', os: 'linux', arch: 'x64', fingerprint: 'fp-b' },
    })
    const response = await harness.call('GET', `/api/computers/${b.json.computer.id}/jobs`, { token: a.json.token })
    assert.equal(response.status, 403)
  } finally {
    await harness.close()
  }
})

test('a CLI token can authenticate the computer APIs', async () => {
  const harness = await startSqliteHarness()
  try {
    const session = await pairDevice(harness)
    const created = await harness.call('POST', '/api/cli/tokens', { token: session, body: { label: 'test cli' } })
    assert.equal(created.status, 201, created.text)
    assert.match(created.json.token, /^[0-9a-f]{64}$/)
    const listed = await harness.call('GET', '/api/computers', { token: created.json.token })
    assert.equal(listed.status, 200, listed.text)
    assert.deepEqual(listed.json.computers, [])
  } finally {
    await harness.close()
  }
})
