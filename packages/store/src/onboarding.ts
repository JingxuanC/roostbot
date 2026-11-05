// 新 workspace 的默认主 Bot + 私聊 DM。
//
// 产品要求：用户第一次进入 workspace 时不应只有空列表和“新建 Bot”表单，
// 而应有一个可以直接说话的主 Bot。这里做成幂等：已有同名 Bot / DM 就复用。

import { createBot } from './bots.ts'
import { createDmRoom } from './dm.ts'
import { newRoostId } from './ids.ts'
import { StoreError } from './errors.ts'
import { asInteger, asNonEmptyString, asRecord, assertOpen } from './internal.ts'
import type { Bot } from './bots.ts'
import type { DmRoom } from './dm.ts'
import type { Store } from './types.ts'

export const MAIN_BOT_NAME = '主 Bot'
export const MAIN_BOT_ROLE = '主理人'
export const MAIN_BOT_MODEL = 'deepseek-flash'

export interface EnsureMainBotInput {
  workspaceId: string
  accountId: string
  at?: number
}

export interface EnsureMainBotResult {
  bot: Bot
  room: DmRoom
  createdBot: boolean
}

/** 取或建 workspace 的主 Bot，并保证它有且只有一个私聊 DM。 */
export function ensureMainBot(store: Store, input: EnsureMainBotInput): EnsureMainBotResult {
  assertOpen(store)
  const req = asRecord(input, 'mainBot')
  const workspaceId = asNonEmptyString(req.workspaceId, 'mainBot.workspaceId', 'INVALID_WORKSPACE')
  const accountId = asNonEmptyString(req.accountId, 'mainBot.accountId', 'INVALID_ACCOUNT')
  const at = asInteger(req.at ?? Date.now(), 'mainBot.at', 0)

  const workspace = store.db.prepare('SELECT id FROM workspaces WHERE id = ?').get(workspaceId)
  if (workspace === undefined || workspace === null) {
    throw new StoreError('WORKSPACE_NOT_FOUND', `unknown workspace ${workspaceId}`)
  }
  const row = store.db
    .prepare('SELECT id FROM bots WHERE workspace_id = ? AND name = ? AND deleted_at IS NULL LIMIT 1')
    .get(workspaceId, MAIN_BOT_NAME) as { id?: string } | undefined

  let bot: Bot
  let createdBot = false
  if (row !== undefined && typeof row.id === 'string' && row.id !== '') {
    bot = readBot(store, row.id)
  } else {
    // 主 Bot 的名字在 workspace 内必须唯一；createBot 自己会做名字锁。
    // 如果并发创建撞名，回退到按名字读取即可。
    try {
      bot = createBot(store, {
        workspaceId,
        name: MAIN_BOT_NAME,
        role: MAIN_BOT_ROLE,
        model: MAIN_BOT_MODEL,
        provider: 'deepseek-official',
        createdBy: accountId,
        createdAt: at
      })
      createdBot = true
    } catch (err) {
      const raced = store.db
        .prepare('SELECT id FROM bots WHERE workspace_id = ? AND name = ? AND deleted_at IS NULL LIMIT 1')
        .get(workspaceId, MAIN_BOT_NAME) as { id?: string } | undefined
      if (raced === undefined || typeof raced.id !== 'string') throw err
      bot = readBot(store, raced.id)
    }
  }

  const room = createDmRoom(store, { workspaceId, botId: bot.id, createdBy: accountId, at })
  return { bot, room, createdBot }
}

function readBot(store: Store, botId: string): Bot {
  const row = store.db.prepare('SELECT * FROM bots WHERE id = ? AND deleted_at IS NULL').get(botId)
  if (row === undefined || row === null) throw new StoreError('BOT_NOT_FOUND', `unknown bot ${botId}`)
  // createBot 的公开结构这里不重复解析；直接复用包内 row 映射函数会形成循环依赖，
  // 这个项目里 Bot 字段是稳定的，保持最小映射即可。
  const r = row as Record<string, unknown>
  return {
    id: String(r['id']),
    workspaceId: String(r['workspace_id']),
    name: String(r['name']),
    role: String(r['role'] ?? ''),
    persona: String(r['persona'] ?? ''),
    provider: String(r['provider'] ?? ''),
    model: String(r['model'] ?? ''),
    avatar: null,
    skills: [],
    toolsAllow: [],
    toolsDeny: [],
    approval: String(r['approval'] ?? 'ask') as Bot['approval'],
    memoryScopes: ['team'],
    status: String(r['status'] ?? 'active') as Bot['status'],
    createdBy: String(r['created_by']),
    createdAt: Number(r['created_at']),
    deletedAt: null
  }
}
