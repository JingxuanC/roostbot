// Bot 域（docs/design/bots.md、docs/build/m4-contract.md §1/§2）。
//
// 三条硬规则：
//   1. 名字锁：校验 → 查重 → INSERT 全在一个 savepoint 里；UNIQUE(workspace_id,name)
//      是最后一道锁（多进程并发也只可能有一个赢家）。重名抛 BOT_NAME_TAKEN。
//   2. 模型创建时固定：createBot 不接受空 model（BOT_NO_MODEL）；之后全局默认变了不影响它。
//      PATCH 仍可显式改 model（bots.md §4 的「模型」设置项）。
//   3. 人设版本化：persona 变化时写 bot_versions（field='persona'），历史只追加。
//
// 删除：本模块做「直接删」。契约的 bots 表没有 deleted_at / tombstone 列，BotStatus
// 也只有 active|paused，软删没有可落库的字段；硬删同时清掉 bot_versions 和 room_members，
// 保证「删掉的 Bot 不能被再拉进房间」且房间的 host/responder 不会指向幽灵成员。
// （设计文档想要 7 天可恢复；见交付报告里的契约偏差。）

import { BOT_LIMITS } from '../../contract/src/index.ts'
import type { Bot, BotStatus, UpdateBotInput } from '../../contract/src/index.ts'
import { StoreError } from './errors.ts'
import { asInteger, asNonEmptyString, asRecord, assertOpen, errorMessage, toNumber } from './internal.ts'
import { newRoostId } from './ids.ts'
import { detachBotFromRooms } from './room-members.ts'
import type { Store } from './types.ts'

export const BOT_STATUSES = ['active', 'paused'] as const
export const BOT_APPROVALS = ['ask', 'edits', 'auto', 'full'] as const

const BOT_COLUMNS =
  'id, workspace_id, name, role, persona, provider, model, avatar_json, skills_json, tools_allow_json, tools_deny_json, approval, memory_scopes_json, status, created_by, created_at'

