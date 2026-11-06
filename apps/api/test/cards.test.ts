// 选项卡 / 审批卡：答题、租户隔离、重启后续跑、用户发图。

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createBot } from '../../../packages/store/src/bots.ts'
import { openStore } from '../../../packages/store/src/index.ts'
import { getRoom, sendMessage } from '../../../packages/store/src/rooms.ts'
import { createRoomExt } from '../../../packages/store/src/rooms-ext.ts'
import { activeRound } from '../../../packages/store/src/rounds.ts'
import { createWorkspace } from '../../../packages/store/src/workspaces.ts'
import { decideApproval } from '../../../packages/store/src/approvals.ts'
import { choiceCard } from '../../runtime/cards.mjs'
import { answerChoiceCard, postCard, projectApprovalDecision } from '../src/cards.ts'
import { openRoundForMessage } from '../src/round-orchestrator.ts'
import { createStorePort } from '../src/store-adapter.ts'
import { startServer } from '../src/server.ts'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

test('choiceCard 帮助函数把字符串选项收成 id/label', () => {
  const card = choiceCard('口径？', ['TTM', '最近一期'])
  assert.equal(card.type, 'choice')
  assert.deepEqual(card.options, [
    { id: 'TTM', label: 'TTM' },
    { id: '最近一期', label: '最近一期' },
  ])
})

test('选项卡停车后关掉库再打开，答案把 slot 放回 waiting', () => {
  const dir = mkdtempSync(join(tmpdir(), 'roost-cards-'))
  const path = join(dir, 'roost.db')
  const store = openStore(path)
  let roomId = ''
  let cardId = ''
  try {
    const workspace = createWorkspace(store, { tenantId: 'tenant_1', name: '研究', profileVersion: 'dev' })
    const host = createBot(store, {
      workspaceId: workspace.id,
      name: '研究员',
      role: '选股',
      model: 'deepseek-chat',
      createdBy: 'acc_1',
    })
    const created = createRoomExt(store, {
      workspaceId: workspace.id,
      memberBotIds: [host.id],
      hostBotId: host.id,
      responder: { kind: 'member', botId: host.id },
      createdBy: 'acc_1',
    })
    roomId = created.room.id
    const room = getRoom(store, roomId)
    assert.ok(room !== null)
    const sent = sendMessage(store, { roomId, text: '用哪个口径', actor: { kind: 'user', id: 'acc_1' } })
    const round = openRoundForMessage({ store, room, seq: sent.seq, text: sent.text })
    assert.ok(round !== null)
    const posted = postCard({
      store,
      roomId,
      botId: host.id,
      text: '口径请拍板',
      card: {
        type: 'choice',
        prompt: '口径用 TTM 还是最近一期？',
        options: [
          { id: 'a', label: 'TTM（滚动十二个月）' },
          { id: 'b', label: '最近一期财报' },
        ],
      },
    })
    cardId = posted.cardId
    assert.equal(posted.round?.slots[0]?.status, 'needs_input')
    assert.equal(posted.message.parts?.some((part) => part.type === 'choice'), true)
  } finally {
    store.close()
  }

  const reopened = openStore(path)
  try {
    const parked = activeRound(reopened, roomId)
    assert.ok(parked !== null)
    assert.equal(parked.slots[0]?.status, 'needs_input')
    assert.equal(parked.slots[0]?.awaiting?.id, cardId)
    const answered = answerChoiceCard({
      store: reopened,
      roomId,
      cardId,
      optionId: 'a',
      accountId: 'acc_1',
    })
    assert.equal(answered.label, 'TTM（滚动十二个月）')
    assert.equal(answered.alreadyAnswered, false)
    const resumed = activeRound(reopened, roomId)
    assert.ok(resumed !== null)
    assert.equal(resumed.state, 'running')
    assert.equal(resumed.slots[0]?.status, 'waiting')
    const again = answerChoiceCard({
      store: reopened,
      roomId,
      cardId,
      optionId: 'b',
      accountId: 'acc_1',
    })
    assert.equal(again.alreadyAnswered, true)
    assert.equal(again.optionId, 'a')
  } finally {
    reopened.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('审批卡复用 approvals 表，决定之后轮次继续', () => {
  const store = openStore(':memory:')
  try {
    const workspace = createWorkspace(store, { tenantId: 'tenant_1', name: '研究', profileVersion: 'dev' })
    const host = createBot(store, {
      workspaceId: workspace.id,
      name: '风控',
      role: '风控',
      model: 'deepseek-chat',
      createdBy: 'acc_1',
    })
    const created = createRoomExt(store, {
      workspaceId: workspace.id,
      memberBotIds: [host.id],
      hostBotId: host.id,
      responder: { kind: 'member', botId: host.id },
      createdBy: 'acc_1',
    })
    const room = getRoom(store, created.room.id)
    assert.ok(room !== null)
    const sent = sendMessage(store, { roomId: room.id, text: '发邮件', actor: { kind: 'user', id: 'acc_1' } })
    openRoundForMessage({ store, room, seq: sent.seq, text: sent.text })
    const posted = postCard({
      store,
      roomId: room.id,
      botId: host.id,
      card: {
        type: 'approval',
        title: '选股师请求发送邮件',
        kind: 'email.send',
        action: '发送',
        target: 'research@example.com',
        consequence: '发出后无法撤回',
      },
    })
    assert.ok(posted.approvalId)
    assert.equal(activeRound(store, room.id)?.slots[0]?.status, 'needs_input')
    const decided = decideApproval(store, { id: posted.approvalId!, decision: 'approved', by: 'acc_1' })
    projectApprovalDecision(store, decided, 'approved', 'acc_1')
    assert.equal(activeRound(store, room.id)?.slots[0]?.status, 'waiting')
  } finally {
    store.close()
  }
})

async function pair(base: string, accountId: string): Promise<{ token: string; workspaceId: string }> {
  const code = ((await (await fetch(`${base}/api/pairing/code`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accountId }),
  })).json()) as { code: string }).code
  const token = ((await (await fetch(`${base}/api/pairing/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  })).json()) as { sessionToken: string }).sessionToken
  const workspace = ((await (await fetch(`${base}/api/workspaces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ name: accountId }),
  })).json()) as { workspace: { id: string } }).workspace
  return { token, workspaceId: workspace.id }
}

