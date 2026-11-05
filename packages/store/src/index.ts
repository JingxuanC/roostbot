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

// ---- M5：workspace 成员与角色 ------------------------------------------------
export {
  MEMBER_ERROR_CODES,
  WORKSPACE_ROLES,
  getWorkspaceMember,
  getWorkspaceRole,
  listWorkspaceMembers,
  removeWorkspaceMember,
  setWorkspaceMemberRole,
} from './members.ts'
export type {
  RemoveWorkspaceMemberInput,
  SetWorkspaceMemberRoleInput,
  WorkspaceMember,
  WorkspaceRole,
} from './members.ts'

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

// ---- 每 workspace 短期 runtime token（ADR 0005 / TODO E6）---------------------
export {
  RUNTIME_TOKEN_BYTES,
  hashRuntimeToken,
  issueRuntimeToken,
  revokeRuntimeToken,
  revokeRuntimeTokens,
  verifyRuntimeToken,
} from './runtime-tokens.ts'
export type {
  IssueRuntimeTokenInput,
  IssuedRuntimeToken,
  RevokeRuntimeTokenInput,
  RevokeRuntimeTokensInput,
  RevokeRuntimeTokensResult,
  RevokedRuntimeToken,
  RuntimeTokenVerification,
  VerifyRuntimeTokenInput,
} from './runtime-tokens.ts'

// ---- M6：控制面调度（schedule / activation / run / run_event）----------------
export {
  MAX_CATCH_UP_PER_TICK,
  SCHEDULE_ERROR_CODES,
  SCHEDULE_OVERLAPS,
  createSchedule,
  deleteSchedule,
  getRun,
  getSchedule,
  listRuns,
  listSchedules,
  manualActivation,
  stopRun,
  tick,
  updateSchedule,
} from './schedules.ts'
export type {
  CreateScheduleInput,
  ListRunsQuery,
  ListSchedulesQuery,
  ManualActivationInput,
  ManualActivationResult,
  Schedule,
  ScheduleOverlap,
  ScheduledRun,
  StopRunInput,
  TickInput,
  TickResult,
  UpdateScheduleInput,
} from './schedules.ts'
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

// ---- M6：附件与产物 -----------------------------------------------------------
export {
  ARTIFACT_KINDS,
  ATTACHMENT_RETENTION_MS,
  addAttachmentRef,
  deleteAttachmentRows,
  getArtifact,
  getAttachment,
  linkArtifact,
  listArtifactsByMessage,
  listCollectableAttachments,
  listMessageAttachments,
  putArtifact,
  putAttachment,
  recordAttachmentGc,
  removeAttachmentRef,
  unlinkArtifact,
} from './attachments.ts'
export type {
  Artifact,
  ArtifactKind,
  Attachment,
  MessageAttachment,
  PutArtifactInput,
  PutAttachmentInput,
} from './attachments.ts'

// ---- M6：预算（配额 / 预留-结算 / 用量）--------------------------------------
export {
  BUDGET_ERROR_CODES,
  QUOTA_METRICS,
  QUOTA_PERIODS,
  QUOTA_SCOPES,
  SOFT_LIMIT_RATIO,
  ensureQuota,
  findExhaustedWorkspaceQuota,
  getQuota,
  getReservation,
  isSoftLimitReached,
  listQuotas,
  periodEnd,
  quotaRatio,
  recordUsage,
  reserve,
  setQuotaLimit,
  settle,
  sumUsage,
} from './budget.ts'
export type {
  EnsureQuotaInput,
  ListQuotasQuery,
  Quota,
  QuotaMetric,
  QuotaPeriod,
  QuotaScope,
  RecordUsageInput,
  Reservation,
  ReserveInput,
  ReserveResult,
  SettleInput,
  SettleResult,
  UsageGroup,
  UsageRow,
  UsageSummary,
  UsageTotals,
} from './budget.ts'

