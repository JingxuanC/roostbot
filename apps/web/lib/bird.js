// Roost 的 Bot 头像：程序化小鸟（原创几何，不是任何现成动画角色的复制）。
//
// 同一个 bot id 永远得到同一只鸟：hash → 物种 × 调色板 × 倾斜 × 眉形 × 标记。
// 画在 96×96 viewBox 里，最小 20px 仍能认出「鸟」：圆身、喙、两只眼、尾羽。
// 设计说明见 docs/design/bot-avatar.md。

export const BIRD_SPECIES = [
  // 可爱系
  'chick', 'duck', 'owl', 'sparrow', 'penguin', 'robin', 'snowy_owl', 'hummingbird', 'quail',
  // 夸张/疯狂系
  'rooster', 'crow', 'parrot', 'goose', 'eagle', 'turkey', 'peacock', 'crane', 'macaw'
]
export const BIRD_MOODS = ['cute', 'crazy']
export const BIRD_ACCESSORIES = ['none', 'glasses', 'headphones', 'tie', 'hardhat', 'crown']
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
    defaultAccessory: accessoryForId(id),
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
    // ---- 可爱系：大眼、软眉、圆身 -------------------------------------------
    case 'chick':
      return { mood: 'cute', bodyRx: 30, bodyRy: 31, eyeR: 8.6, eyeDx: 11.5, eyeY: 40, tail: 'short', crest: 'fluff', beak: 'tiny', belly: 1, extra: null }
    case 'duck':
      return { mood: 'cute', bodyRx: 32, bodyRy: 28, eyeR: 8.6, eyeDx: 12, eyeY: 37, tail: 'stub', crest: 'none', beak: 'flat', belly: 1.08, extra: null }
    case 'owl':
      return { mood: 'cute', bodyRx: 34, bodyRy: 33, eyeR: 11.4, eyeDx: 13, eyeY: 41, tail: 'short', crest: 'horns', beak: 'small', belly: 0.95, extra: null }
    case 'sparrow':
      return { mood: 'cute', bodyRx: 29, bodyRy: 29, eyeR: 8.8, eyeDx: 11, eyeY: 39, tail: 'short', crest: 'tuft', beak: 'tiny', belly: 1.05, extra: 'cheeks' }
    case 'penguin':
      return { mood: 'cute', bodyRx: 30, bodyRy: 33, eyeR: 8.2, eyeDx: 10.5, eyeY: 38, tail: 'stub', crest: 'none', beak: 'small', belly: 1.15, extra: 'penguin' }
    case 'robin':
      return { mood: 'cute', bodyRx: 29, bodyRy: 30, eyeR: 9, eyeDx: 11, eyeY: 39, tail: 'short', crest: 'tuft', beak: 'small', belly: 1, extra: 'breast' }
    // ---- 疯狂系：压眉、小瞳、夸张冠/喙 --------------------------------------
    case 'rooster':
      return { mood: 'crazy', bodyRx: 29, bodyRy: 31, eyeR: 7.8, eyeDx: 11, eyeY: 41, tail: 'plume', crest: 'comb', beak: 'small', belly: 1, extra: null }
    case 'crow':
      return { mood: 'crazy', bodyRx: 27, bodyRy: 32, eyeR: 6.6, eyeDx: 10.5, eyeY: 39, tail: 'long', crest: 'sleek', beak: 'pointed', belly: 0.95, extra: null }
    case 'parrot':
      return { mood: 'crazy', bodyRx: 28, bodyRy: 31, eyeR: 7.8, eyeDx: 11, eyeY: 39, tail: 'long', crest: 'curl', beak: 'hook', belly: 1, extra: null }
    case 'goose':
      return { mood: 'crazy', bodyRx: 31, bodyRy: 30, eyeR: 7.2, eyeDx: 11.5, eyeY: 36, tail: 'stub', crest: 'none', beak: 'goose', belly: 1.05, extra: 'neck' }
    case 'eagle':
      return { mood: 'crazy', bodyRx: 31, bodyRy: 31, eyeR: 7, eyeDx: 10.5, eyeY: 38, tail: 'fan', crest: 'eagle', beak: 'eagle', belly: 0.95, extra: null }
    case 'turkey':
      return { mood: 'crazy', bodyRx: 32, bodyRy: 29, eyeR: 7, eyeDx: 12, eyeY: 38, tail: 'fan', crest: 'snood', beak: 'small', belly: 0.9, extra: null }
    case 'snowy_owl':
      return { mood: 'cute', bodyRx: 33, bodyRy: 32, eyeR: 10.8, eyeDx: 12.5, eyeY: 40, tail: 'short', crest: 'horns', beak: 'small', belly: 1.05, extra: 'snow' }
    case 'hummingbird':
      return { mood: 'cute', bodyRx: 26, bodyRy: 28, eyeR: 8.2, eyeDx: 10, eyeY: 38, tail: 'needle', crest: 'tuft', beak: 'needle', belly: 1, extra: null }
    case 'quail':
      return { mood: 'cute', bodyRx: 30, bodyRy: 29, eyeR: 8.6, eyeDx: 11, eyeY: 39, tail: 'stub', crest: 'plume', beak: 'tiny', belly: 1.02, extra: null }
    case 'peacock':
      return { mood: 'crazy', bodyRx: 30, bodyRy: 30, eyeR: 7.4, eyeDx: 11, eyeY: 38, tail: 'peacock', crest: 'peacock', beak: 'small', belly: 1, extra: 'eyespots' }
    case 'crane':
      return { mood: 'crazy', bodyRx: 27, bodyRy: 32, eyeR: 7, eyeDx: 10, eyeY: 38, tail: 'short', crest: 'redcap', beak: 'crane', belly: 0.95, extra: 'neck' }
    case 'macaw':
    default:
      return { mood: 'crazy', bodyRx: 28, bodyRy: 31, eyeR: 7.6, eyeDx: 11, eyeY: 38, tail: 'long', crest: 'sleek', beak: 'macaw', belly: 1, extra: 'facepatch' }
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
    case 'tuft':
      return `<path d="M45 16c0-5 4-8 6-3M48 15c2-5 7-5 8 0" fill="none" stroke="${p.wing}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`
    case 'eagle':
      return `<path d="M36 20c-4-8 0-14 6-10 2-4 6-4 8 0 5-5 10 1 6 9" fill="${p.wing}" stroke="none"/><path d="M38 16l4 3M58 16l-4 3" stroke="${p.belly}" stroke-width="2" stroke-linecap="round"/>`
    case 'snood':
      return `<ellipse cx="34" cy="24" rx="5" ry="7" fill="#D9534F"/><path d="M44 20c-3-6 2-10 6-6 3 3 1 7-2 8" fill="#D9534F" opacity="0.9"/><path d="M42 63c-3 5-1 9 3 9 4 0 6-4 3-9" fill="#D9534F"/>`
    case 'plume':
      return `<path d="M48 16c-2-8 4-13 6-6 2-6 7-5 6 2 3-3 6 0 4 5" fill="none" stroke="${p.wing}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`
    case 'peacock':
      return `<path d="M48 18V8M38 18l-4-9M58 18l4-9" stroke="${p.wing}" stroke-width="2.4" stroke-linecap="round"/><circle cx="48" cy="6" r="3" fill="${p.wing}"/><circle cx="33" cy="7" r="2.6" fill="${p.wing}"/><circle cx="63" cy="7" r="2.6" fill="${p.wing}"/>`
    case 'redcap':
      return `<path d="M32 22c2-8 8-12 16-12 7 0 13 4 15 12" fill="#D9534F" opacity="0.95"/><path d="M40 18h16" stroke="#B33A36" stroke-width="2" stroke-linecap="round"/>`
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
    case 'fan':
      return `<path d="M70 62l20-14-2 12 8-2-12 12z" fill="${p.wing}"/><path d="M74 62l13-8M77 65l10-5" stroke="${p.belly}" stroke-width="1.4" opacity="0.5"/>`
    case 'peacock':
      return `<path d="M68 62c8-20 22-24 26-16-6-1-9 4-8 12-4-5-9-5-13-1z" fill="${p.wing}"/><circle cx="80" cy="48" r="4" fill="${p.belly}"/><circle cx="82" cy="47" r="1.7" fill="${p.body}"/>`
    case 'needle':
      return `<path d="M72 60l8 3-6 5z" fill="${p.wing}"/>`
    case 'stub':
      return `<path d="M74 62l11-3-6 9z" fill="${p.wing}"/>`
    case 'short':
    default:
      return `<path d="M72 59l13 3-10 6z" fill="${p.wing}"/>`
  }
}

