// 最薄的 DOM 工具：建元素、内联 SVG、头像。
// 所有渲染都走这里：用户输入只进 textContent / value / 属性，绝不拼 innerHTML。
// （svgNode 是唯一 innerHTML，输入是 lib/glyph.js 以固定算法生成的常量标记。）

import { glyphSvg } from './glyph.js'
import { birdSvg, roundBirdSvg } from './bird.js'
import { isAvatarDataUrl } from './avatar.js'

export const $ = (selector, root = document) => root.querySelector(selector)

/**
 * 建元素：props 里的 class/text 走属性语义，其余当 attribute（含 aria-*）。
 * 常用布尔属性（value/checked/disabled/selected）走 DOM 属性，避免属性与状态不同步。
 */
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue
    if (key === 'class') node.className = value
    else if (key === 'text') node.textContent = value
    else if (key === 'value') node.value = value
    else if (key === 'checked') node.checked = Boolean(value)
    else if (key === 'selected') node.selected = Boolean(value)
    else if (key === 'disabled') node.disabled = Boolean(value)
    else if (key === 'hidden') node.hidden = Boolean(value)
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value)
    else node.setAttribute(key, value === true ? '' : String(value))
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child === null || child === undefined) continue
    node.append(child instanceof Node ? child : document.createTextNode(String(child)))
  }
  return node
}

export function svgNode(markup) {
  const template = document.createElement('template')
  template.innerHTML = markup.trim()
  return template.content.firstElementChild
}

export function avatar(botId, size) {
  const wrap = el('span', { class: `avatar avatar-${size}`, 'data-bot-id': botId })
  wrap.append(svgNode(glyphSvg(botId, { size })))
  return wrap
}

/**
 * Bot 的头像：有合法上传图片就显示图片，否则退回程序化小鸟（docs/design/bot-avatar.md）。
 * dataURL 先过 isAvatarDataUrl（类型/大小/base64 形状），不是用户给什么就塞什么。
 * 小鸟按 id 稳定生成；paused 状态整只去饱和（与 bot-identity §7 的「已暂停」一致）。
 */
export function botAvatar(bot, size = 24, options = {}) {
  const id = typeof bot === 'string' ? bot : bot && typeof bot.id === 'string' ? bot.id : ''
  const harness = botHarnessKind(bot)
  if (harness !== '') {
    const label = bot && typeof bot === 'object' && typeof bot.name === 'string' ? bot.name : ''
    const wrap = el('span', {
      class: `avatar avatar-${size} avatar-harness harness-${harness}${options.round === true ? ' avatar-round' : ''}${options.primary === true ? ' is-primary' : ''}`,
      'data-bot-id': id,
      'data-harness': harness,
      ...(label === '' ? {} : { 'aria-label': label }),
      title: label === '' ? undefined : label,
    })
    wrap.append(svgNode(harnessAvatarSvg(harness, size, label, options.round === true)))
    if (options.primary === true) wrap.append(el('span', { class: 'avatar-star', 'aria-hidden': 'true', text: '★' }))
    return wrap
  }
  if (options.round === true) {
    const label = bot && typeof bot === 'object' && typeof bot.name === 'string' ? bot.name : 'Bot 头像'
    const wrap = el('span', {
      class: `avatar avatar-${size} avatar-round${options.primary === true ? ' is-primary' : ''}`,
      'data-bot-id': id,
      'aria-label': label,
    })
    wrap.append(svgNode(roundBirdSvg(id, { size, primary: options.primary === true })))
    if (options.primary === true) wrap.append(el('span', { class: 'avatar-star', 'aria-hidden': 'true', text: '★' }))
    return wrap
  }
  const avatarValue = bot && typeof bot === 'object' && bot.avatar && typeof bot.avatar === 'object' ? bot.avatar : null
  const image = avatarValue && typeof avatarValue.image === 'string' ? avatarValue.image : ''
  if (!isAvatarDataUrl(image)) {
    const state = options.state ?? (bot && typeof bot === 'object' && bot.status === 'paused' ? 'paused' : 'idle')
    const label = bot && typeof bot === 'object' && typeof bot.name === 'string' ? bot.name : 'Bot 头像'
    const wrap = el('span', { class: `avatar avatar-${size}`, 'data-bot-id': id })
    wrap.append(
      svgNode(
        birdSvg(id, {
          size,
          state,
          label,
          ...(options.accessory === undefined ? {} : { accessory: options.accessory }),
          ...(bot && typeof bot === 'object' && typeof bot.role === 'string' && bot.role !== '' ? { role: bot.role } : {})
        })
      )
    )
    return wrap
  }
  const wrap = el('span', { class: `avatar avatar-${size}`, 'data-bot-id': id })
  wrap.append(
    el('img', {
      class: 'avatar-img',
      src: image,
      alt: '',
      width: size,
      height: size,
      decoding: 'async',
    })
  )
  return wrap
}

