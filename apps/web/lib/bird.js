// Roost 的 Bot 头像：程序化小鸟（原创几何，不是任何现成动画角色的复制）。
//
// 同一个 bot id 永远得到同一只鸟：hash → 物种 × 调色板 × 倾斜 × 眉形 × 标记。
// 画在 96×96 viewBox 里，最小 20px 仍能认出「鸟」：圆身、喙、两只眼、尾羽。
// 设计说明见 docs/design/bot-avatar.md。

export const BIRD_SPECIES = ['chick', 'rooster', 'owl', 'crow', 'parrot', 'duck']
export const BIRD_STATES = ['idle', 'working', 'paused', 'alert']

/** 与 glyph 共用 8 个品牌强调色；喙/爪固定暖黄，保证在深浅主题下都可辨。 */
export const BIRD_PALETTES = [
  { name: 'amber', body: '#D8AB52', wing: '#B8862F', belly: '#F3DDAE', beak: '#E9A23B' },
  { name: 'teal', body: '#5FB3B3', wing: '#2E7D7D', belly: '#CDEAEA', beak: '#E9A23B' },
  { name: 'blue', body: '#7AA2E0', wing: '#3A5EA8', belly: '#D7E3F7', beak: '#E9A23B' },
  { name: 'violet', body: '#A78BDB', wing: '#6C4FB0', belly: '#E4DCF5', beak: '#E9A23B' },
  { name: 'rose', body: '#D98CA0', wing: '#A8556A', belly: '#F6DDE3', beak: '#E9A23B' },
  { name: 'moss', body: '#8FBF7A', wing: '#4F7A3F', belly: '#DDEED2', beak: '#E9A23B' },
  { name: 'clay', body: '#D09A78', wing: '#9A6446', belly: '#F1E0D3', beak: '#E9A23B' },
  { name: 'slate', body: '#9AA6B8', wing: '#5A6678', belly: '#E2E7EE', beak: '#E9A23B' }
]

/** fnv1a，与 glyph 同一套 hash：同一 id 的鸟和旧 glyph 的 seed 一致，便于迁移。 */
export function birdHash(id) {
  let hash = 0x811c9dc5
  const text = typeof id === 'string' ? id : String(id ?? '')
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

const TILTS = [-4, 0, 4]
const BROWS = ['flat', 'soft', 'sharp']
const MARKINGS = ['none', 'cheek']

export function birdSpecFor(id) {
  const hash = birdHash(id)
  return {
    species: BIRD_SPECIES[hash % BIRD_SPECIES.length],
    palette: BIRD_PALETTES[Math.floor(hash / 6) % BIRD_PALETTES.length],
    tilt: TILTS[Math.floor(hash / 48) % TILTS.length],
    brow: BROWS[Math.floor(hash / 144) % BROWS.length],
    marking: MARKINGS[Math.floor(hash / 432) % MARKINGS.length],
    seed: hash
  }
}

function esc(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[ch])
}

function round(value) {
  return Math.round(value * 10) / 10
}

/** 物种差异：身体宽窄、眼睛大小/间距、尾巴长度、额饰。 */
function speciesShape(species) {
  switch (species) {
    case 'chick':
      return { bodyRx: 30, bodyRy: 31, eyeR: 8.4, eyeDx: 11.5, eyeY: 40, tail: 'short', crest: 'fluff', beak: 'tiny' }
    case 'rooster':
      return { bodyRx: 29, bodyRy: 31, eyeR: 7.8, eyeDx: 11, eyeY: 41, tail: 'plume', crest: 'comb', beak: 'small' }
    case 'owl':
      return { bodyRx: 34, bodyRy: 33, eyeR: 11.2, eyeDx: 13, eyeY: 41, tail: 'short', crest: 'horns', beak: 'small' }
    case 'crow':
      return { bodyRx: 27, bodyRy: 32, eyeR: 7, eyeDx: 10.5, eyeY: 39, tail: 'long', crest: 'sleek', beak: 'pointed' }
    case 'parrot':
      return { bodyRx: 28, bodyRy: 31, eyeR: 8, eyeDx: 11, eyeY: 39, tail: 'long', crest: 'curl', beak: 'hook' }
    case 'duck':
    default:
      return { bodyRx: 32, bodyRy: 28, eyeR: 8.4, eyeDx: 12, eyeY: 37, tail: 'stub', crest: 'none', beak: 'flat' }
  }
}

