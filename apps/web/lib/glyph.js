// 程序化图标：packages/identity/src/glyph.ts 的等价重写（无 DOM 依赖，可在 node:test 里跑）。
// 不改算法，只改运行环境：fnv1a → 6 族 × 8 调色板 × 4 旋转 × 4 装饰点。
// 同一个 bot id 永远得到同一个图标；改名不改形象（docs/design/bot-identity.md §13.2）。

export const GLYPH_FAMILIES = ['egg', 'feather', 'wing', 'eye', 'nest', 'beak']
export const PALETTES = [
  { name: 'amber', dark: '#D8AB52', light: '#B8862F' },
  { name: 'teal', dark: '#5FB3B3', light: '#2E7D7D' },
  { name: 'blue', dark: '#7AA2E0', light: '#3A5EA8' },
  { name: 'violet', dark: '#A78BDB', light: '#6C4FB0' },
  { name: 'rose', dark: '#D98CA0', light: '#A8556A' },
  { name: 'moss', dark: '#8FBF7A', light: '#4F7A3F' },
  { name: 'clay', dark: '#D09A78', light: '#9A6446' },
  { name: 'slate', dark: '#9AA6B8', light: '#5A6678' },
]
const ROTATIONS = [0, 90, 180, 270]
const DOT_COUNTS = [0, 1, 2, 3]

/** fnv1a：小而稳，不依赖平台随机数。 */
export function hashId(id) {
  let hash = 0x811c9dc5
  for (let i = 0; i < id.length; i += 1) {
    hash ^= id.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

export function specFor(id) {
  const hash = hashId(id)
  return {
    family: GLYPH_FAMILIES[hash % 6],
    palette: PALETTES[Math.floor(hash / 6) % 8],
    rotate: ROTATIONS[Math.floor(hash / 48) % 4],
    dots: DOT_COUNTS[Math.floor(hash / 192) % 4],
    seed: hash,
  }
}

/** 各族的几何：都画在 96×96 画布里，描线 5，中心附近。 */
function familyPath(family) {
  switch (family) {
    case 'egg':
      return 'M48 20 C62 20 72 34 72 50 C72 66 61 76 48 76 C35 76 24 66 24 50 C24 34 34 20 48 20 Z'
    case 'feather':
      return 'M30 72 C34 46 46 28 68 22 C66 44 54 62 30 72 Z M38 62 L60 30'
    case 'wing':
      return 'M22 58 C36 40 52 30 74 26 C70 46 56 62 34 70 Z'
    case 'eye':
      return 'M22 48 C34 34 62 34 74 48 C62 62 34 62 22 48 Z'
    case 'nest':
      return 'M24 56 C34 68 62 68 72 56 M28 62 C38 72 58 72 68 62 M34 44 C40 38 56 38 62 44'
    case 'beak':
      return 'M28 40 C44 32 64 34 74 44 C64 52 46 58 32 54 Z'
    default:
      return ''
  }
}

function dotsMarks(count, color) {
  const spots = [
    [70, 26],
    [26, 70],
    [72, 70],
  ]
  return spots
    .slice(0, count)
    .map(([cx, cy]) => `<circle cx="${cx}" cy="${cy}" r="4.5" fill="${color}"/>`)
    .join('')
}

function escapeAttr(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * 产出可直接内联的 SVG。
 * @param {string} id Bot 的稳定 id（不是名字——改名不改形象）
 * @param {{theme?: 'dark'|'light', size?: number, label?: string}} [options]
 *   不给 label 时输出装饰性图标（名字就在旁边，别让读屏念两遍）。
 */
export function glyphSvg(id, options = {}) {
  const theme = options.theme || 'dark'
  const size = options.size || 24
  const label = options.label || ''
  const spec = specFor(id)
  const ink = theme === 'dark' ? spec.palette.dark : spec.palette.light
  const base = theme === 'dark' ? '#141619' : '#FFFFFF'
  const line = theme === 'dark' ? '#2A2E35' : '#E6E3DC'
  const a11y = label
    ? ` role="img" aria-label="${escapeAttr(label)}"`
    : ' role="presentation" aria-hidden="true"'
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 96 96"${a11y}>`,
    `<rect width="96" height="96" rx="24" fill="${base}" stroke="${line}" stroke-width="1.5"/>`,
    `<g transform="rotate(${spec.rotate} 48 48)" fill="none" stroke="${ink}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">`,
    `<path d="${familyPath(spec.family)}"/>`,
    '</g>',
    dotsMarks(spec.dots, ink),
    '</svg>',
  ].join('')
}