export function clear(node) {
  if (node) node.replaceChildren()
}

// ---------------------------------------------------------------------------
// Harness avatar
//
// Each Bot keeps a stable harness mark rather than a generic bird when its
// runtime is known. These are deliberately simple, generic marks (not copied
// vendor logos): whale/wave = DSH, starburst = Claude Code, hex knot = Codex,
// X = Grok Build, H/caduceus = Hermes, terminal = Native Relay.

const HARNESS_BADGES = {
  dsh: { bg: '#4263eb', ink: '#f7f6f1', label: 'DSH' },
  'claude-code': { bg: '#c96b4f', ink: '#fff9f2', label: 'Claude Code' },
  codex: { bg: '#1c1c1c', ink: '#f7f6f1', label: 'Codex' },
  'grok-build': { bg: '#171717', ink: '#f7f6f1', label: 'Grok Build' },
  hermes: { bg: '#6650d8', ink: '#f7f6f1', label: 'Hermes' },
  native: { bg: '#6f6a60', ink: '#f7f6f1', label: 'Native Relay' },
}

function harnessGlyph(kind, fill) {
  switch (kind) {
    case 'dsh':
      // whale body + tail, simple enough to read at 16px
      return `<path d="M19 55c7-16 21-25 37-20 8 2 14 8 17 16-10-4-18-3-24 4-6 7-16 10-30 6z" fill="${fill}"/><circle cx="58" cy="43" r="2.6" fill="#4263eb"/><path d="M26 62c7 6 18 8 29 4" fill="none" stroke="${fill}" stroke-width="3" stroke-linecap="round" opacity=".65"/>`
    case 'claude-code':
      // Anthropic-ish starburst: eight spokes from a quiet center
      return `<g stroke="${fill}" stroke-width="4" stroke-linecap="round"><path d="M48 18v60M18 48h60M27 27l42 42M69 27L27 69"/></g><circle cx="48" cy="48" r="7" fill="${fill}"/>`
    case 'codex':
      // hex knot
      return `<path d="M48 17 75 32v32L48 79 21 64V32z" fill="none" stroke="${fill}" stroke-width="4"/><path d="M48 31 61 39v18l-13 8-13-8V39z" fill="none" stroke="${fill}" stroke-width="3"/>`
    case 'grok-build':
      return `<path d="M25 24l46 48M71 24 25 72" fill="none" stroke="${fill}" stroke-width="7" stroke-linecap="square"/>`
    case 'hermes':
      // H with wings
      return `<path d="M31 29v38M65 29v38M31 48h34" fill="none" stroke="${fill}" stroke-width="5" stroke-linecap="round"/><path d="M31 36 18 30M65 36l13-6M31 59 18 65M65 59l13 6" fill="none" stroke="${fill}" stroke-width="3" stroke-linecap="round" opacity=".8"/>`
    case 'native':
      return `<path d="M30 38 20 48l10 10M66 38l10 10-10 10M41 62l14-28" fill="none" stroke="${fill}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>`
    default:
      return ''
  }
}

/** Return the recognized harness kind from a Bot shape, if any. */
export function botHarnessKind(bot) {
  const kind = bot && typeof bot === 'object' ? bot.runtimeKind : ''
  if (typeof kind !== 'string') return ''
  if (kind === 'grok-build' || kind === 'claude-code' || kind === 'codex' || kind === 'dsh' || kind === 'hermes') return kind
  if (kind === 'native' || kind === 'native-relay') return 'native'
  return ''
}

export function harnessAvatarSvg(kind, size = 24, label = '', round = false) {
  const badge = HARNESS_BADGES[kind]
  if (badge === undefined) return ''
  const safe = String(label).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
  const a11y = safe === '' ? ' role="presentation" aria-hidden="true"' : ` role="img" aria-label="${safe}"`
  const rect = round ? `<circle cx="48" cy="48" r="46" fill="${badge.bg}"/>` : `<rect width="96" height="96" rx="22" fill="${badge.bg}"/>`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 96 96"${a11y}>${rect}${harnessGlyph(kind, badge.ink)}</svg>`
}
