// Bot manifest v1 的类型与运行时常量。事实源：bot.schema.json + docs/design/bots.md。
// 只用可擦除 TS 语法；相对导入必须带 .ts 扩展名。

export const MANIFEST_SCHEMA = 'roostbot.bot/v1' as const

export const MODEL_TIERS = ['fast', 'standard', 'deep'] as const
export type ModelTier = (typeof MODEL_TIERS)[number]

export const APPROVAL_KINDS = [
  'write_outside_workspace',
  'network_egress',
  'spend',
  'install_plugin',
  'read_secret',
] as const
export type ApprovalKind = (typeof APPROVAL_KINDS)[number]

export const MEMORY_SCOPES = ['team', 'room', 'member'] as const
export type MemoryScope = (typeof MEMORY_SCOPES)[number]

export interface BotModel {
  tier?: ModelTier
  /** 凭据 provider 的名字，绝不写 token 本身。 */
  providerRef?: string
}

export interface BotTools {
  /** 能力白名单；没写就是不能用。 */
  allow?: string[]
  deny?: string[]
}

export interface BotMemory {
  enabled?: boolean
  scopes?: MemoryScope[]
  retentionDays?: number
}

export interface BotSchedule {
  cron?: string
  timezone?: string
  /** 起模型前先跑的纯代码检查；空转不花钱。 */
  checks?: string[]
}

/**
 * Bot 自带的面板声明。形状与控制面从插件 manifest 读到的面板一致
 * （apps/api 的 `readPanelDeclaration`）：name 必填，其余可选。
 */
export interface BotPanel {
  name: string
  title?: string
  slot?: string
  path?: string
}

/** 一个 Bot 的完整声明；运行时按 manifest 装载。 */
export interface BotManifest {
  schema: typeof MANIFEST_SCHEMA
  /** 小写字母开头，允许小写字母/数字/连字符，2–41 字符。 */
  id: string
  name: string
  role: string
  description?: string
  /** Markdown 正文或技能路径。 */
  instructions: string
  color?: string
  model?: BotModel
  tools?: BotTools
  skills?: string[]
  panels?: BotPanel[]
  approvals?: ApprovalKind[]
  memory?: BotMemory
  schedule?: BotSchedule
}
