// Bot 域：名字锁、模型必填、人设版本、软/硬删边界（实现是硬删，见 src/bots.ts 文件头）。

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  createBot,
  createWorkspace,
  deleteBot,
  getBot,
  listBotVersions,
  listBots,
  updateBot,
} from '../src/index.ts'
import { assertStoreError, withStore } from './helpers.ts'

const BASE = 1_760_000_000_000
const MODEL = 'deepseek-v3'

function seedWorkspace(store: Parameters<typeof createWorkspace>[0], name = '量化研究组', tenantId = 'acc_1') {
  return createWorkspace(store, { tenantId, name, profileVersion: 'dev', createdAt: BASE })
}

function seedBot(
  store: Parameters<typeof createBot>[0],
  workspaceId: string,
  name: string,
  extra: { model?: string; role?: string; persona?: string } = {},
) {
  return createBot(store, {
    workspaceId,
    name,
    model: extra.model ?? MODEL,
    createdBy: 'acc_1',
    createdAt: BASE,
    ...(extra.role === undefined ? {} : { role: extra.role }),
    ...(extra.persona === undefined ? {} : { persona: extra.persona }),
  })
}

test('创建 Bot：默认值、get 与 list', async () => {
  await withStore((store) => {
    const workspace = seedWorkspace(store)
    const bot = seedBot(store, workspace.id, '研究员')

    assert.equal(bot.workspaceId, workspace.id)
    assert.equal(bot.role, '')
    assert.equal(bot.persona, '')
    assert.equal(bot.provider, 'deepseek-official')
    assert.equal(bot.model, MODEL)
    assert.equal(bot.approval, 'ask')
    assert.deepEqual(bot.memoryScopes, ['team'])
    assert.deepEqual(bot.skills, [])
    assert.deepEqual(bot.toolsAllow, [])
    assert.deepEqual(bot.toolsDeny, [])
    assert.equal(bot.status, 'active')
    assert.equal(bot.createdBy, 'acc_1')
    assert.equal(bot.createdAt, BASE)

    assert.deepEqual(getBot(store, bot.id), bot)
    assert.equal(getBot(store, 'bot_missing'), null)
    assert.deepEqual(listBots(store, workspace.id).map((row) => row.name), ['研究员'])
  })
})

test('名字：空、过长、非法字符都报 INVALID_BOT', async () => {
  await withStore((store) => {
    const workspace = seedWorkspace(store)
    for (const name of ['', '   ', 'x'.repeat(41), 'a/b', 'a@b', 'a:b']) {
      assertStoreError(() => seedBot(store, workspace.id, name), 'INVALID_BOT')
    }
    // 40 个字符是允许的上限。
    assert.equal(seedBot(store, workspace.id, 'x'.repeat(40)).name.length, 40)
  })
})

test('名字锁：同 workspace 重名 BOT_NAME_TAKEN，别的 workspace 可以同名', async () => {
  await withStore((store) => {
    const first = seedWorkspace(store)
    const second = seedWorkspace(store, '另一个组', 'acc_2')
    seedBot(store, first.id, '研究员')

    assertStoreError(() => seedBot(store, first.id, '研究员'), 'BOT_NAME_TAKEN')
    // 前后空白会先 trim，所以这仍算重名。
    assertStoreError(() => seedBot(store, first.id, '  研究员  '), 'BOT_NAME_TAKEN')
    assert.equal(seedBot(store, second.id, '研究员').workspaceId, second.id)
  })
})

test('模型必填：缺 model / 空 model 都是 BOT_NO_MODEL', async () => {
  await withStore((store) => {
    const workspace = seedWorkspace(store)
    assertStoreError(
      () => createBot(store, { workspaceId: workspace.id, name: '没有模型', createdBy: 'acc_1' } as never),
      'BOT_NO_MODEL',
    )
    assertStoreError(() => seedBot(store, workspace.id, '空模型', { model: '   ' }), 'BOT_NO_MODEL')
  })
})