const ACCESSORY_BY_ID = ['none', 'none', 'glasses', 'headphones', 'tie', 'hardhat', 'crown']

/** 角色 → 配饰；识别不了返回 null（再按 id 稳定兜底）。角色只是文案，不保证出现。 */
export function accessoryForRole(role) {
  const text = typeof role === 'string' ? role.toLowerCase() : ''
  if (/研究|分析|research|analyst|策略|strategy/.test(text)) return 'glasses'
  if (/数据|量化|data|quant|工程|engineer/.test(text)) return 'headphones'
  if (/风控|风险|risk|合规|review|评审|audit/.test(text)) return 'hardhat'
  if (/主持|host|协调|lead|负责/.test(text)) return 'crown'
  return null
}

/** 没有 role 时按 id 稳定给一个配饰（约 29% 不戴）。 */
export function accessoryForId(id) {
  const hash = birdHash(id)
  return ACCESSORY_BY_ID[Math.floor(hash / 864) % ACCESSORY_BY_ID.length]
}

function accessoryMarkup(kind, shape, p) {
  const { eyeR, eyeDx, eyeY } = shape
  const left = 48 - eyeDx
  const right = 48 + eyeDx
  switch (kind) {
    case 'glasses':
      return `<g stroke="#2E2A24" stroke-width="2.6"><circle cx="${left}" cy="${eyeY}" r="${round(eyeR + 2.6)}" fill="#FFFFFF" fill-opacity="0.12"/><circle cx="${right}" cy="${eyeY}" r="${round(eyeR + 2.6)}" fill="#FFFFFF" fill-opacity="0.12"/><path d="M${left + eyeR + 2.6} ${eyeY}h${round(right - left - 2 * (eyeR + 2.6))}M${left - eyeR - 2.6} ${eyeY}h-7M${right + eyeR + 2.6} ${eyeY}h7" fill="none" stroke-linecap="round"/></g><path d="M${left - 3} ${eyeY - 5}l5-4M${right - 3} ${eyeY - 5}l5-4" stroke="#FFFFFF" stroke-width="1.8" opacity="0.55" stroke-linecap="round"/>`
    case 'headphones':
      return `<path d="M24 ${eyeY - 5}c2-18 46-18 48 0" fill="none" stroke="${p.wing}" stroke-width="4.5" stroke-linecap="round"/><rect x="16" y="${eyeY - 6}" width="10" height="17" rx="4.5" fill="${p.wing}" stroke="#1B1B1F" stroke-width="1.4"/><rect x="70" y="${eyeY - 6}" width="10" height="17" rx="4.5" fill="${p.wing}" stroke="#1B1B1F" stroke-width="1.4"/>`
    case 'tie':
      return `<path d="M41 64l7 5 7-5" fill="none" stroke="#FFFDF7" stroke-width="2" stroke-linecap="round"/><path d="M48 68l-5 12 5 7 5-7z" fill="#B33A36"/><circle cx="48" cy="70" r="2.4" fill="#8E2B28"/>`
    case 'hardhat':
      return `<path d="M25 23c2-14 12-21 23-21s21 7 23 21z" fill="#E9B23B" stroke="#B97C1F" stroke-width="2"/><path d="M21 24h54" stroke="#B97C1F" stroke-width="5" stroke-linecap="round"/><path d="M40 8c0 5 1 10 3 15M56 8c0 5-1 10-3 15" stroke="#C98F2A" stroke-width="2" stroke-linecap="round"/>`
    case 'crown':
      return `<path d="M32 17l4-11 6 8 6-10 6 10 6-8 4 11z" fill="#E8C24A" stroke="#B98A1F" stroke-width="1.8" stroke-linejoin="round"/><circle cx="48" cy="9" r="2" fill="#B33A36"/>`
    default:
      return ''
  }
}

