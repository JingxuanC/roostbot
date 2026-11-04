// @roost/store — workspace 卷的 SQLite 存储层（零依赖，node:sqlite）。
//
// 事实源：docs/design/events.md（信封与只追加日志）、docs/design/workspace.md（workspaces）、
// docs/design/auth.md（devices / sessions / pairing_codes）。

export { StoreError, isStoreError, STORE_ERROR_CODES } from './errors.ts'
export type { StoreErrorCode } from './errors.ts'

export { newEventId, newWorkspaceId } from './ids.ts'

export { openStore } from './store.ts'

export { appendEvent, readEvents, latestSeq } from './events.ts'

export { claimPairingCode, createPairingCode, PAIRING_MAX_ATTEMPTS } from './pairing.ts'

export {
  createWorkspace,
  HOME_MODES,
  listWorkspaces,
  WORKSPACE_STATES,
} from './workspaces.ts'

export { applyMigrations, discoverMigrations } from './migrations.ts'

export type {
  Actor,
  ClaimPairingInput,
  CreatePairingCodeInput,
  CreateWorkspaceInput,
  Database,
  Event,
  HomeMode,
  NewEvent,
  PairingClaim,
  PairingCode,
  ReadEventsQuery,
  Statement,
  Store,
  StoreOptions,
  Subject,
  Workspace,
  WorkspaceState,
} from './types.ts'

export {
  createSession,
  findSessionById,
  findSessionByTokenHash,
  revokeSession,
  touchSession,
} from './sessions.ts'
export type { CreateSessionInput, Session } from './types.ts'

export { createRoom, getRoom, listRooms, readMessages, sendMessage, REPLY_MODES } from './rooms.ts'
export type { Room, RoomMessage, SendMessageInput } from './types.ts'
export { deleteRoom, readRoomLogPage } from './rooms.ts'
export type { RoomLogPage } from './rooms.ts'

// ---- M4：Bot 域 ---------------------------------------------------------------
export {
  BOT_APPROVALS,
  BOT_SOFT_DELETE_WINDOW_MS,
  BOT_STATUSES,
  createBot,
  deleteBot,
  getBot,
  listBots,
  listBotVersions,
  restoreBot,
  updateBot,
} from './bots.ts'
export type { BotLifecycleOptions, BotVersion, CreateBotStoreInput, UpdateBotStoreInput } from './bots.ts'

// ---- M4：房间成员与扩展列 ------------------------------------------------------
export {
  addRoomMembers,
  detachBotFromRooms,
  listRoomMembers,
  removeRoomMember,
  setRoomHost,
} from './room-members.ts'
export type { AddRoomMembersInput, RemoveRoomMemberInput } from './room-members.ts'

export {
  createRoomExt,
  getRoomDetail,
  getRoomExtras,
  updateRoomExtras,
} from './rooms-ext.ts'
export type {
  CreateRoomExtInput,
  RoomDetail,
  RoomExtras,
  UpdateRoomExtrasInput,
} from './rooms-ext.ts'

export {
  activeRound,
  botSession,
  getRound,
  latestRound,
  listRounds,
  markSeen,
  saveRound,
  seenSeq,
  setBotSession,
} from './rounds.ts'

export { getWorkspaceRuntime, saveWorkspaceRuntime } from './workspace-runtime.ts'
export type { RuntimePhase, WorkspaceRuntime } from './workspace-runtime.ts'

export { createDmRoom, findDmRoom } from './dm.ts'
export type { CreateDmRoomInput, DmRoom } from './dm.ts'

export {
  APPROVAL_ERROR_CODES,
  APPROVAL_STATUSES,
  createApproval,
  decideApproval,
  getApproval,
  hasPendingApproval,
  listApprovals,
  storeErrorTag,
} from './approvals.ts'
export type { Approval, ApprovalStatus, DecideApprovalInput } from './approvals.ts'

export {
  BOT_ROOM_APPROVAL_KIND,
  BOT_ROOM_DAILY_LIMIT,
  approveBotRoom,
  countBotRoomsToday,
  rejectBotRoom,
  requestBotRoom,
  startOfLocalDay,
} from './bot-rooms.ts'
