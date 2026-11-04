// 最薄的 DOM 工具：建元素、内联 SVG、头像。
// 所有渲染都走这里：用户输入只进 textContent / value / 属性，绝不拼 innerHTML。
// （svgNode 是唯一 innerHTML，输入是 lib/glyph.js 以固定算法生成的常量标记。）

import { glyphSvg } from './glyph.js'

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
  const wrap = el('span', { class: `avatar avatar-${size}` })
  wrap.append(svgNode(glyphSvg(botId, { size })))
  return wrap
}

export function clear(node) {
  if (node) node.replaceChildren()
}