function crestMarkup(kind, p) {
  switch (kind) {
    case 'comb':
      return `<path d="M35 20c-2-7 3-11 7-6 0-8 7-9 9-3 3-5 9-2 7 4 2-1 4 1 3 4" fill="#D9534F" stroke="#B33A36" stroke-width="1.4" stroke-linejoin="round"/><path d="M43 63c-2 4-1 7 3 7 4 0 6-3 4-7" fill="#D9534F" opacity="0.95"/>`
    case 'horns':
      return `<path d="M28 21C21 12 22 5 29 4c2 6 4 10 8 12zM68 21c7-9 6-16-1-17-2 6-4 10-8 12z" fill="${p.wing}"/>`
    case 'curl':
      return `<path d="M45 18c-4-8 3-14 9-10 5 4 2 9-2 10 3 1 4 4 2 7" fill="none" stroke="${p.wing}" stroke-width="4.4" stroke-linecap="round"/>`
    case 'sleek':
      return `<path d="M42 17c2-6 8-7 11-3M50 16c2-4 6-4 8-1" fill="none" stroke="${p.wing}" stroke-width="3.4" stroke-linecap="round"/>`
    case 'fluff':
      return `<path d="M40 17l2-7 4 6 3-8 4 8 3-6 2 7" fill="none" stroke="${p.wing}" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>`
    default:
      return ''
  }
}

function tailMarkup(kind, p) {
  switch (kind) {
    case 'long':
      return `<path d="M72 56l17 6-14 4 11 8-21-8z" fill="${p.wing}"/><path d="M76 60l12 4-9 3" stroke="#00000022" stroke-width="1.4" fill="none"/>`
    case 'plume':
      return `<path d="M73 53c7-6 15-7 19-4-5 3-6 7-5 12-5-3-10-2-15 2z" fill="${p.wing}"/><path d="M77 56c5-3 10-3 13-2" stroke="#00000022" stroke-width="1.4" fill="none"/>`
    case 'stub':
      return `<path d="M74 62l11-3-6 9z" fill="${p.wing}"/>`
    case 'short':
    default:
      return `<path d="M72 59l13 3-10 6z" fill="${p.wing}"/>`
  }
}

function beakMarkup(shape, p) {
  switch (shape.beak) {
    case 'flat':
      return `<ellipse cx="48" cy="56" rx="14" ry="6.4" fill="${p.beak}"/><path d="M34 56h28" stroke="#B9741F" stroke-width="1.6" stroke-linecap="round"/><ellipse cx="42" cy="55" rx="1.6" ry="1.1" fill="#8A5416" opacity="0.7"/>`
    case 'hook':
      return `<path d="M48 47c9-1 15 4 14 10-1 6-7 9-12 5l-4-6z" fill="${p.beak}"/><path d="M58 57c-3 2-6 2-8 0" stroke="#B9741F" stroke-width="1.6" fill="none" stroke-linecap="round"/>`
    case 'pointed':
      return `<path d="M48 45l12 10-12 5-6-8z" fill="${p.beak}"/><path d="M42 52h18" stroke="#B9741F" stroke-width="1.5" stroke-linecap="round"/>`
    case 'tiny':
      return `<path d="M43 53l5 4 5-4-5 7z" fill="${p.beak}"/>`
    case 'small':
      return `<path d="M42 51l6 5 6-5-6 8z" fill="${p.beak}"/><path d="M42 55h12" stroke="#B9741F" stroke-width="1.4" stroke-linecap="round"/>`
    default:
      return `<path d="M48 48l9 7-9 7-9-7z" fill="${p.beak}"/><path d="M39 55h18" stroke="#B9741F" stroke-width="1.6" stroke-linecap="round"/>`
  }
}

function browMarkup(brow, state, eyeY) {
  const y = eyeY - 12
  const width = state === 'alert' ? 3.4 : 3
  const color = '#3A2A1A'
  if (state === 'paused') return ''
  if (state === 'alert') {
    return `<path d="M28 ${y + 2}c4-4 10-4 14-1M54 ${y + 1}c4-3 10-3 14 1" stroke="${color}" stroke-width="${width}" stroke-linecap="round" fill="none"/>`
  }
  if (brow === 'sharp') {
    return `<path d="M28 ${y + 3}c5-4 10-4 14-1M68 ${y + 3}c-5-4-10-4-14-1" stroke="${color}" stroke-width="${width}" stroke-linecap="round" fill="none"/>`
  }
  if (brow === 'soft') {
    return `<path d="M28 ${y + 1}c4-3 10-3 14 0M68 ${y + 1}c-4-3-10-3-14 0" stroke="${color}" stroke-width="${width}" stroke-linecap="round" fill="none"/>`
  }
  return `<path d="M28 ${y}c4-2 10-2 14 0M68 ${y}c-4-2-10-2-14 0" stroke="${color}" stroke-width="${width}" stroke-linecap="round" fill="none"/>`
}

