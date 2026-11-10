// Bot 域（docs/design/bots.md、docs/build/m4-contract.md §1/§2）。
//
// 三条硬规则：
//   1. 名字锁：校验 → 查重 → INSERT 全在一个 savepoint 里；UNIQUE(workspace_id,name)
//      是最后一道锁（多进程并发也只可能有一个赢家）。重名抛 BOT_NAME_TAKEN。
//   2. 模型创建时固定：createBot 不接受空 model（BOT_NO_MODEL）；之后全局默认变了不影响它。
//      PATCH 仍可显式改 model（bots.md §4 的「模型」设置项）。
//   3. 人设版本化：persona 变化时写 bot_versions（field='persona'），历史只追加。
//
// 删除（bots.md §5，0010 起）：软删。deleteBot 只写 bots.deleted_at（epoch 毫秒），
// 同时按 bots.md §8 待决 3 的倾向把 Bot 退出所有房间（room_members，含 DM），
// 每个房间写一条 bot.removed_from_room 事件，再写一条 workspace 级的 bot.deleted。
// 软删期间该行仍占住 (workspace_id, name) 唯一约束：名字不可复用，
// 7 天内 restoreBot 可完整恢复身份（房间成员关系不自动恢复）。
// 超过 BOT_SOFT_DELETE_WINDOW_MS（7 天）恢复抛 BOT_RESTORE_EXPIRED。
// getBot/listBots 默认看不到已软删的 Bot；需要时传 includeDeleted。
//
// 生命周期事件（bots.md §4/§8）：bot.created / bot.updated / bot.deleted / bot.restored
// 写进同一份 events 日志（events.md §2），domain='bot'。bot.created/updated/deleted/restored
// 是 workspace 级事实，audience='team'；bot.removed_from_room 属于那个房间，audience='room:<id>'。

import { BOT_LIMITS } from '../../contract/src/index.ts'
import type { Bot, BotStatus, UpdateBotInput } from '../../contract/src/index.ts'
import { AGENT_RUNTIME_KINDS, isAgentRuntimeKind } from '../../agent-runtime/src/index.ts'
import type { AgentRuntimeKind } from '../../agent-runtime/src/index.ts'
import { StoreError } from './errors.ts'
import { appendEvent } from './events.ts'
import { asInteger, asNonEmptyString, asRecord, assertOpen, errorMessage, toNumber } from './internal.ts'
import { newRoostId } from './ids.ts'
import { detachBotFromRooms } from './room-members.ts'
import type { Store } from './types.ts'

export const BOT_STATUSES = ['active', 'paused'] as const
export const BOT_APPROVALS = ['ask', 'edits', 'auto', 'full'] as const

/** 软删恢复窗口：7 天（bots.md §5「软删 7 天可恢复」）。 */
export const BOT_SOFT_DELETE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

const BOT_COLUMNS =
  'id, workspace_id, name, role, persona, provider, model, avatar_json, skills_json, tools_allow_json, tools_deny_json, approval, memory_scopes_json, status, runtime_kind, runtime_config, credential_ref, capabilities, created_by, created_at, deleted_at'

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
  /** 缺省 dsh。只接受 AgentRuntimeKind；非法值抛 INVALID_BOT。 */
  runtimeKind?: AgentRuntimeKind
  runtimeConfig?: Record<string, unknown> | null
  credentialRef?: string | null
  capabilities?: Record<string, unknown> | null
  /** 创建者（用户 id 或 bot id）；写 bot_versions 与 bot.created 事件时作为 actor。 */
  createdBy: string
  createdAt?: number
}

export interface UpdateBotStoreInput {
  botId: string
  /** 改人设时写进 bot_versions、写 bot.updated 事件时的 actor。 */
  actor: string
  patch: UpdateBotInput
}

