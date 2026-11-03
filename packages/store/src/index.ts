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