test('HTTP：发图、答题、别的租户不能代答', async () => {
  const rawStore = openStore(':memory:')
  const started = await startServer({
    store: createStorePort(rawStore),
    rawStore,
    port: 0,
    host: '127.0.0.1',
    runtimeToken: 'rt_cards_0123456789abcdef',
    streamPollMs: 15_000,
  })
  try {
    const owner = await pair(started.url, 'acc_owner')
    const stranger = await pair(started.url, 'acc_stranger')
    const auth = { authorization: `Bearer ${owner.token}`, 'content-type': 'application/json' }
    const botRes = await fetch(`${started.url}/api/bots`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ workspaceId: owner.workspaceId, name: '选股师', model: 'deepseek-v3' }),
    })
    assert.equal(botRes.status, 201)
    const botId = ((await botRes.json()) as { bot: { id: string } }).bot.id
    const peerRes = await fetch(`${started.url}/api/bots`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ workspaceId: owner.workspaceId, name: '风控官', model: 'deepseek-v3' }),
    })
    assert.equal(peerRes.status, 201)
    const peerId = ((await peerRes.json()) as { bot: { id: string } }).bot.id
    const roomRes = await fetch(`${started.url}/api/rooms`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        workspaceId: owner.workspaceId,
        name: '研究',
        memberBotIds: [botId, peerId],
        hostBotId: botId,
        responder: { kind: 'member', botId },
      }),
    })
    assert.equal(roomRes.status, 201, await roomRes.clone().text())
    const roomId = ((await roomRes.json()) as { room: { id: string } }).room.id

    const upload = await fetch(`${started.url}/api/rooms/${roomId}/artifacts`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${owner.token}`,
        'content-type': 'image/png',
        'x-artifact-name': 'chart.png',
      },
      body: PNG,
    })
    assert.equal(upload.status, 201, await upload.clone().text())
    const artifactId = ((await upload.json()) as { artifactId: string }).artifactId

    const imageMessage = await fetch(`${started.url}/api/rooms/${roomId}/messages`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ text: '看这张图', artifactIds: [artifactId] }),
    })
    assert.equal(imageMessage.status, 201, await imageMessage.clone().text())
    const imageBody = (await imageMessage.json()) as {
      message: {
        parts?: Array<{ type: string; artifactId?: string; url?: string }>
        attachments: Array<{ artifactId: string; url?: string }>
      }
    }
    assert.equal(imageBody.message.attachments[0]?.artifactId, artifactId)
    const imagePart = imageBody.message.parts?.find((part) => part.type === 'image' && part.artifactId === artifactId)
    assert.ok(imagePart)
    assert.match(imagePart?.url ?? '', /^\/api\/attachments\/[0-9a-f]{32}\?token=/)
    const img = await fetch(`${started.url}${imagePart?.url}`)
    assert.equal(img.status, 200)
    assert.equal(imageBody.message.attachments[0]?.url, imagePart?.url)

    const said = await fetch(`${started.url}/api/rooms/${roomId}/say`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-runtime-token': 'rt_cards_0123456789abcdef' },
      body: JSON.stringify({
        botId,
        text: '口径请拍板',
        card: choiceCard('口径用 TTM 还是最近一期？', [
          { id: 'a', label: 'TTM' },
          { id: 'b', label: '最近一期' },
        ]),
      }),
    })
    assert.equal(said.status, 201, await said.clone().text())
    const saidBody = (await said.json()) as { cardId: string; round: { slots: Array<{ status: string }> } }
    assert.equal(saidBody.round.slots[0]?.status, 'needs_input')

    const denied = await fetch(`${started.url}/api/rooms/${roomId}/cards/${saidBody.cardId}/answer`, {
      method: 'POST',
      headers: { authorization: `Bearer ${stranger.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ optionId: 'a' }),
    })
    assert.equal(denied.status, 403)

    const answered = await fetch(`${started.url}/api/rooms/${roomId}/cards/${saidBody.cardId}/answer`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ optionId: 'a' }),
    })
    assert.equal(answered.status, 200, await answered.clone().text())
    const answeredBody = (await answered.json()) as {
      label: string
      alreadyAnswered: boolean
      round: { state: string; slots: Array<{ status: string }> }
    }
    assert.equal(answeredBody.label, 'TTM')
    assert.equal(answeredBody.alreadyAnswered, false)
    assert.equal(answeredBody.round.state, 'running')
    assert.equal(answeredBody.round.slots[0]?.status, 'waiting')

    const listed = await fetch(`${started.url}/api/rooms/${roomId}/messages`, { headers: { authorization: `Bearer ${owner.token}` } })
    const listedBody = (await listed.json()) as { messages: Array<{ parts?: Array<{ type: string; selectedOptionId?: string }> }> }
    const choice = listedBody.messages.flatMap((message) => message.parts ?? []).find((part) => part.type === 'choice')
    assert.equal(choice?.selectedOptionId, 'a')
  } finally {
    await started.close()
    rawStore.close()
  }
})
