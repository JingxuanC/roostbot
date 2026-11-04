// 复用组件：按钮 / 卡片 / 字段（docs/build/wave3.md §D）。
//
// 与 lib/ui.js 的关系：ui.js 是早期 API（button(label, options)、field(label, control, options)），
// 已经有很多页面在用；这里统一成对象参数，供新页面使用。两者输出的类名与 DOM 结构一致，
// 所以换用不会产生视觉变化。
//
// 纪律：所有节点只经 lib/dom.js 的 el 创建，用户输入只进 textContent / 属性，绝不拼 innerHTML。

import { el } from './dom.js'

const BUTTON_VARIANTS = {
  primary: 'btn-primary',
  ghost: 'btn-ghost',
  outline: 'btn-outline',
  quiet: 'btn-quiet',
}

function classes(...parts) {
  return parts
    .flat()
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function listOf(value) {
  if (value === null || value === undefined) return []
  return Array.isArray(value) ? value : [value]
}

/**
 * 按钮。variant: primary | ghost | outline | quiet；size: 'sm'；block 占满一行。
 * 返回 <button>，默认 type="button"（避免在表单里意外提交）。
 */
export function button(options = {}) {
  const {
    label = '',
    variant = '',
    block = false,
    size = '',
    type = 'button',
    disabled = false,
    title = '',
    ariaLabel = '',
    onClick = null,
  } = options
  return el('button', {
    class: classes('btn', BUTTON_VARIANTS[variant] || '', block && 'btn-block', size === 'sm' && 'btn-sm'),
    type,
    text: label,
    disabled: Boolean(disabled),
    title: title || null,
    'aria-label': ariaLabel || null,
    onclick: typeof onClick === 'function' ? onClick : null,
  })
}

/**
 * 卡片：默认 <div class="page-card">。
 * 有 title 时在内容前加一行 .section-head（标题 + 可选 actions），否则直接放 children。
 */
export function card(options = {}) {
  const { title = '', children = [], className = '', actions = null } = options
  const node = el('div', { class: classes('page-card', className) })
  if (title !== '' || actions !== null) {
    const head = el('div', { class: 'section-head' })
    if (title !== '') head.append(el('h2', { class: 'section-title', text: title }))
    if (actions !== null) head.append(el('div', { class: 'section-actions' }, listOf(actions)))
    node.append(head)
  }
  for (const child of listOf(children)) {
    if (child === null || child === undefined) continue
    node.append(child)
  }
  return node
}

/**
 * 表单字段：label + control + 可选 hint。
 * label 的 for 默认取 control.id；显式 id 优先。required 只在文案后加「（必填）」，校验仍由页面做。
 */
export function field(options = {}) {
  const { label = '', control, hint = '', required = false, id = '', className = '' } = options
  if (control === null || control === undefined) {
    throw new TypeError('field 需要 control 节点')
  }
  const wrap = el('div', { class: classes('field', className) })
  if (label !== '') {
    wrap.append(
      el('label', {
        class: 'field-label',
        for: id || control.id || null,
        text: `${label}${required ? '（必填）' : ''}`,
      })
    )
  }
  wrap.append(control)
  if (hint !== '') wrap.append(el('p', { class: 'field-hint', text: hint }))
  return wrap
}
