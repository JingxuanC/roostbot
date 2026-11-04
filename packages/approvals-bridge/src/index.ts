// 审批桥（docs/build/wave3.md §A）。
//
//   控制面（roostbot API）  ◀── HTTP ──  DSH 插件（本包 + 一个 answerer）
//   approvals 表 / 用户卡片             ctx.on('approval/request', …)
//
// 三个文件各管一件事：
//   contract.ts  词汇、校验、DSH 结果词映射（无状态）
//   bridge.ts    pending → approved | rejected | timeout 状态机（幂等、并发、超时）
//   dsh.ts       DSH 适配器 + 源码事实（describeDshApprovalSurface）
//
// 零依赖：不 import DSH、不 import 控制面、不碰网络。`request` / `wait`
// 由调用方注入，所以整个包在 node:test 里没有 IO 也能跑。

export {
  BRIDGE_DECISIONS,
  BRIDGE_FAILURES,
  BRIDGE_STATES,
  BridgeError,
  DECISION_ACTORS,
  DSH_APPROVAL_OUTCOMES,
  REQUEST_CONSEQUENCE_MAX,
  REQUEST_ID_MAX,
  REQUEST_SCOPE_MAX,
  REQUEST_SUMMARY_MAX,
  REQUEST_TOOL_MAX,
  isBridgeDecision,
  isTerminal,
  readApprovalRequest,
  toDshOutcome,
} from './contract.ts'
export type {
  ApprovalRequest,
  BridgeDecision,
  BridgeErrorCode,
  BridgeFailure,
  BridgeOutcome,
  BridgeState,
  DecisionActor,
  DshApprovalOutcome,
  ReadApprovalRequest,
  RequestFieldError,
} from './contract.ts'

export { createApprovalBridge } from './bridge.ts'
export type {
  ApprovalBridge,
  ApprovalBridgeOptions,
  CreateRemoteApproval,
  SettleOptions,
  WaitInput,
  WaitRemoteDecision,
} from './bridge.ts'

export {
  DSH_APPROVAL_VERSION,
  defaultRequestId,
  describeDshApprovalSurface,
  describeDshRequest,
  installApprovalBridge,
} from './dsh.ts'
export type {
  BridgeScope,
  DshAnswerer,
  DshApprovalContext,
  DshApprovalFinding,
  DshApprovalRequestEvent,
  DshApprovalSurface,
  DshNextAnswerer,
  InstallApprovalBridgeHandle,
  InstallApprovalBridgeOptions,
} from './dsh.ts'
