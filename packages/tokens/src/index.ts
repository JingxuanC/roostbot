// 设计见 docs/design/ui.md §6。改这里之前先读那一节。

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

export const motion = {
  fast: 120,
  base: 180,
  slow: 240,
  easing: 'cubic-bezier(.2,.8,.2,1)',
  /** 遵守 prefers-reduced-motion 时把时长归零，不要移除状态变化。 */
  reduced: 0,
} as const

/** 生成 CSS 变量，供 apps/web 在 :root 与 [data-theme=light] 下注入。 */
export function cssVars(theme: ThemeName): Record<string, string> {
  const c = color[theme]
  return {
    '--roost-bg': c.bg, '--roost-surface': c.surface, '--roost-border': c.border,
    '--roost-ink': c.ink, '--roost-muted': c.muted, '--roost-accent': c.accent,
    '--roost-ok': c.ok, '--roost-warn': c.warn, '--roost-danger': c.danger,
    '--roost-space-xs': `${space.xs}px`, '--roost-space-sm': `${space.sm}px`,
    '--roost-space-md': `${space.md}px`, '--roost-space-lg': `${space.lg}px`,
    '--roost-space-xl': `${space.xl}px`,
    '--roost-radius-sm': `${radius.sm}px`, '--roost-radius-md': `${radius.md}px`,
    '--roost-font-sans': font.sans, '--roost-font-mono': font.mono,
    '--roost-motion-base': `${motion.base}ms`,
    '--roost-motion-easing': motion.easing,
  }
}