/** 物种专属小部件：腮红、企鹅肚、知更鸟胸斑、鹅颈环。 */
function extrasMarkup(shape, p) {
  switch (shape.extra) {
    case 'cheeks':
      return `<circle cx="28" cy="54" r="5" fill="#F08A8A" opacity="0.45"/><circle cx="68" cy="54" r="5" fill="#F08A8A" opacity="0.45"/>`
    case 'penguin':
      return `<ellipse cx="48" cy="58" rx="20" ry="22" fill="${p.belly}"/><path d="M40 70c2 3 5 4 8 4s6-1 8-4" stroke="#D9D4C7" stroke-width="1.6" fill="none"/>`
    case 'breast':
      return `<path d="M33 52c0-8 6-13 15-13s15 5 15 13c0 9-7 14-15 14s-15-5-15-14z" fill="#E07A4F"/>`
    case 'neck':
      return `<path d="M34 46c4 4 9 6 14 6s10-2 14-6" stroke="${p.belly}" stroke-width="4" stroke-linecap="round" fill="none"/>`
    case 'snow':
      return `<circle cx="26" cy="52" r="5" fill="#FFFDF7" opacity="0.5"/><circle cx="70" cy="52" r="5" fill="#FFFDF7" opacity="0.5"/>`
    case 'eyespots':
      return `<circle cx="28" cy="30" r="4.2" fill="${p.belly}" opacity="0.7"/><circle cx="68" cy="30" r="4.2" fill="${p.belly}" opacity="0.7"/>`
    case 'facepatch':
      return `<path d="M34 39c0-5 6-9 14-9s14 4 14 9c0 5-6 8-14 8s-14-3-14-8z" fill="#FFFDF7" opacity="0.92"/>`
    default:
      return ''
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
    case 'goose':
      return `<path d="M33 52c0-4 5-6 15-6s15 2 15 6c0 3-4 4-9 4l-12 1c-5 0-9-1-9-5z" fill="${p.beak}"/><path d="M36 54h27" stroke="#B9741F" stroke-width="1.5" stroke-linecap="round"/>`
    case 'eagle':
      return `<path d="M48 46l11 3c3 1 3 4 0 5l-8 3 1-5-7 2-4-3z" fill="${p.beak}"/><path d="M51 51l7 2" stroke="#B9741F" stroke-width="1.5" stroke-linecap="round"/>`
    case 'penguin':
      return `<path d="M48 49l8 6-8 6-8-6z" fill="${p.beak}"/><path d="M41 55h14" stroke="#B9741F" stroke-width="1.4" stroke-linecap="round"/>`
    case 'needle':
      return `<path d="M48 52l24 1-24 3z" fill="${p.beak}"/><path d="M48 54h20" stroke="#B9741F" stroke-width="1.2" stroke-linecap="round"/>`
    case 'crane':
      return `<path d="M48 51l15 3-15 6-3-5z" fill="${p.beak}"/><path d="M45 55h14" stroke="#B9741F" stroke-width="1.3" stroke-linecap="round"/>`
    case 'macaw':
      return `<path d="M48 46c10-1 16 4 15 10-1 6-8 9-13 5l-5-7z" fill="${p.beak}"/><path d="M58 56c-3 2-7 2-9-1" stroke="#B9741F" stroke-width="1.5" fill="none" stroke-linecap="round"/>`
    default:
      return `<path d="M48 48l9 7-9 7-9-7z" fill="${p.beak}"/><path d="M39 55h18" stroke="#B9741F" stroke-width="1.6" stroke-linecap="round"/>`
  }
}

