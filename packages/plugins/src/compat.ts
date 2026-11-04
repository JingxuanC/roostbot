// 插件兼容性分级：A/B/C/D（设计见 docs/design/plugin-marketplace.md §3）。

export type PluginTier = 'A' | 'B' | 'C' | 'D'

/** 插件声明的能力与资源需求；市场详情页与预检都用它。 */
export interface PluginCapabilities {
  tools?: number
  skills?: number
  panels?: number
  /** 需要出网的主机（会生成沙箱策略）。 */
  network?: string[]
  /** 需要的凭据 provider 名（绝不进 env）。 */
  credentials?: string[]
  diskBytes?: number
  /** 需要的可执行文件（python3 等）。 */
  binaries?: string[]
  /** 需要的只读数据面。 */
  dataMounts?: string[]
  /** 是否含 client 半（面板/widget/slot）。 */
  clientHalf?: boolean
  /** 是否依赖桌面环境（本地文件、原生模块、系统集成）。 */
  desktopOnly?: boolean
}

export interface ClassificationContext {
  platform: 'cloud' | 'desktop'
  /** 镜像里已有的可执行文件。 */
  availableBinaries?: string[]
  /** 控制的只读数据面。 */
  availableDataMounts?: string[]
}

export interface Classification {
  tier: PluginTier
  reasons: string[]
  /** B 级需要补的资源；A/C/D 为空。 */
  requires: { network: string[]; credentials: string[]; diskBytes: number; binaries: string[]; dataMounts: string[] }
}

/**
 * A：纯 host 半，装进 profile 就能用。
 * B：要资源声明（网络/凭据/磁盘/二进制/数据卷），补齐后可用。
 * C：有 client 半，需要 UI 表面（云端嵌 DSH Web）。
 * D：桌面专有，云端不支持。
 */
export function classifyPlugin(caps: PluginCapabilities, context: ClassificationContext): Classification {
  const requires = {
    network: caps.network ?? [],
    credentials: caps.credentials ?? [],
    diskBytes: caps.diskBytes ?? 0,
    binaries: (caps.binaries ?? []).filter((bin) => !(context.availableBinaries ?? []).includes(bin)),
    dataMounts: (caps.dataMounts ?? []).filter((mount) => !(context.availableDataMounts ?? []).includes(mount))
  }

  if (caps.desktopOnly === true) {
    return { tier: 'D', reasons: ['needs desktop environment (local files/native modules/system integration)'], requires }
  }

  const reasons: string[] = []
  if (requires.network.length > 0) reasons.push(`network: ${requires.network.join(', ')}`)
  if (requires.credentials.length > 0) reasons.push(`credentials: ${requires.credentials.join(', ')}`)
  if (requires.diskBytes > 0) reasons.push(`disk: ${Math.ceil(requires.diskBytes / 1e6)}MB`)
  if (requires.binaries.length > 0) reasons.push(`binaries: ${requires.binaries.join(', ')}`)
  if (requires.dataMounts.length > 0) reasons.push(`data: ${requires.dataMounts.join(', ')}`)

  if (caps.clientHalf === true) {
    // 云端要 UI 表面；桌面端天然有。
    return context.platform === 'desktop'
      ? { tier: 'B', reasons: [...reasons, 'client half renders in the desktop app'], requires }
      : { tier: 'C', reasons: [...reasons, 'client half needs a DSH Web surface'], requires }
  }

  return reasons.length === 0
    ? { tier: 'A', reasons: [], requires }
    : { tier: 'B', reasons, requires }
}

/** 市场卡片上的一句话说明。 */
export function tierLabel(tier: PluginTier): string {
  switch (tier) {
    case 'A': return '直接可用'
    case 'B': return '需要授权资源'
    case 'C': return '需要界面容器'
    case 'D': return '仅桌面'
  }
}
