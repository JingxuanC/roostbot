// 可访问性小工具：表单错误关联、焦点陷阱。
// 独立成文件，避免 lib/ui.js 继续变厚；只做 DOM，不依赖业务。

let formErrorSeq = 0

export function nextFormErrorId() {
  return `form-error-${++formErrorSeq}`
}

/** 把校验错误关联到具体控件：aria-invalid + aria-describedby，读屏能知道哪一项错了。 */
export function setFieldInvalid(controls, invalid, errorNode) {
  if (!errorNode) return
  const list = Array.isArray(controls) ? controls : [controls]
  const describedBy = errorNode.id
  for (const control of list) {
    if (!control) continue
    if (invalid) {
      control.setAttribute('aria-invalid', 'true')
      if (describedBy) {
        const tokens = new Set((control.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean))
        tokens.add(describedBy)
        control.setAttribute('aria-describedby', [...tokens].join(' '))
      }
    } else {
      control.removeAttribute('aria-invalid')
      if (describedBy) {
        const tokens = (control.getAttribute('aria-describedby') || '')
          .split(/\s+/)
          .filter((token) => token && token !== describedBy)
        if (tokens.length > 0) control.setAttribute('aria-describedby', tokens.join(' '))
        else control.removeAttribute('aria-describedby')
      }
    }
  }
}

/** 清掉同一个表单里的错误关联（一次提交开始前调用）。 */
export function clearFieldInvalid(errorNode) {
  if (!errorNode) return
  const root = errorNode.closest('form') || errorNode.parentElement
  if (!root) return
  for (const control of root.querySelectorAll('[aria-invalid="true"]')) {
    setFieldInvalid(control, false, errorNode)
  }
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), iframe, [tabindex]:not([tabindex="-1"])'

/** 容器里当前可 Tab 到的元素（跳过 hidden / aria-hidden 子树）。 */
export function focusableElements(root) {
  if (!root) return []
  return [...root.querySelectorAll(FOCUSABLE)].filter((node) => {
    if (node.closest('[hidden]') || node.getAttribute('aria-hidden') === 'true') return false
    return typeof node.getClientRects !== 'function' || node.getClientRects().length > 0
  })
}

/**
 * 简单焦点陷阱：Tab / Shift+Tab 在容器内循环；焦点意外落到容器外时拉回第一个。
 * 返回 true 表示事件已被处理（调用方应已 preventDefault）。
 */
export function trapTabKey(event, root) {
  if (!root || event.key !== 'Tab' || event.defaultPrevented) return false
  const items = focusableElements(root)
  if (items.length === 0) {
    event.preventDefault()
    if (typeof root.focus === 'function') root.focus()
    return true
  }
  const first = items[0]
  const last = items[items.length - 1]
  const active = document.activeElement
  if (!root.contains(active)) {
    event.preventDefault()
    first.focus()
    return true
  }
  if (event.shiftKey && (active === first || active === root)) {
    event.preventDefault()
    last.focus()
    return true
  }
  if (!event.shiftKey && active === last) {
    event.preventDefault()
    first.focus()
    return true
  }
  return false
}