// ---- M6：记忆（判断 / 证据 / 检索）-------------------------------------------
export {
  MEMORY_CLAIM_MAX,
  MEMORY_DAILY_LIMIT,
  MEMORY_DEFAULT_BUDGET_TOKENS,
  MEMORY_DEFAULT_LIMIT,
  MEMORY_DISPLAY_MAX,
  MEMORY_ERROR_CODES,
  MEMORY_EVIDENCE_KINDS,
  MEMORY_FRESHNESS_HALF_LIFE_DAYS,
  MEMORY_KINDS,
  MEMORY_STATUSES,
  MEMORY_SUBJECT_MAX,
  deleteMemory,
  exportMemories,
  getMemory,
  listMemories,
  recordReads,
  retrieve,
  writeMemory,
} from './memories.ts'
export type {
  DeleteMemoryInput,
  ListMemoriesQuery,
  Memory,
  MemoryEvidence,
  MemoryEvidenceKind,
  MemoryKind,
  MemoryStatus,
  RecordMemoryReadsInput,
  RetrieveQuery,
  RetrieveResult,
  RetrievedMemory,
  WriteMemoryInput,
} from './memories.ts'

// ---- M5：插件市场 -------------------------------------------------------------
export {
  MARKETPLACE_ERROR_CODES,
  PLUGIN_INSTALL_STATES,
  PLUGIN_SLUG_MAX,
  PLUGIN_SLUG_PATTERN,
  PLUGIN_TIERS,
  createInstall,
  deleteInstall,
  getInstall,
  getMarketPlugin,
  getPublisher,
  isPluginSlug,
  listInstalls,
  listMarketPlugins,
  listPublishers,
  listVersions,
  updateInstall,
  upsertMarketPlugin,
  upsertPublisher,
  upsertVersion,
} from './marketplace.ts'
export type {
  CreateInstallInput,
  DeleteInstallInput,
  ListMarketPluginsQuery,
  MarketPlugin,
  PluginInstall,
  PluginInstallState,
  PluginPublisher,
  PluginTier,
  PluginVersion,
  UpdateInstallInput,
  UpsertMarketPluginInput,
  UpsertPublisherInput,
  UpsertVersionInput,
} from './marketplace.ts'

// ---- M6：连接器控制面（连接 / 按 Bot 授权 / 调用审计）------------------------
export {
  CONNECTOR_ACCESS,
  CONNECTOR_BACKENDS,
  CONNECTOR_ERROR_CODES,
  CONNECTOR_SLUG_MAX,
  CONNECTOR_SLUG_PATTERN,
  CONNECTOR_STATUSES,
  deleteConnection,
  findCallByIdem,
  findGrant,
  getConnection,
  isConnectorSlug,
  listConnections,
  listGrants,
  recordCall,
  setGrant,
  upsertConnection,
} from './connectors.ts'
export type {
  Connection,
  ConnectorAccessLevel,
  ConnectorBackendName,
  ConnectorCallRow,
  ConnectorConnectionStatus,
  ConnectorGrantRow,
  DeleteConnectionInput,
  RecordCallInput,
  RecordCallResult,
  SetGrantInput,
  UpsertConnectionInput,
} from './connectors.ts'

export {
  deleteWorkspaceModelCredential,
  getWorkspaceModelCredential,
  saveWorkspaceModelCredential,
} from './model-credentials.ts'
export type {
  SaveModelCredentialInput,
  WorkspaceModelCredential,
} from './model-credentials.ts'
export {
  SIGNUP_CREDIT_TOKENS,
  SIGNUP_CREDIT_TTL_MS,
  consumeTokenCredit,
  getTokenCreditBalance,
  grantTokenCredit,
} from './token-credits.ts'
export type {
  ConsumeTokenCreditInput,
  ConsumeTokenCreditResult,
  GrantTokenCreditInput,
  TokenCreditBalance,
  TokenGrant,
} from './token-credits.ts'