test('角色超长、审批值非法 → INVALID_BOT；workspace 不存在 → WORKSPACE_NOT_FOUND', async () => {
  await withStore((store) => {
    const workspace = seedWorkspace(store)
    assertStoreError(() => seedBot(store, workspace.id, '角色太长', { role: 'x'.repeat(25) }), 'INVALID_BOT')
    assertStoreError(() => seedBot(store, 'ws_missing', '孤儿'), 'WORKSPACE_NOT_FOUND')
    const bot = seedBot(store, workspace.id, '审批')
    assertStoreError(
      () => updateBot(store, { botId: bot.id, actor: 'acc_1', patch: { approval: 'nope' as never } }),
      'INVALID_BOT',
    )
  })
})

test('人设变化写 bot_versions；没变不写；改名字也留版本吗（不，只有 persona）', async () => {
  await withStore((store) => {
    const workspace = seedWorkspace(store)
    const bot = seedBot(store, workspace.id, '研究员', { persona: '你是一个谨慎的研究员。' })

    // 创建时写入初始人设版本。
    const initial = listBotVersions(store, bot.id)
    assert.equal(initial.length, 1)
    assert.equal(initial[0]!.field, 'persona')
    assert.equal(initial[0]!.value, '你是一个谨慎的研究员。')

    updateBot(store, {
      botId: bot.id,
      actor: 'acc_1',
      patch: { persona: '你是一个更谨慎的研究员。', role: '数据' },
    })
    const after = listBotVersions(store, bot.id)
    assert.equal(after.length, 2)
    assert.equal(after[1]!.value, '你是一个更谨慎的研究员。')
    assert.equal(after[1]!.actor, 'acc_1')
    assert.equal(getBot(store, bot.id)?.role, '数据')

    // 同值再写一次不算变化。
    updateBot(store, { botId: bot.id, actor: 'acc_1', patch: { persona: '你是一个更谨慎的研究员。' } })
    assert.equal(listBotVersions(store, bot.id).length, 2)

    // 改名字/角色不写 persona 版本。
    updateBot(store, { botId: bot.id, actor: 'acc_1', patch: { name: '首席研究员', role: '研究' } })
    assert.equal(listBotVersions(store, bot.id).length, 2)
    assert.equal(getBot(store, bot.id)?.name, '首席研究员')
  })
})

test('updateBot：改名要过名字锁；status 可暂停；未知 Bot 报 BOT_NOT_FOUND', async () => {
  await withStore((store) => {
    const workspace = seedWorkspace(store)
    const a = seedBot(store, workspace.id, 'A')
    const b = seedBot(store, workspace.id, 'B')

    assertStoreError(() => updateBot(store, { botId: b.id, actor: 'acc_1', patch: { name: 'A' } }), 'BOT_NAME_TAKEN')
    // 改成自己的名字不算冲突。
    assert.equal(updateBot(store, { botId: b.id, actor: 'acc_1', patch: { name: 'B' } }).name, 'B')

    assert.equal(updateBot(store, { botId: b.id, actor: 'acc_1', patch: { status: 'paused' } }).status, 'paused')
    assertStoreError(
      () => updateBot(store, { botId: b.id, actor: 'acc_1', patch: { status: 'deleted' as never } }),
      'INVALID_BOT',
    )
    assertStoreError(() => updateBot(store, { botId: 'bot_missing', actor: 'acc_1', patch: { role: 'x' } }), 'BOT_NOT_FOUND')
    assert.equal(getBot(store, a.id)?.status, 'active')
  })
})

test('删除 Bot：行/版本/成员关系一起清掉，名字可复用', async () => {
  await withStore((store) => {
    const workspace = seedWorkspace(store)
    const bot = seedBot(store, workspace.id, '要删的', { persona: '旧人设' })
    assert.equal(listBotVersions(store, bot.id).length, 1)

    deleteBot(store, bot.id)
    assert.equal(getBot(store, bot.id), null)
    assert.deepEqual(listBots(store, workspace.id), [])
    const versions = store.db.prepare('SELECT COUNT(*) AS n FROM bot_versions WHERE bot_id = ?').get(bot.id) as {
      n: number
    }
    assert.equal(versions.n, 0)

    // 删掉之后名字重新可用。
    const again = seedBot(store, workspace.id, '要删的')
    assert.notEqual(again.id, bot.id)
    assertStoreError(() => deleteBot(store, 'bot_missing'), 'BOT_NOT_FOUND')
  })
})