function browMarkup(brow, state, eyeY, mood = 'cute') {
  const y = eyeY - 12
  const width = state === 'alert' ? 3.4 : 3
  const color = '#3A2A1A'
  if (state === 'paused') return ''
  if (state === 'alert') {
    return `<path d="M28 ${y + 2}c4-4 10-4 14-1M54 ${y + 1}c4-3 10-3 14 1" stroke="${color}" stroke-width="${width}" stroke-linecap="round" fill="none"/>`
  }
  if (mood === 'crazy') {
    // 疯狂系：眉骨压向鼻梁（内低外高），不靠动画也看得出脾气。
    return `<path d="M27 ${y + 6}c5-5 10-7 14-7M69 ${y + 6}c-5-5-10-7-14-7" stroke="${color}" stroke-width="${width + 0.6}" stroke-linecap="round" fill="none"/>`
  }
  if (brow === 'sharp') {
    return `<path d="M28 ${y + 3}c5-4 10-4 14-1M68 ${y + 3}c-5-4-10-4-14-1" stroke="${color}" stroke-width="${width}" stroke-linecap="round" fill="none"/>`
  }
  if (brow === 'soft') {
    return `<path d="M28 ${y + 1}c4-3 10-3 14 0M68 ${y + 1}c-4-3-10-3-14 0" stroke="${color}" stroke-width="${width}" stroke-linecap="round" fill="none"/>`
  }
  return `<path d="M28 ${y}c4-2 10-2 14 0M68 ${y}c-4-2-10-2-14 0" stroke="${color}" stroke-width="${width}" stroke-linecap="round" fill="none"/>`
}

