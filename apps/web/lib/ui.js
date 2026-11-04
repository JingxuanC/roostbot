// 表单与状态组件的薄封装：统一标签/提示/错误的位置，避免每个页面各写一套。
// 只负责建 DOM；值校验与请求在 views 里做。

import { el } from './dom.js'

export function button(label, options = {}) {
  const variant = options.variant === 'primary' ? 'btn-primary' : options.variant === 'ghost' ? 'btn-ghost' : options.variant === 'outline' ? 'btn-outline' : ''
  return el('button', {
    class: `btn ${variant} ${options.block ? 'btn-block' : ''} ${options.size === 'sm' ? 'btn-sm' : ''}`.replace(/\s+/g, ' ').trim(),
    type: options.type || 'button',
    text: label,
    disabled: options.disabled,
    title: options.title,
    onclick: options.onClick,
  })
}

export function linkButton(label, href, options = {}) {
  const variant = options.variant === 'primary' ? 'btn-primary' : options.variant === 'ghost' ? 'btn-ghost' : options.variant === 'outline' ? 'btn-outline' : ''
  return el('a', {
    class: `btn ${variant} ${options.block ? 'btn-block' : ''}`.replace(/\s+/g, ' ').trim(),
    href,
    text: label,
    title: options.title,
  })
}

export function field(labelText, control, options = {}) {
  const wrap = el('div', { class: 'field' })
  if (labelText) {
    wrap.append(
      el('label', {
        class: 'field-label',
        for: options.id || control.id || undefined,
        text: `${labelText}${options.required ? '（必填）' : ''}`,
      })
    )
  }
  wrap.append(control)
  if (options.hint) wrap.append(el('p', { class: 'field-hint', text: options.hint }))
  return wrap
}

export function input(options = {}) {
  return el('input', {
    class: 'input',
    id: options.id,
    name: options.name,
    type: options.type || 'text',
    value: options.value ?? '',
    placeholder: options.placeholder,
    maxlength: options.maxlength,
    autocomplete: options.autocomplete || 'off',
    inputmode: options.inputmode,
    required: options.required,
    disabled: options.disabled,
    spellcheck: 'false',
  })
}

export function textarea(options = {}) {
  return el('textarea', {
    class: 'input textarea',
    id: options.id,
    name: options.name,
    rows: options.rows || 4,
    value: options.value ?? '',
    placeholder: options.placeholder,
    maxlength: options.maxlength,
    required: options.required,
    disabled: options.disabled,
    spellcheck: options.spellcheck || 'false',
  })
}

export function select(options = {}) {
  const node = el('select', { class: 'input select', id: options.id, name: options.name, disabled: options.disabled })
  setSelectOptions(node, options.options || [], options.value)
  return node
}

export function setSelectOptions(node, options, value) {
  node.replaceChildren()
  for (const option of options) {
    node.append(
      el('option', {
        value: option.value,
        text: option.label,
        disabled: option.disabled,
        selected: value !== undefined && option.value === value,
      })
    )
  }
  if (options.length === 0) node.append(el('option', { value: '', text: '（没有可选项）' }))
  if (value !== undefined && options.some((option) => option.value === value)) node.value = value
}

/** 单选组：返回 {node, getValue}；选项可带 description。 */
export function radioGroup(options = {}) {
  const group = el('fieldset', { class: 'field radio-group' })
  group.append(el('legend', { class: 'field-label', text: options.legend || '' }))
  const inputs = []
  for (const option of options.options || []) {
    const id = `${options.name}-${option.value}`
    const row = el('label', { class: 'radio-row', for: id })
    const control = el('input', {
      type: 'radio',
      id,
      name: options.name,
      value: option.value,
      checked: option.value === options.value,
      onchange: options.onChange,
    })
    inputs.push(control)
    row.append(control)
    const text = el('span', { class: 'radio-text' })
    text.append(el('span', { class: 'radio-label', text: option.label }))
    if (option.description) text.append(el('span', { class: 'radio-desc', text: option.description }))
    row.append(text)
    group.append(row)
  }
  if (options.hint) group.append(el('p', { class: 'field-hint', text: options.hint }))
  return {
    node: group,
    getValue: () => inputs.find((control) => control.checked)?.value ?? '',
  }
}

/**
 * 多选清单：items [{value,label,description,checked,disabled,leading}]
 * leading 是可选的行首节点（例如头像）。返回 {node, getValues}。
 */