function eyesMarkup(shape, state, p) {
  const { eyeR, eyeDx, eyeY } = shape
  const left = 48 - eyeDx
  const right = 48 + eyeDx
  if (state === 'paused') {
    return `<path d="M${left - 6} ${eyeY}c3-3 9-3 12 0M${right - 6} ${eyeY}c3-3 9-3 12 0" stroke="#3A2A1A" stroke-width="3" stroke-linecap="round" fill="none"/>`
  }
  const pupilY = state === 'alert' ? eyeY - 2 : eyeY + 1
  return [
    `<circle cx="${left}" cy="${eyeY}" r="${eyeR}" fill="#FFFDF7"/>`,
    `<circle cx="${right}" cy="${eyeY}" r="${eyeR}" fill="#FFFDF7"/>`,
    `<circle cx="${left + 1.4}" cy="${pupilY}" r="${round(eyeR * 0.44)}" fill="#26211C"/>`,
    `<circle cx="${right + 1.4}" cy="${pupilY}" r="${round(eyeR * 0.44)}" fill="#26211C"/>`,
    `<circle cx="${left + 2.6}" cy="${pupilY - 2.2}" r="${round(eyeR * 0.16)}" fill="#FFFFFF" opacity="0.9"/>`,
    `<circle cx="${right + 2.6}" cy="${pupilY - 2.2}" r="${round(eyeR * 0.16)}" fill="#FFFFFF" opacity="0.9"/>`
  ].join('')
}

/**
 * 生成一只鸟的 SVG 字符串。
 * @param {string} id Bot id（决定形象；改名不改）
 * @param {{size?: number, state?: 'idle'|'working'|'paused'|'alert'}} [options]
 */
export function birdSvg(id, options = {}) {
  const size = Number.isFinite(options.size) && options.size > 0 ? Math.round(options.size) : 24
  const state = BIRD_STATES.includes(options.state) ? options.state : 'idle'
  const spec = birdSpecFor(id)
  const p = spec.palette
  const shape = speciesShape(spec.species)
  const body = `M48 ${48 - shape.bodyRy}c${shape.bodyRx * 0.95} 0 ${shape.bodyRx} ${shape.bodyRy * 0.55} ${shape.bodyRx} ${shape.bodyRy} 0 ${shape.bodyRy * 0.62} -${shape.bodyRx * 0.66} ${shape.bodyRy * 0.94} -${shape.bodyRx} ${shape.bodyRy * 0.94} -${shape.bodyRx * 0.34} 0 -${shape.bodyRx} -${shape.bodyRy * 0.32} -${shape.bodyRx} -${shape.bodyRy * 0.94} 0 -${shape.bodyRy * 0.45} ${shape.bodyRx * 0.05} -${shape.bodyRy} ${shape.bodyRx} -${shape.bodyRy}z`
  const ring = state === 'working'
    ? `<circle class="bird-ring" cx="48" cy="48" r="45" fill="none" stroke="${p.wing}" stroke-width="3" opacity="0.35"/>`
    : ''
  const marking = spec.marking === 'cheek'
    ? `<circle cx="26" cy="53" r="4.2" fill="${p.wing}" opacity="0.5"/><circle cx="70" cy="53" r="4.2" fill="${p.wing}" opacity="0.5"/>`
    : ''
  const pausedOpacity = state === 'paused' ? '0.55' : '1'
  const label = typeof options.label === 'string' && options.label.trim() !== '' ? options.label.trim() : 'Bot 头像'

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" width="${size}" height="${size}" role="img" aria-label="${esc(label)}" focusable="false"><g opacity="${pausedOpacity}" transform="rotate(${spec.tilt} 48 48)">${ring}<circle cx="48" cy="48" r="45" fill="${p.belly}" opacity="0.28"/>${tailMarkup(shape.tail, p)}<path d="${body}" fill="${p.body}"/><ellipse cx="48" cy="62" rx="${round(shape.bodyRx * 0.62)}" ry="${round(shape.bodyRy * 0.44)}" fill="${p.belly}" opacity="0.85"/><ellipse cx="${48 - shape.bodyRx + 6}" cy="56" rx="7" ry="12" fill="${p.wing}" opacity="0.85"/><ellipse cx="${48 + shape.bodyRx - 6}" cy="56" rx="7" ry="12" fill="${p.wing}" opacity="0.85"/><path d="M22 58c2 6 5 10 9 13M74 58c-2 6-5 10-9 13" stroke="${p.belly}" stroke-width="2.2" stroke-linecap="round" opacity="0.55"/>${crestMarkup(shape.crest, p)}${browMarkup(spec.brow, state, shape.eyeY)}${eyesMarkup(shape, state, p)}${beakMarkup(shape, p)}${marking}<path d="M40 80l-6 7M56 80l6 7" stroke="#B9741F" stroke-width="3.4" stroke-linecap="round"/></g></svg>`
}