/** 名字里不允许出现的字符：控制字符、路径分隔符、@（@Name 是房间里的提及语法）。 */
const ILLEGAL_NAME = /[\u0000-\u001f\u007f/\\<>:"|?*@]/
const ILLEGAL_SHORT_TEXT = /[\u0000-\u001f\u007f]/

export interface CreateBotStoreInput {
  workspaceId: string
  name: string
  role?: string
  persona?: string
  provider?: string
  model?: string
  avatar?: Bot['avatar']
  skills?: string[]
  toolsAllow?: string[]
  toolsDeny?: string[]
  approval?: Bot['approval']
  memoryScopes?: string[]
  /** 创建者（用户 id 或 bot id）；写 bot_versions 时作为 actor。 */
  createdBy: string
  createdAt?: number
}

export interface UpdateBotStoreInput {
  botId: string
  /** 改人设时写进 bot_versions 的 actor。 */
  actor: string
  patch: UpdateBotInput
}

export interface BotVersion {
  id: string
  botId: string
  field: string
  value: string
  actor: string
  createdAt: number
}

interface BotRow {
  id: string
  workspace_id: string
  name: string
  role: string
  persona: string
  provider: string
  model: string
  avatar_json: string | null
  skills_json: string
  tools_allow_json: string
  tools_deny_json: string
  approval: string
  memory_scopes_json: string
  status: string
  created_by: string
  created_at: number | bigint
}

export function createBot(store: Store, input: CreateBotStoreInput): Bot {
  assertOpen(store)
  const req = asRecord(input, 'bot', 'INVALID_BOT')
  const workspaceId = asNonEmptyString(req.workspaceId, 'bot.workspaceId', 'INVALID_BOT')
  const name = readBotName(req.name)
  const role = readShortText(req.role, 'bot.role', BOT_LIMITS.roleMax)
  const persona = readPersona(req.persona)
  const provider = readProvider(req.provider)
  const model = readModel(req.model)
  const avatar = readAvatar(req.avatar)
  const skills = readStringList(req.skills, 'bot.skills', [])
  const toolsAllow = readStringList(req.toolsAllow, 'bot.toolsAllow', [])
  const toolsDeny = readStringList(req.toolsDeny, 'bot.toolsDeny', [])
  const approval = readApproval(req.approval, 'ask')
  const memoryScopes = readStringList(req.memoryScopes, 'bot.memoryScopes', ['team'])
  const createdBy = asNonEmptyString(req.createdBy, 'bot.createdBy', 'INVALID_BOT')
  const createdAt =
    req.createdAt === undefined || req.createdAt === null
      ? Date.now()
      : asInteger(req.createdAt, 'bot.createdAt', 0, 'INVALID_BOT')

  const workspace = store.db.prepare('SELECT id FROM workspaces WHERE id = ?').get(workspaceId)
  if (workspace === undefined || workspace === null) {
    throw new StoreError('WORKSPACE_NOT_FOUND', `unknown workspace ${workspaceId}`)
  }

  const id = newRoostId('bot')
  const avatarJson = avatar === undefined ? null : JSON.stringify(avatar)

  store.db.exec('SAVEPOINT roost_create_bot')
  try {
    // 名字锁的第一层：先查一次，给调用方稳定的 BOT_NAME_TAKEN（而不是 SQLite 原文）。
    const taken = store.db.prepare('SELECT id FROM bots WHERE workspace_id = ? AND name = ?').get(workspaceId, name)
    if (taken !== undefined && taken !== null) {
      throw new StoreError('BOT_NAME_TAKEN', `bot name "${name}" is already used in ${workspaceId}`)
    }

    store.db
      .prepare(
        `INSERT INTO bots (${BOT_COLUMNS})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      )
      .run(
        id,
        workspaceId,
        name,
        role,
        persona,
        provider,
        model,
        avatarJson,
        JSON.stringify(skills),
        JSON.stringify(toolsAllow),
        JSON.stringify(toolsDeny),
        approval,
        JSON.stringify(memoryScopes),
        createdBy,
        createdAt,
      )

    if (persona !== '') {
      insertBotVersion(store, { botId: id, field: 'persona', value: persona, actor: createdBy, createdAt })
    }

    store.db.exec('RELEASE roost_create_bot')
  } catch (err) {
    rollback(store, 'roost_create_bot')
    if (err instanceof StoreError) throw err
    const message = errorMessage(err)
    if (message.includes('UNIQUE') || message.includes('bots.workspace_id, bots.name')) {
      // 名字锁的第二层：并发创建时由数据库唯一约束裁决。
      throw new StoreError('BOT_NAME_TAKEN', `bot name "${name}" is already used in ${workspaceId}`, {
        cause: err,
      })
    }
    throw new StoreError('BOT_WRITE_FAILED', `failed to create bot: ${message}`, { cause: err })
  }

  return {
    id,
    workspaceId,
    name,
    role,
    persona,
    provider,
    model,
    ...(avatar === undefined ? {} : { avatar }),
    skills,
    toolsAllow,
    toolsDeny,
    approval,
    memoryScopes,
    status: 'active',
    createdBy,
    createdAt,
  }
}

export function getBot(store: Store, id: string): Bot | null {
  assertOpen(store)
  const botId = asNonEmptyString(id, 'bot.id', 'INVALID_BOT')
  const row = store.db.prepare(`SELECT ${BOT_COLUMNS} FROM bots WHERE id = ?`).get(botId)
  return row === undefined || row === null ? null : rowToBot(row)
}

export function listBots(store: Store, workspaceId: string): Bot[] {
  assertOpen(store)
  const id = asNonEmptyString(workspaceId, 'bot.workspaceId', 'INVALID_BOT')
  const rows = store.db
    .prepare(`SELECT ${BOT_COLUMNS} FROM bots WHERE workspace_id = ? ORDER BY created_at, rowid`)
    .all(id)
  return rows.map((row) => rowToBot(row))
}

export function updateBot(store: Store, input: UpdateBotStoreInput): Bot {
  assertOpen(store)
  const req = asRecord(input, 'bot.update', 'INVALID_BOT')
  const botId = asNonEmptyString(req.botId, 'bot.id', 'INVALID_BOT')
  const actor = asNonEmptyString(req.actor, 'bot.actor', 'INVALID_BOT')
  const patch = asRecord(req.patch, 'bot.patch', 'INVALID_BOT')

  const current = getBotRow(store, botId)
  if (current === null) throw new StoreError('BOT_NOT_FOUND', `unknown bot ${botId}`)

  const name = patch.name === undefined ? current.name : readBotName(patch.name)
  const role = patch.role === undefined ? current.role : readShortText(patch.role, 'bot.role', BOT_LIMITS.roleMax)
  const persona = patch.persona === undefined ? current.persona : readPersona(patch.persona)
  const model = patch.model === undefined ? current.model : readModel(patch.model)
  const avatarJson =
    patch.avatar === undefined
      ? current.avatar_json
      : patch.avatar === null
        ? null
        : JSON.stringify(readAvatar(patch.avatar) ?? {})
  const skills =
    patch.skills === undefined ? parseStringArray(current.skills_json) : readStringList(patch.skills, 'bot.skills', [])
  const toolsAllow =
    patch.toolsAllow === undefined
      ? parseStringArray(current.tools_allow_json)
      : readStringList(patch.toolsAllow, 'bot.toolsAllow', [])
  const toolsDeny =
    patch.toolsDeny === undefined
      ? parseStringArray(current.tools_deny_json)
      : readStringList(patch.toolsDeny, 'bot.toolsDeny', [])
  const approval =
    patch.approval === undefined ? readApproval(current.approval, 'ask') : readApproval(patch.approval, 'ask')
  const memoryScopes =
    patch.memoryScopes === undefined
      ? parseStringArray(current.memory_scopes_json)
      : readStringList(patch.memoryScopes, 'bot.memoryScopes', [])
  const status = patch.status === undefined ? readStatus(current.status, 'active') : readStatus(patch.status, 'active')

  const personaChanged = patch.persona !== undefined && persona !== current.persona

  store.db.exec('SAVEPOINT roost_update_bot')
  try {
    if (name !== current.name) {
      const taken = store.db
        .prepare('SELECT id FROM bots WHERE workspace_id = ? AND name = ? AND id <> ?')
        .get(current.workspace_id, name, botId)
      if (taken !== undefined && taken !== null) {
        throw new StoreError('BOT_NAME_TAKEN', `bot name "${name}" is already used in ${current.workspace_id}`)
      }
    }

    store.db
      .prepare(
        `UPDATE bots
            SET name = ?, role = ?, persona = ?, model = ?, avatar_json = ?,
                skills_json = ?, tools_allow_json = ?, tools_deny_json = ?,
                approval = ?, memory_scopes_json = ?, status = ?
          WHERE id = ?`,
      )
      .run(
        name,
        role,
        persona,
        model,
        avatarJson,
        JSON.stringify(skills),
        JSON.stringify(toolsAllow),
        JSON.stringify(toolsDeny),
        approval,
        JSON.stringify(memoryScopes),
        status,
        botId,
      )

    if (personaChanged) {
      insertBotVersion(store, { botId, field: 'persona', value: persona, actor, createdAt: Date.now() })
    }

    store.db.exec('RELEASE roost_update_bot')
  } catch (err) {
    rollback(store, 'roost_update_bot')
    if (err instanceof StoreError) throw err
    const message = errorMessage(err)
    if (message.includes('UNIQUE')) {
      throw new StoreError('BOT_NAME_TAKEN', `bot name "${name}" is already used in ${current.workspace_id}`, {
        cause: err,
      })
    }
    throw new StoreError('BOT_WRITE_FAILED', `failed to update bot ${botId}: ${message}`, { cause: err })
  }

  const updated = getBot(store, botId)
  if (updated === null) throw new StoreError('BOT_NOT_FOUND', `unknown bot ${botId}`)
  return updated
}

/**
 * 硬删（见文件头）：bots 行、bot_versions、所有房间成员关系一起去掉。
 * 若它是某个房间的 host，房间会自动把 host 让给下一个成员（或清空）。
 */
export function deleteBot(store: Store, botId: string): void {
  assertOpen(store)
  const id = asNonEmptyString(botId, 'bot.id', 'INVALID_BOT')
  const row = getBotRow(store, id)
  if (row === null) throw new StoreError('BOT_NOT_FOUND', `unknown bot ${id}`)

  store.db.exec('SAVEPOINT roost_delete_bot')
  try {
    detachBotFromRooms(store, id)
    store.db.prepare('DELETE FROM bot_versions WHERE bot_id = ?').run(id)
    store.db.prepare('DELETE FROM bots WHERE id = ?').run(id)
    store.db.exec('RELEASE roost_delete_bot')
  } catch (err) {
    rollback(store, 'roost_delete_bot')
    if (err instanceof StoreError) throw err
    throw new StoreError('BOT_WRITE_FAILED', `failed to delete bot ${id}: ${errorMessage(err)}`, {
      cause: err,
    })
  }
}

/** 版本历史按写入时间升序（人设回滚/审计用）。 */
export function listBotVersions(store: Store, botId: string): BotVersion[] {
  assertOpen(store)
  const id = asNonEmptyString(botId, 'bot.id', 'INVALID_BOT')
  const rows = store.db
    .prepare('SELECT id, bot_id, field, value, actor, created_at FROM bot_versions WHERE bot_id = ? ORDER BY created_at, id')
    .all(id) as Array<{
    id: string
    bot_id: string
    field: string
    value: string
    actor: string
    created_at: number | bigint
  }>
  return rows.map((row) => ({
    id: row.id,
    botId: row.bot_id,
    field: row.field,
    value: row.value,
    actor: row.actor,
    createdAt: toNumber(row.created_at),
  }))
}

// ---- 内部 --------------------------------------------------------------------

function insertBotVersion(
  store: Store,
  input: { botId: string; field: string; value: string; actor: string; createdAt: number },
): void {
  store.db
    .prepare('INSERT INTO bot_versions (id, bot_id, field, value, actor, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(newRoostId('bv'), input.botId, input.field, input.value, input.actor, input.createdAt)
}

function getBotRow(store: Store, botId: string): BotRow | null {
  const row = store.db.prepare(`SELECT ${BOT_COLUMNS} FROM bots WHERE id = ?`).get(botId)
  return row === undefined || row === null ? null : (row as BotRow)
}

function readBotName(value: unknown): string {
  if (typeof value !== 'string') throw new StoreError('INVALID_BOT', 'bot.name must be a string')
  const name = value.trim()
  if (name === '') throw new StoreError('INVALID_BOT', 'bot.name must not be empty')
  if (name.length > BOT_LIMITS.nameMax) {
    throw new StoreError('INVALID_BOT', `bot.name must be at most ${BOT_LIMITS.nameMax} characters`)
  }
  if (ILLEGAL_NAME.test(name)) {
    throw new StoreError('INVALID_BOT', 'bot.name contains characters that are not allowed (@ / \\ <> : " | ? *)')
  }
  return name
}

function readShortText(value: unknown, label: string, max: number): string {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw new StoreError('INVALID_BOT', `${label} must be a string`)
  const text = value.trim()
  if (text.length > max) throw new StoreError('INVALID_BOT', `${label} must be at most ${max} characters`)
  if (ILLEGAL_SHORT_TEXT.test(text)) throw new StoreError('INVALID_BOT', `${label} contains control characters`)
  return text
}

function readPersona(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw new StoreError('INVALID_BOT', 'bot.persona must be a string')
  const text = value.trim()
  if (text.length > BOT_LIMITS.personaMax) {
    throw new StoreError('INVALID_BOT', `bot.persona must be at most ${BOT_LIMITS.personaMax} characters`)
  }
  return text
}

function readModel(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new StoreError('BOT_NO_MODEL', 'bot.model is required at creation time (bots.md §2)')
  }
  const model = value.trim()
  if (model.length > 200) throw new StoreError('INVALID_BOT', 'bot.model must be at most 200 characters')
  return model
}

function readProvider(value: unknown): string {
  if (value === undefined || value === null) return 'deepseek-official'
  if (typeof value !== 'string' || value.trim() === '') {
    throw new StoreError('INVALID_BOT', 'bot.provider must be a non-empty string')
  }
  const provider = value.trim()
  if (provider.length > 120) throw new StoreError('INVALID_BOT', 'bot.provider must be at most 120 characters')
  return provider
}

function readApproval(value: unknown, fallback: Bot['approval']): Bot['approval'] {
  if (value === undefined || value === null) return fallback
  if (value === 'ask' || value === 'edits' || value === 'auto' || value === 'full') return value
  throw new StoreError('INVALID_BOT', 'bot.approval must be ask|edits|auto|full')
}

function readStatus(value: unknown, fallback: BotStatus): BotStatus {
  if (value === undefined || value === null) return fallback
  if (value === 'active' || value === 'paused') return value
  throw new StoreError('INVALID_BOT', 'bot.status must be active|paused')
}

function readStringList(value: unknown, label: string, fallback: string[]): string[] {
  if (value === undefined || value === null) return fallback
  if (!Array.isArray(value)) throw new StoreError('INVALID_BOT', `${label} must be an array of strings`)
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new StoreError('INVALID_BOT', `${label} must contain non-empty strings`)
    }
    const text = item.trim()
    if (text.length > 200) throw new StoreError('INVALID_BOT', `${label} entries must be at most 200 characters`)
    if (!out.includes(text)) out.push(text)
  }
  return out
}

function readAvatar(value: unknown): Bot['avatar'] | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new StoreError('INVALID_BOT', 'bot.avatar must be an object')
  }
  const input = value as Record<string, unknown>
  const avatar: Record<string, string> = {}
  for (const key of Object.keys(input)) {
    if (key !== 'shape' && key !== 'color' && key !== 'image') {
      throw new StoreError('INVALID_BOT', `bot.avatar has unknown field ${key}`)
    }
    const raw = input[key]
    if (raw === undefined) continue
    if (typeof raw !== 'string' || raw.trim() === '') {
      throw new StoreError('INVALID_BOT', `bot.avatar.${key} must be a non-empty string`)
    }
    const text = raw.trim()
    // shape/color 是程序化图标参数；image 是 ≤256KB 图片的 dataURL（base64 后约 350k 字符）。
    const limit = key === 'image' ? 512_000 : 512
    if (text.length > limit) throw new StoreError('INVALID_BOT', `bot.avatar.${key} is too long`)
    if (key === 'image' && !/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(text)) {
      throw new StoreError('INVALID_BOT', 'bot.avatar.image must be a base64 data URL (png/jpeg/webp/gif)')
    }
    avatar[key] = text
  }
  return avatar
}

function parseStringArray(raw: unknown): string[] {
  if (typeof raw !== 'string') return []
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

function parseAvatar(raw: unknown): Bot['avatar'] | undefined {
  if (typeof raw !== 'string' || raw === '') return undefined
  try {
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
    const avatar: Record<string, string> = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string') avatar[key] = value
    }
    return avatar
  } catch {
    return undefined
  }
}

function rowToBot(row: unknown): Bot {
  const r = row as BotRow
  const avatar = parseAvatar(r.avatar_json)
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    name: r.name,
    role: r.role,
    persona: r.persona,
    provider: r.provider,
    model: r.model,
    ...(avatar === undefined ? {} : { avatar }),
    skills: parseStringArray(r.skills_json),
    toolsAllow: parseStringArray(r.tools_allow_json),
    toolsDeny: parseStringArray(r.tools_deny_json),
    approval: (r.approval as Bot['approval']) ?? 'ask',
    memoryScopes: parseStringArray(r.memory_scopes_json),
    status: (r.status as BotStatus) ?? 'active',
    createdBy: r.created_by,
    createdAt: toNumber(r.created_at),
  }
}

function rollback(store: Store, savepoint: string): void {
  try {
    store.db.exec(`ROLLBACK TO ${savepoint}`)
    store.db.exec(`RELEASE ${savepoint}`)
  } catch {
    // 外层事务可能已经把 savepoint 一起回滚；保留原始错误。
  }
}