function eyesMarkup(shape, state, p, mood = 'cute') {
  const { eyeR, eyeDx, eyeY } = shape
  const left = 48 - eyeDx
  const right = 48 + eyeDx
  if (state === 'paused') {
    return `<path d="M${left - 6} ${eyeY}c3-3 9-3 12 0M${right - 6} ${eyeY}c3-3 9-3 12 0" stroke="#3A2A1A" stroke-width="3" stroke-linecap="round" fill="none"/>`
  }
  const pupilY = state === 'alert' ? eyeY - 2 : eyeY + 1
  const pupilScale = mood === 'crazy' ? 0.34 : 0.44
  return [
    `<circle cx="${left}" cy="${eyeY}" r="${eyeR}" fill="#FFFDF7"/>`,
    `<circle cx="${right}" cy="${eyeY}" r="${eyeR}" fill="#FFFDF7"/>`,
    `<circle cx="${left + 1.4}" cy="${pupilY}" r="${round(eyeR * pupilScale)}" fill="#26211C"/>`,
    `<circle cx="${right + 1.4}" cy="${pupilY}" r="${round(eyeR * pupilScale)}" fill="#26211C"/>`,
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
  const shape = speciesShape(spec.species)
  // 企鹅/鹅读图优先：它们靠黑白/白身识别，不跟调色板走。
  const p =
    spec.species === 'penguin'
      ? { ...spec.palette, body: '#2E3440', wing: '#1B2026', belly: '#F7F5EE' }
      : spec.species === 'goose'
        ? { ...spec.palette, body: '#ECE7DA', wing: spec.palette.wing, belly: '#FFFFFF' }
        : spec.palette
  const body = `M48 ${48 - shape.bodyRy}c${shape.bodyRx * 0.95} 0 ${shape.bodyRx} ${shape.bodyRy * 0.55} ${shape.bodyRx} ${shape.bodyRy} 0 ${shape.bodyRy * 0.62} -${shape.bodyRx * 0.66} ${shape.bodyRy * 0.94} -${shape.bodyRx} ${shape.bodyRy * 0.94} -${shape.bodyRx * 0.34} 0 -${shape.bodyRx} -${shape.bodyRy * 0.32} -${shape.bodyRx} -${shape.bodyRy * 0.94} 0 -${shape.bodyRy * 0.45} ${shape.bodyRx * 0.05} -${shape.bodyRy} ${shape.bodyRx} -${shape.bodyRy}z`
  const ring = state === 'working'
    ? `<circle class="bird-ring" cx="48" cy="48" r="45" fill="none" stroke="${p.wing}" stroke-width="3" opacity="0.35"/>`
    : ''
  const marking = spec.marking === 'cheek'
    ? `<circle cx="26" cy="53" r="4.2" fill="${p.wing}" opacity="0.5"/><circle cx="70" cy="53" r="4.2" fill="${p.wing}" opacity="0.5"/>`
    : ''
  const pausedOpacity = state === 'paused' ? '0.55' : '1'
  const label = typeof options.label === 'string' && options.label.trim() !== '' ? options.label.trim() : 'Bot 头像'
  const accessory =
    BIRD_ACCESSORIES.includes(options.accessory)
      ? options.accessory
      : (accessoryForRole(options.role) ?? spec.defaultAccessory)

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" width="${size}" height="${size}" role="img" aria-label="${esc(label)}" focusable="false"><g opacity="${pausedOpacity}" transform="rotate(${spec.tilt} 48 48)">${ring}<circle cx="48" cy="48" r="45" fill="${p.belly}" opacity="0.28"/>${tailMarkup(shape.tail, p)}<path d="${body}" fill="${p.body}"/><ellipse cx="48" cy="62" rx="${round(shape.bodyRx * 0.62)}" ry="${round(shape.bodyRy * 0.44 * (shape.belly ?? 1))}" fill="${p.belly}" opacity="0.85"/>${extrasMarkup(shape, p)}<ellipse cx="${48 - shape.bodyRx + 6}" cy="56" rx="7" ry="12" fill="${p.wing}" opacity="0.85"/><ellipse cx="${48 + shape.bodyRx - 6}" cy="56" rx="7" ry="12" fill="${p.wing}" opacity="0.85"/><path d="M22 58c2 6 5 10 9 13M74 58c-2 6-5 10-9 13" stroke="${p.belly}" stroke-width="2.2" stroke-linecap="round" opacity="0.55"/>${crestMarkup(shape.crest, p)}${browMarkup(spec.brow, state, shape.eyeY, shape.mood)}${eyesMarkup(shape, state, p, shape.mood)}${beakMarkup(shape, p)}${marking}${state === 'paused' ? '' : accessoryMarkup(accessory, shape, p)}<path d="M40 80l-6 7M56 80l6 7" stroke="#B9741F" stroke-width="3.4" stroke-linecap="round"/></g></svg>`
}

/**
 * 对话列表用的圆鸟：圆身、喙、两只眼、头顶一簇。
 * 主 Bot 是白身；星标由外层徽章画，不画进 SVG，避免被裁掉。
 */
export function roundBirdSvg(id, options = {}) {
  const size = Number.isFinite(options.size) && options.size > 0 ? Math.round(options.size) : 36
  const primary = options.primary === true
  const palette = BIRD_PALETTES[birdHash(id) % BIRD_PALETTES.length]
  const body = primary ? '#ffffff' : palette.body
  const tuft = primary ? '#e7e7ea' : palette.wing
  const eye = primary ? '#1c1c1e' : '#ffffff'
  const pupil = '#1c1c1e'
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${size}" height="${size}" aria-hidden="true" focusable="false"><path d="M30 18c1-9 8-8 7 1" fill="${tuft}"/><path d="M27 16c2-7 5-7 6 0" fill="${tuft}" opacity="0.85"/><circle cx="30" cy="36" r="20" fill="${body}"/><circle cx="24" cy="34" r="3.3" fill="${eye}"/><circle cx="36" cy="34" r="3.3" fill="${eye}"/><circle cx="25" cy="34.4" r="1.45" fill="${pupil}"/><circle cx="37" cy="34.4" r="1.45" fill="${pupil}"/><path d="M46 33.5l12 4.2-12 4.2z" fill="#E9A23B"/></svg>`
}
