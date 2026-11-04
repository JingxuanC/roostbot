// 设计见 docs/design/ui.md §6。改这里之前先读那一节。
//
// 这是 token 的唯一源。apps/web 零构建，所以 styles.css 的 :root 是手写同步的；
// packages/tokens/test/tokens.test.ts 会逐条比对两处，只改一边测试会红。

export const color = {
  dark: {
    bg: '#0B0C0E', surface: '#141619', border: '#24272C',
    ink: '#E8EAEF', muted: '#8B93A3',
    accent: '#D8AB52', ok: '#7FB37F', warn: '#D9A441', danger: '#D2726A',
  },
  light: {
    bg: '#FAFAF8', surface: '#FFFFFF', border: '#E6E3DC',
    ink: '#1B1D21', muted: '#6B7280',
    accent: '#B8862F', ok: '#3F7A44', warn: '#9A6B12', danger: '#A63A32',
  },
} as const

export type ThemeName = keyof typeof color

/** 4 的倍数；不要用 5、7、13 这种数。 */
export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32, xxxl: 48 } as const

export const radius = { sm: 6, md: 10, lg: 14, full: 999 } as const

export const font = {
  sans: '-apple-system, "SF Pro Text", "PingFang SC", "Noto Sans SC", system-ui, sans-serif',
  mono: 'ui-monospace, "SF Mono", Menlo, monospace',
} as const

export const fontSize = { xs: 12, sm: 13, md: 14, lg: 16, xl: 20, xxl: 24, display: 32 } as const
export const lineHeight = { body: 1.5, title: 1.3 } as const

/** 与 styles.css 现有用法一致：弹层用 md，灯箱用 lg。 */
export const shadow = {
  none: 'none',
  sm: '0 1px 2px rgba(0, 0, 0, 0.24)',
  md: '0 12px 32px rgba(0, 0, 0, 0.36)',
  lg: '0 24px 64px rgba(0, 0, 0, 0.5)',
} as const

/** 层叠顺序：数字越大越靠上；跳转链接必须盖住所有浮层。 */
export const zIndex = {
  base: 0,
  raised: 5,
  sticky: 10,
  header: 30,
  nav: 40,
  overlay: 1000,
  skipLink: 2000,
} as const

export const motion = {
  fast: 120,
  base: 180,
  slow: 240,
  easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
  /** 遵守 prefers-reduced-motion 时把时长归零，不要移除状态变化。 */
  reduced: 0,
} as const

/** 完整 token 树：flattenTokens() 与文档都以它为准。 */
export const tokens = {
  color,
  fontSize,
  lineHeight,
  space,
  radius,
  shadow,
  zIndex,
  font,
  motion,
} as const

type TokenValue = string | number
type TokenTree = { readonly [key: string]: TokenValue | TokenTree }

/** 这些组的数字在 CSS 里要带单位；其余（行高、层级、字重等）保持无单位。 */
const PX_GROUPS = new Set(['space', 'radius', 'fontSize'])
const MS_GROUPS = new Set(['motion'])

function formatTokenValue(path: string, value: TokenValue): string {
  if (typeof value !== 'number') return value
  const group = path.split('.')[0]
  if (PX_GROUPS.has(group)) return `${value}px`
  if (MS_GROUPS.has(group)) return `${value}ms`
  return String(value)
}

/**
 * 把嵌套 token 树压平成 `{ 'color.dark.bg': '#0B0C0E', 'space.md': '12px' }`。
 * 数值会按组补单位（间距/圆角/字号 px，动效 ms），其余数字保持原样。
 */
export function flattenTokens(tree: TokenTree = tokens): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (node: TokenTree, prefix: string) => {
    for (const [key, value] of Object.entries(node)) {
      const path = prefix === '' ? key : `${prefix}.${key}`
      if (value !== null && typeof value === 'object') walk(value as TokenTree, path)
      else out[path] = formatTokenValue(path, value as TokenValue)
    }
  }
  walk(tree, '')
  return out
}

function kebab(key: string): string {
  return key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
}

/** 主题色 + 无主题的基础 token，按固定顺序产出 [变量名, 值]。 */
export function cssVarEntries(theme: ThemeName = 'dark'): Array<[string, string]> {
  const c = color[theme]
  const entries: Array<[string, string]> = [
    ['--roost-bg', c.bg],
    ['--roost-surface', c.surface],
    ['--roost-border', c.border],
    ['--roost-ink', c.ink],
    ['--roost-muted', c.muted],
    ['--roost-accent', c.accent],
    ['--roost-ok', c.ok],
    ['--roost-warn', c.warn],
    ['--roost-danger', c.danger],
  ]
  for (const [key, value] of Object.entries(fontSize)) {
    entries.push([`--roost-font-size-${key}`, `${value}px`])
  }
  for (const [key, value] of Object.entries(lineHeight)) {
    entries.push([`--roost-leading-${kebab(key)}`, String(value)])
  }
  for (const [key, value] of Object.entries(space)) {
    entries.push([`--roost-space-${key}`, `${value}px`])
  }
  for (const [key, value] of Object.entries(radius)) {
    entries.push([`--roost-radius-${key}`, `${value}px`])
  }
  for (const [key, value] of Object.entries(shadow)) {
    entries.push([`--roost-shadow-${key}`, value])
  }
  for (const [key, value] of Object.entries(zIndex)) {
    entries.push([`--roost-z-${kebab(key)}`, String(value)])
  }
  entries.push(['--roost-font-sans', font.sans], ['--roost-font-mono', font.mono])
  for (const key of ['fast', 'base', 'slow', 'reduced'] as const) {
    entries.push([`--roost-motion-${key}`, `${motion[key]}ms`])
  }
  entries.push(['--roost-easing', motion.easing])
  return entries
}

/** 生成可直接塞进 `:root { … }` 的声明文本，一行一个 `--roost-*: value;`。 */
export function cssVariables(theme: ThemeName = 'dark'): string {
  return cssVarEntries(theme)
    .map(([name, value]) => `${name}: ${value};`)
    .join('\n')
}

/**
 * 旧 API：返回对象而不是文本。保留给已按 README 使用的代码；
 * 新代码用 cssVariables()，两处值来自同一份 entries。
 */
export function cssVars(theme: ThemeName): Record<string, string> {
  return Object.fromEntries(cssVarEntries(theme))
}