export function checkboxList(options = {}) {
  const group = el('fieldset', { class: 'field checkbox-list' })
  group.append(el('legend', { class: 'field-label', text: options.legend || '' }))
  const body = el('div', { class: 'check-rows' })
  const inputs = []
  for (const item of options.items || []) {
    const row = el('label', { class: `check-row${item.disabled ? ' is-disabled' : ''}` })
    const control = el('input', {
      type: 'checkbox',
      name: options.name,
      value: item.value,
      checked: item.checked,
      disabled: item.disabled,
      onchange: options.onChange,
    })
    inputs.push(control)
    row.append(control)
    if (item.leading) row.append(item.leading)
    const text = el('span', { class: 'check-text' })
    text.append(el('span', { class: 'check-label', text: item.label }))
    if (item.description) text.append(el('span', { class: 'check-desc', text: item.description }))
    row.append(text)
    body.append(row)
  }
  group.append(body)
  if (options.hint) group.append(el('p', { class: 'field-hint', text: options.hint }))
  return {
    node: group,
    getValues: () => inputs.filter((control) => control.checked).map((control) => control.value),
  }
}

export function inlineError() {
  return el('p', { class: 'form-error', role: 'alert', hidden: true })
}

export function setError(node, message) {
  if (!node) return
  if (!message) {
    node.textContent = ''
    node.hidden = true
    return
  }
  node.textContent = message
  node.hidden = false
}

export function statusLine(message = '') {
  return el('p', { class: 'form-status', role: 'status', text: message, hidden: message === '' })
}

export function setStatus(node, message, kind = 'ok') {
  if (!node) return
  node.textContent = message
  node.hidden = message === ''
  node.classList.toggle('is-error', kind === 'error')
}

export function badge(text, kind = '') {
  return el('span', { class: `pill ${kind ? `pill-${kind}` : ''}`.trim(), text })
}

export function section(title, children, options = {}) {
  const wrap = el('section', { class: 'form-section' })
  const head = el('div', { class: 'section-head' })
  head.append(el('h2', { class: 'section-title', text: title }))
  if (options.actions) head.append(el('div', { class: 'section-actions' }, options.actions))
  wrap.append(head)
  if (options.description) wrap.append(el('p', { class: 'section-desc', text: options.description }))
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child) wrap.append(child)
  }
  return wrap
}

export function pageHeader(title, options = {}) {
  const head = el('header', { class: 'page-title-head' })
  if (options.back) {
    head.append(el('a', { class: 'back-link', href: options.back.href, text: `← ${options.back.label}` }))
  }
  const top = el('div', { class: 'page-title-row' })
  top.append(el('h1', { class: 'page-title', text: title }))
  if (options.actions) top.append(el('div', { class: 'page-title-actions' }, options.actions))
  head.append(top)
  if (options.subtitle) head.append(el('p', { class: 'page-subtitle muted', text: options.subtitle }))
  return head
}

export function loading(text, detail = '') {
  const wrap = el('div', { class: 'state state-loading', role: 'status' })
  wrap.append(el('span', { class: 'spinner', 'aria-hidden': 'true' }))
  wrap.append(el('p', { class: 'state-title', text }))
  if (detail) wrap.append(el('p', { class: 'state-body muted', text: detail }))
  return wrap
}

export function emptyState(options = {}) {
  const wrap = el('div', { class: 'state state-empty' })
  wrap.append(el('h2', { class: 'state-title', text: options.title || '' }))
  if (options.body) wrap.append(el('p', { class: 'state-body muted', text: options.body }))
  if (options.action || options.secondary) {
    wrap.append(el('div', { class: 'state-actions' }, [options.action, options.secondary].filter(Boolean)))
  }
  return wrap
}

function errorText(error) {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === 'string' && error) return error
  return '未知错误'
}

export function errorState(options = {}) {
  const error = options.error
  const missing = Boolean(error && error.status === 404)
  const title = options.title || (missing ? '接口还没有上线' : '载入失败')
  const wrap = el('div', { class: 'state state-error', role: 'alert' })
  wrap.append(el('h2', { class: 'state-title', text: title }))
  wrap.append(el('p', { class: 'state-body', text: options.message || errorText(error) }))
  if (missing) {
    wrap.append(
      el('p', {
        class: 'state-detail muted',
        text: '控制面还没有实现这个接口；界面不会假装成功。等 API 上线后点「重试」即可。',
      })
    )
  }
  const actions = []
  if (options.onRetry) actions.push(button('重试', { variant: 'ghost', onClick: options.onRetry }))
  if (options.onPair) actions.push(linkButton('去配对', '#/', { variant: 'primary' }))
  if (actions.length) wrap.append(el('div', { class: 'state-actions' }, actions))
  return wrap
}

export function setBusy(node, busy, label) {
  if (!node) return
  if (busy) {
    if (label) {
      if (!node.dataset.label) node.dataset.label = node.textContent
      node.textContent = label
    }
  } else if (node.dataset.label) {
    // 恢复忙碌前的文案；不恢复的话按钮会永远停在「保存中…」。
    node.textContent = node.dataset.label
  }
  node.disabled = busy
  node.setAttribute('aria-busy', String(busy))
}
