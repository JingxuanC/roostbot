// 通知策略（docs/design/ui.md §1/§3.6，TODO 5.5.6）：只在「需要你」时提醒。
//
// 这里只放纯逻辑：权限状态、开关偏好的读写、审批 id 去重、文案。
// 真正调用 Notification API / DOM 的地方在 app.js 与 views/settings.js；
// 传进来的 env/storage 都可注入，node:test 不需要浏览器。

export const NOTIFICATION_TITLE = '需要你'

const PREF_KEY = 'roost.notifications.needs'

/** 浏览器是否提供 Notification 构造器。 */
export function supportsNotifications(env = globalThis) {
  return Boolean(env && typeof env.Notification === 'function')
}

/** 'granted' | 'denied' | 'default' | 'unsupported'。 */
export function notificationPermission(env = globalThis) {
  if (!supportsNotifications(env)) return 'unsupported'
  const value = env.Notification.permission
  if (value === 'granted' || value === 'denied' || value === 'default') return value
  return 'default'
}

/** 用户开关偏好（客户端本地；失败就当关闭，不阻塞设置页）。 */
export function readNotificationPref(storage = globalThis.localStorage) {
  try {
    return Boolean(storage && typeof storage.getItem === 'function' && storage.getItem(PREF_KEY) === '1')
  } catch {
    return false
  }
}

export function writeNotificationPref(enabled, storage = globalThis.localStorage) {
  try {
    if (storage && typeof storage.setItem === 'function') {
      storage.setItem(PREF_KEY, enabled ? '1' : '0')
    }
  } catch {
    // 隐私模式/配额满：开关只在本次会话生效，不报错。
  }
}

/**
 * 只有用户手势里调用（设置页 change 事件）。返回最终权限；
 * 老浏览器的回调式 requestPermission 也兼容。
 */
export function requestNotificationPermission(env = globalThis) {
  if (!supportsNotifications(env)) return Promise.resolve('unsupported')
  return new Promise((resolve) => {
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      resolve(value === 'granted' || value === 'denied' || value === 'default' ? value : notificationPermission(env))
    }
    try {
      const result = env.Notification.requestPermission(done)
      if (result && typeof result.then === 'function') result.then(done, () => done(notificationPermission(env)))
    } catch {
      done(notificationPermission(env))
    }
  })
}

/** 待审批 id（只认 status=pending 且有非空 id；按出现顺序去重）。 */
export function pendingApprovalIds(approvals) {
  const ids = []
  const seen = new Set()
  for (const item of Array.isArray(approvals) ? approvals : []) {
    if (!item || typeof item !== 'object') continue
    if (item.status !== 'pending') continue
    const id = typeof item.id === 'string' ? item.id.trim() : ''
    if (id === '' || seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }
  return ids
}

/** 相对上一轮新出现的待审批 id。 */
export function newApprovalIds(previousIds, approvals) {
  const previous = new Set(Array.isArray(previousIds) ? previousIds : [])
  return pendingApprovalIds(approvals).filter((id) => !previous.has(id))
}

/** 是否该弹系统通知：开关开、权限有、页面隐藏、且有新的待审批。 */
export function shouldSystemNotify({ enabled, permission, hidden, newIds }) {
  return (
    enabled === true &&
    permission === 'granted' &&
    hidden === true &&
    Array.isArray(newIds) &&
    newIds.length > 0
  )
}

/** 通知正文：一条用固定文案，多条给数量，不制造噪音。 */
export function approvalNotificationBody(count) {
  const value = Number.isInteger(count) && count > 0 ? count : 1
  return value === 1 ? '有新的审批需要你' : `有 ${value} 条新的审批需要你`
}

/**
 * 一轮审批快照的通知计划。
 * - 第一轮（ready=false）只建立基线，不提醒；
 * - 之后新出现的 id 记入 notifiedIds，同一批只提醒一次；
 * - 页面可见时 freshIds 仍然记账，但不弹系统通知（只用应用内角标）。
 *
 * @returns {{pendingIds: string[], freshIds: string[], knownIds: Set<string>,
 *            notifiedIds: Set<string>, ready: boolean, notify: boolean, body: string}}
 */
export function planApprovalNotification({
  knownIds,
  notifiedIds,
  ready,
  approvals,
  enabled,
  permission,
  hidden,
}) {
  const pendingIds = pendingApprovalIds(approvals)
  const known = new Set(Array.isArray(knownIds) ? knownIds : knownIds instanceof Set ? knownIds : [])
  const notified = new Set(
    Array.isArray(notifiedIds) ? notifiedIds : notifiedIds instanceof Set ? notifiedIds : []
  )
  const freshIds = ready ? pendingIds.filter((id) => !known.has(id) && !notified.has(id)) : []
  for (const id of pendingIds) known.add(id)
  for (const id of freshIds) notified.add(id)
  const notify = shouldSystemNotify({ enabled, permission, hidden, newIds: freshIds })
  return {
    pendingIds,
    freshIds,
    knownIds: known,
    notifiedIds: notified,
    ready: true,
    notify,
    body: notify ? approvalNotificationBody(freshIds.length) : '',
  }
}

/** 设置页开关的展示模型。enabled 是本地偏好，permission 是浏览器权限。 */
export function notificationUiState({ supported, permission, enabled }) {
  if (!supported) {
    return {
      supported: false,
      checked: false,
      disabled: true,
      status: '此浏览器不支持系统通知；应用内角标仍会显示。',
      kind: 'muted',
    }
  }
  if (permission === 'denied') {
    return {
      supported: true,
      checked: false,
      disabled: true,
      status: '浏览器已拒绝通知权限。请在浏览器站点设置里重新允许，然后刷新页面再开启。',
      kind: 'error',
    }
  }
  if (enabled === true && permission === 'granted') {
    return {
      supported: true,
      checked: true,
      disabled: false,
      status: '已开启：页面隐藏且出现新的待审批时提醒；点通知会打开「需要你」。',
      kind: 'ok',
    }
  }
  return {
    supported: true,
    checked: false,
    disabled: false,
    status: '开启后，页面隐藏且出现新的待审批时会提醒；页面可见时只用应用内角标。',
    kind: 'muted',
  }
}

/** 权限请求被拒绝/忽略时的说明。 */
export function permissionDeniedText(permission) {
  if (permission === 'unsupported') return '此浏览器不支持系统通知；应用内角标仍会显示。'
  if (permission === 'denied') return '浏览器拒绝了通知权限；应用内角标仍会显示。可在站点设置里重新允许。'
  return '这次没有获得通知权限，通知未开启；应用内角标仍会显示。'
}
