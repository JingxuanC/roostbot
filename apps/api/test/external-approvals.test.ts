import assert from 'node:assert/strict'
import test from 'node:test'

import { createExternalApprovalPolicy } from '../../runtime/external-approvals.mjs'

function fakeRequest(responses) {
  const calls = []
  return {
    calls,
    async request(path, init = {}) {
      calls.push({ path, init })
      const response = responses.shift()
      if (response === undefined) throw new Error(`unexpected request ${path}`)
      return new Response(JSON.stringify(response.body), { status: response.status ?? 200 })
    },
  }
}

test('granted approvals allow the ACP tool without polling', async () => {
  const fake = fakeRequest([{ body: { approval: null, granted: true } }])
  const policy = createExternalApprovalPolicy({ request: fake.request, workspaceId: 'ws_1' })
  const decision = await policy({ tool: 'Bash', args: { cmd: 'ls' }, requestId: 'r1' }, { spec: { botId: 'bot_1' } })
  assert.equal(decision, 'allow')
  assert.equal(fake.calls.length, 1)
  const body = JSON.parse(fake.calls[0].init.body)
  assert.equal(body.requester, 'bot_1')
  assert.equal(body.kind, 'tool.call')
})

test('pending approvals poll and map denied to ACP deny', async () => {
  const fake = fakeRequest([
    { body: { approval: { id: 'ap_1', status: 'pending' }, granted: false } },
    { body: { approval: { id: 'ap_1', status: 'pending' } } },
    { body: { approval: { id: 'ap_1', status: 'denied' } } },
  ])
  const sleeps = []
  const policy = createExternalApprovalPolicy({
    request: fake.request,
    workspaceId: 'ws_1',
    sleep: async (ms) => { sleeps.push(ms) },
  })
  const decision = await policy({ tool: 'Bash', args: {}, requestId: 'r2' }, { spec: { botId: 'bot_1' } })
  assert.equal(decision, 'deny')
  assert.equal(fake.calls.length, 3)
  assert.deepEqual(sleeps, [1000, 1000])
})

test('a control-plane failure denies instead of silently allowing', async () => {
  const fake = fakeRequest([{ status: 500, body: { error: 'boom' } }])
  const policy = createExternalApprovalPolicy({ request: fake.request, workspaceId: 'ws_1' })
  assert.equal(await policy({ tool: 'Bash', args: {}, requestId: 'r3' }, { spec: { botId: 'bot_1' } }), 'deny')
})