/** deleteBot / restoreBot 的可选项：actor 写进事件，now 供测试注入时钟。 */
export interface BotLifecycleOptions {
  actor?: string
  now?: number
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
  runtime_kind: string | null
  runtime_config: string | null
  credential_ref: string | null
  capabilities: string | null
  created_by: string
  created_at: number | bigint
  deleted_at: number | bigint | null
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
  const runtimeKind = readRuntimeKind(req.runtimeKind, 'dsh')
  const runtimeConfigJson = readRuntimeConfig(req.runtimeConfig, 'bot.runtimeConfig')
  const credentialRef = readCredentialRef(req.credentialRef, 'bot.credentialRef')
  const capabilitiesJson = readCapabilities(req.capabilities, 'bot.capabilities')
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
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, NULL)`,
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
        runtimeKind,
        runtimeConfigJson,
        credentialRef,
        capabilitiesJson,
        createdBy,
        createdAt,
      )

    if (persona !== '') {
      insertBotVersion(store, { botId: id, field: 'persona', value: persona, actor: createdBy, createdAt })
    }

    appendBotEvent(store, {
      kind: 'bot.created',
      actor: createdBy,
      botId: id,
      audience: 'team',
      idem: `bot:${id}:created`,
      payload: { workspaceId, name, model, provider },
    })

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
    runtimeKind,
    ...(runtimeConfigJson === null ? {} : { runtimeConfig: parseJsonObject(runtimeConfigJson) }),
    ...(credentialRef === null ? {} : { credentialRef }),
    ...(capabilitiesJson === null ? {} : { capabilities: parseJsonObject(capabilitiesJson) as Bot['capabilities'] }),
    createdBy,
    createdAt,
  }
}

/** 默认看不到已软删的 Bot（返回 null）；includeDeleted 时连 tombstone 一起读。 */
export function getBot(store: Store, id: string, opts: { includeDeleted?: boolean } = {}): Bot | null {
  assertOpen(store)
  const botId = asNonEmptyString(id, 'bot.id', 'INVALID_BOT')
  const row = store.db.prepare(`SELECT ${BOT_COLUMNS} FROM bots WHERE id = ?`).get(botId)
  if (row === undefined || row === null) return null
  if (opts.includeDeleted !== true && (row as BotRow).deleted_at !== null) return null
  return rowToBot(row)
}

/** 默认不含已软删的 Bot；includeDeleted 时一并返回（带 deletedAt）。 */
export function listBots(store: Store, workspaceId: string, opts: { includeDeleted?: boolean } = {}): Bot[] {
  assertOpen(store)
  const id = asNonEmptyString(workspaceId, 'bot.workspaceId', 'INVALID_BOT')
  const rows = store.db
    .prepare(
      `SELECT ${BOT_COLUMNS} FROM bots WHERE workspace_id = ?${opts.includeDeleted === true ? '' : ' AND deleted_at IS NULL'} ORDER BY created_at, rowid`,
    )
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
  if (current === null || current.deleted_at !== null) throw new StoreError('BOT_NOT_FOUND', `unknown bot ${botId}`)

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
  const runtimeKind =
    patch.runtimeKind === undefined ? readRuntimeKind(current.runtime_kind, 'dsh') : readRuntimeKind(patch.runtimeKind)
  const runtimeConfigJson =
    patch.runtimeConfig === undefined ? current.runtime_config : readRuntimeConfig(patch.runtimeConfig, 'bot.runtimeConfig')
  const credentialRef =
    patch.credentialRef === undefined ? current.credential_ref : readCredentialRef(patch.credentialRef, 'bot.credentialRef')
  const capabilitiesJson =
    patch.capabilities === undefined ? current.capabilities : readCapabilities(patch.capabilities, 'bot.capabilities')

  const personaChanged = patch.persona !== undefined && persona !== current.persona

  // bot.updated 事件的 changed 列表：只记真正变了的字段，同值 PATCH 不写事件。
  // JSON 字段与 current.*_json 直接按字符串比较：写入侧统一用 JSON.stringify，
  // 与读出的存储格式一致；若将来引入其它写入路径，这里要改成规范化比较。
  const changed: string[] = []
  if (name !== current.name) changed.push('name')
  if (role !== current.role) changed.push('role')
  if (personaChanged) changed.push('persona')
  if (model !== current.model) changed.push('model')
  if (avatarJson !== current.avatar_json) changed.push('avatar')
  if (JSON.stringify(skills) !== current.skills_json) changed.push('skills')
  if (JSON.stringify(toolsAllow) !== current.tools_allow_json) changed.push('toolsAllow')
  if (JSON.stringify(toolsDeny) !== current.tools_deny_json) changed.push('toolsDeny')
  if (approval !== current.approval) changed.push('approval')
  if (JSON.stringify(memoryScopes) !== current.memory_scopes_json) changed.push('memoryScopes')
  if (status !== current.status) changed.push('status')
  if (runtimeKind !== (current.runtime_kind ?? 'dsh')) changed.push('runtimeKind')
  if (runtimeConfigJson !== current.runtime_config) changed.push('runtimeConfig')
  if (credentialRef !== current.credential_ref) changed.push('credentialRef')
  if (capabilitiesJson !== current.capabilities) changed.push('capabilities')

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
                approval = ?, memory_scopes_json = ?, status = ?,
                runtime_kind = ?, runtime_config = ?, credential_ref = ?, capabilities = ?
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
        runtimeKind,
        runtimeConfigJson,
        credentialRef,
        capabilitiesJson,
        botId,
      )

    if (personaChanged) {
      insertBotVersion(store, { botId, field: 'persona', value: persona, actor, createdAt: Date.now() })
    }

    if (changed.length > 0) {
      appendBotEvent(store, {
        kind: 'bot.updated',
        actor,
        botId,
        audience: 'team',
        payload: { workspaceId: current.workspace_id, changed },
      })
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
 * 软删（见文件头）：写 bots.deleted_at，把 Bot 退出所有房间（含 DM），
 * 每个房间写 bot.removed_from_room 事件，最后写 workspace 级的 bot.deleted。
 * bots 行与 bot_versions 都保留，7 天内可 restoreBot 恢复。
 * 已软删的 Bot 视为不存在（BOT_NOT_FOUND）；重复删除不会写第二条 bot.deleted。
 */
export function deleteBot(store: Store, botId: string, opts: BotLifecycleOptions = {}): void {
  assertOpen(store)
  const id = asNonEmptyString(botId, 'bot.id', 'INVALID_BOT')
  const row = getBotRow(store, id)
  if (row === null || row.deleted_at !== null) throw new StoreError('BOT_NOT_FOUND', `unknown bot ${id}`)
  const now = readLifecycleNow(opts, 'bot.delete.now')

  store.db.exec('SAVEPOINT roost_delete_bot')
  try {
    const memberships = store.db
      .prepare('SELECT room_id FROM room_members WHERE bot_id = ? AND bot_id IS NOT NULL')
      .all(id) as Array<{ room_id: string }>

    detachBotFromRooms(store, id)
    store.db.prepare('UPDATE bots SET deleted_at = ? WHERE id = ?').run(now, id)

    for (const membership of memberships) {
      appendBotEvent(store, {
        kind: 'bot.removed_from_room',
        actor: opts.actor,
        botId: id,
        audience: `room:${membership.room_id}`,
        idem: `bot:${id}:removed_from_room:${membership.room_id}:${now}`,
        payload: { roomId: membership.room_id, name: row.name },
      })
    }
    appendBotEvent(store, {
      kind: 'bot.deleted',
      actor: opts.actor,
      botId: id,
      audience: 'team',
      idem: `bot:${id}:deleted:${now}`,
      payload: { workspaceId: row.workspace_id, name: row.name, rooms: memberships.map((m) => m.room_id) },
    })

    store.db.exec('RELEASE roost_delete_bot')
  } catch (err) {
    rollback(store, 'roost_delete_bot')
    if (err instanceof StoreError) throw err
    throw new StoreError('BOT_WRITE_FAILED', `failed to delete bot ${id}: ${errorMessage(err)}`, {
      cause: err,
    })
  }
}

/**
 * 恢复软删的 Bot：清掉 deleted_at，写 bot.restored 事件。
 *
 * - Bot 不存在 → BOT_NOT_FOUND；
 * - 没被删过 → 幂等返回当前 Bot，不重复写事件；
 * - 删除超过 BOT_SOFT_DELETE_WINDOW_MS（7 天）→ BOT_RESTORE_EXPIRED；
 * - 房间成员关系不自动恢复（删除时已逐房写 bot.removed_from_room）。
 */
export function restoreBot(store: Store, botId: string, opts: BotLifecycleOptions = {}): Bot {
  assertOpen(store)
  const id = asNonEmptyString(botId, 'bot.id', 'INVALID_BOT')
  const row = getBotRow(store, id)
  if (row === null) throw new StoreError('BOT_NOT_FOUND', `unknown bot ${id}`)
  if (row.deleted_at === null) return rowToBot(row)

  const deletedAt = toNumber(row.deleted_at)
  const now = readLifecycleNow(opts, 'bot.restore.now')
  if (now - deletedAt > BOT_SOFT_DELETE_WINDOW_MS) {
    throw new StoreError(
      'BOT_RESTORE_EXPIRED',
      `bot ${id} was deleted more than 7 days ago and can no longer be restored`,
    )
  }

  store.db.exec('SAVEPOINT roost_restore_bot')
  try {
    store.db.prepare('UPDATE bots SET deleted_at = NULL WHERE id = ?').run(id)
    appendBotEvent(store, {
      kind: 'bot.restored',
      actor: opts.actor,
      botId: id,
      audience: 'team',
      idem: `bot:${id}:restored:${now}`,
      payload: { workspaceId: row.workspace_id, name: row.name },
    })
    store.db.exec('RELEASE roost_restore_bot')
  } catch (err) {
    rollback(store, 'roost_restore_bot')
    if (err instanceof StoreError) throw err
    throw new StoreError('BOT_WRITE_FAILED', `failed to restore bot ${id}: ${errorMessage(err)}`, {
      cause: err,
    })
  }

  const restored = getBot(store, id)
  if (restored === null) throw new StoreError('BOT_NOT_FOUND', `unknown bot ${id}`)
  return restored
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

/**
 * Bot 生命周期事件统一走这里：domain='bot'，subject 是这个 Bot，
 * workspace 级事实 audience='team'，房间级事实 audience='room:<id>'（events.md §3）。
 * actor 缺省为 null（store 层调用方可以给不出操作者；API 路径总是带账号 id）。
 */
function appendBotEvent(
  store: Store,
  input: {
    kind: string
    actor: string | undefined
    botId: string
    audience: string
    idem?: string
    payload: Record<string, unknown>
  },
): void {
  appendEvent(store, {
    domain: 'bot',
    kind: input.kind,
    actor: input.actor === undefined ? null : { kind: 'user', id: input.actor },
    subject: { kind: 'bot', id: input.botId },
    audience: input.audience,
    ...(input.idem === undefined ? {} : { idem: input.idem }),
    payload: input.payload,
  })
}

function readLifecycleNow(opts: BotLifecycleOptions, label: string): number {
  return opts.now === undefined ? Date.now() : asInteger(opts.now, label, 0, 'INVALID_BOT')
}

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

function readRuntimeKind(value: unknown, fallback?: AgentRuntimeKind): AgentRuntimeKind {
  if (value === undefined || value === null) {
    if (fallback !== undefined) return fallback
    throw new StoreError('INVALID_BOT', 'bot.runtimeKind is required')
  }
  if (!isAgentRuntimeKind(value)) {
    throw new StoreError(
      'INVALID_BOT',
      `bot.runtimeKind must be one of ${AGENT_RUNTIME_KINDS.join('|')}`,
    )
  }
  return value
}

/** runtime_config / capabilities 都以 JSON 文本落库；这里负责对象 + 大小校验。 */
function readJsonObject(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new StoreError('INVALID_BOT', `${label} must be a JSON object`)
  }
  let text: string
  try {
    text = JSON.stringify(value)
  } catch (err) {
    throw new StoreError('INVALID_BOT', `${label} must be JSON-serializable`, { cause: err })
  }
  if (text.length > maxBytes) {
    throw new StoreError('INVALID_BOT', `${label} is too large (max ${maxBytes} bytes)`)
  }
  return text
}

function readRuntimeConfig(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null
  return readJsonObject(value, label, 32 * 1024)
}

function readCapabilities(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null
  return readJsonObject(value, label, 64 * 1024)
}

/**
 * credential_ref 是指向 secret provider 的引用，不是密钥本身。
 * 这里只校验形状；API 读取时也只返回引用，不解析 secret。
 */
function readCredentialRef(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw new StoreError('INVALID_BOT', `${label} must be a string`)
  const text = value.trim()
  if (text === '') throw new StoreError('INVALID_BOT', `${label} must not be empty`)
  if (text.length > 500) throw new StoreError('INVALID_BOT', `${label} must be at most 500 characters`)
  if (ILLEGAL_SHORT_TEXT.test(text)) throw new StoreError('INVALID_BOT', `${label} contains control characters`)
  return text
}

function parseJsonObject(raw: unknown): Record<string, unknown> | undefined {
  if (typeof raw !== 'string' || raw === '') return undefined
  try {
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
    return parsed as Record<string, unknown>
  } catch {
    return undefined
  }
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
    runtimeKind: isAgentRuntimeKind(r.runtime_kind) ? r.runtime_kind : 'dsh',
    ...(r.runtime_config === null ? {} : { runtimeConfig: parseJsonObject(r.runtime_config) }),
    ...(r.credential_ref === null ? {} : { credentialRef: r.credential_ref }),
    ...(r.capabilities === null ? {} : { capabilities: parseJsonObject(r.capabilities) as Bot['capabilities'] }),
    createdBy: r.created_by,
    createdAt: toNumber(r.created_at),
    ...(r.deleted_at === null ? {} : { deletedAt: toNumber(r.deleted_at) }),
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
