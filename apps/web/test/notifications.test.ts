import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  approvalNotificationBody,
  newApprovalIds,
  notificationPermission,
  notificationUiState,
  pendingApprovalIds,
  permissionDeniedText,
  planApprovalNotification,
  readNotificationPref,
  requestNotificationPermission,
  shouldSystemNotify,
  supportsNotifications,
  writeNotificationPref,
} from '../lib/notifications.js'

function fakeEnv(permission: string, requestResult: string = permission) {
  function FakeNotification() {}
  FakeNotification.permission = permission
  FakeNotification.requestPermission = (callback?: (value: string) => void) => {
    if (typeof callback === 'function') callback(requestResult)
    return Promise.resolve(requestResult)
  }
  return { Notification: FakeNotification }
}

function memoryStorage() {
  const data = new Map<string, string>()
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  }
}

test('权限探测：支持 / 不支持与四种状态', () => {
  assert.equal(supportsNotifications({}), false)
  assert.equal(notificationPermission({}), 'unsupported')
  for (const value of ['granted', 'denied', 'default']) {
    assert.equal(supportsNotifications(fakeEnv(value)), true)
    assert.equal(notificationPermission(fakeEnv(value)), value)
  }
  // 非法值按 default，不把未知状态当成已授权。
  function WeirdNotification() {}
  WeirdNotification.permission = 'weird'
  assert.equal(notificationPermission({ Notification: WeirdNotification }), 'default')
})

test('requestPermission 只返回白名单状态（Promise 与回调都兼容）', async () => {
  assert.equal(await requestNotificationPermission(fakeEnv('granted')), 'granted')
  assert.equal(await requestNotificationPermission(fakeEnv('denied')), 'denied')
  assert.equal(await requestNotificationPermission({}), 'unsupported')

  function LegacyNotification() {}
  LegacyNotification.permission = 'default'
  LegacyNotification.requestPermission = (callback: (value: string) => void) => {
    callback('granted')
  }
  assert.equal(await requestNotificationPermission({ Notification: LegacyNotification }), 'granted')
})

test('开关偏好读写：异常存储按关闭处理，不抛', () => {
  const storage = memoryStorage()
  assert.equal(readNotificationPref(storage), false)
  writeNotificationPref(true, storage)
  assert.equal(readNotificationPref(storage), true)
  writeNotificationPref(false, storage)
  assert.equal(readNotificationPref(storage), false)
  assert.equal(readNotificationPref({ getItem: () => { throw new Error('nope') } }), false)
  assert.doesNotThrow(() => writeNotificationPref(true, { setItem: () => { throw new Error('nope') } }))
})

test('待审批 id：只认 pending、非空 id，并去重', () => {
  const rows = [
    { id: 'a', status: 'pending' },
    { id: 'a', status: 'pending' },
    { id: 'b', status: 'approved' },
    { id: '', status: 'pending' },
    { id: 'c', status: 'pending' },
    null,
  ]
  assert.deepEqual(pendingApprovalIds(rows), ['a', 'c'])
  assert.deepEqual(newApprovalIds(['a'], rows), ['c'])
  assert.deepEqual(newApprovalIds([], []), [])
})

test('系统通知条件：开关/权限/隐藏/有新审批，缺一不可', () => {
  const base = { enabled: true, permission: 'granted', hidden: true, newIds: ['a'] }
  assert.equal(shouldSystemNotify(base), true)
  assert.equal(shouldSystemNotify({ ...base, enabled: false }), false)
  assert.equal(shouldSystemNotify({ ...base, permission: 'default' }), false)
  assert.equal(shouldSystemNotify({ ...base, permission: 'denied' }), false)
  assert.equal(shouldSystemNotify({ ...base, hidden: false }), false)
  assert.equal(shouldSystemNotify({ ...base, newIds: [] }), false)
})

test('通知正文：一条固定文案，多条带数量', () => {
  assert.equal(approvalNotificationBody(1), '有新的审批需要你')
  assert.equal(approvalNotificationBody(3), '有 3 条新的审批需要你')
  assert.equal(approvalNotificationBody(0), '有新的审批需要你')
})

test('通知计划：首轮只建基线，不提醒', () => {
  const plan = planApprovalNotification({
    knownIds: new Set(),
    notifiedIds: new Set(),
    ready: false,
    approvals: [{ id: 'a', status: 'pending' }],
    enabled: true,
    permission: 'granted',
    hidden: true,
  })
  assert.deepEqual(plan.freshIds, [])
  assert.equal(plan.notify, false)
  assert.deepEqual([...plan.knownIds], ['a'])
  assert.deepEqual([...plan.notifiedIds], [])
})

test('通知计划：页面隐藏且 pending 增加时提醒一次，同一批不重复', () => {
  const first = planApprovalNotification({
    knownIds: new Set(['a']),
    notifiedIds: new Set(),
    ready: true,
    approvals: [
      { id: 'a', status: 'pending' },
      { id: 'b', status: 'pending' },
    ],
    enabled: true,
    permission: 'granted',
    hidden: true,
  })
  assert.deepEqual(first.freshIds, ['b'])
  assert.equal(first.notify, true)
  assert.equal(first.body, '有新的审批需要你')

  const again = planApprovalNotification({
    knownIds: first.knownIds,
    notifiedIds: first.notifiedIds,
    ready: first.ready,
    approvals: [
      { id: 'a', status: 'pending' },
      { id: 'b', status: 'pending' },
    ],
    enabled: true,
    permission: 'granted',
    hidden: true,
  })
  assert.deepEqual(again.freshIds, [])
  assert.equal(again.notify, false)
})

test('通知计划：页面可见时记账但不弹系统通知', () => {
  const visible = planApprovalNotification({
    knownIds: new Set(['a']),
    notifiedIds: new Set(),
    ready: true,
    approvals: [
      { id: 'a', status: 'pending' },
      { id: 'b', status: 'pending' },
      { id: 'c', status: 'pending' },
    ],
    enabled: true,
    permission: 'granted',
    hidden: false,
  })
  assert.deepEqual(visible.freshIds, ['b', 'c'])
  assert.equal(visible.notify, false)
  assert.equal(visible.body, '')

  // 之后再隐藏也不会为同一批补弹。
  const later = planApprovalNotification({
    knownIds: visible.knownIds,
    notifiedIds: visible.notifiedIds,
    ready: visible.ready,
    approvals: [{ id: 'b', status: 'pending' }],
    enabled: true,
    permission: 'granted',
    hidden: true,
  })
  assert.deepEqual(later.freshIds, [])
  assert.equal(later.notify, false)
})

test('通知计划：未授权/未开启时不弹，但仍记基线', () => {
  for (const options of [
    { enabled: false, permission: 'granted' },
    { enabled: true, permission: 'denied' },
    { enabled: true, permission: 'default' },
  ]) {
    const plan = planApprovalNotification({
      knownIds: new Set(['a']),
      notifiedIds: new Set(),
      ready: true,
      approvals: [{ id: 'a', status: 'pending' }, { id: 'b', status: 'pending' }],
      hidden: true,
      ...options,
    })
    assert.deepEqual(plan.freshIds, ['b'])
    assert.equal(plan.notify, false)
  }
})

test('设置页开关状态：不支持 / 被拒绝 / 已开启 / 默认', () => {
  const unsupported = notificationUiState({ supported: false, permission: 'unsupported', enabled: false })
  assert.equal(unsupported.disabled, true)
  assert.equal(unsupported.checked, false)

  const denied = notificationUiState({ supported: true, permission: 'denied', enabled: true })
  assert.equal(denied.disabled, true)
  assert.equal(denied.checked, false)
  assert.equal(denied.kind, 'error')

  const on = notificationUiState({ supported: true, permission: 'granted', enabled: true })
  assert.deepEqual([on.checked, on.disabled, on.kind], [true, false, 'ok'])

  const off = notificationUiState({ supported: true, permission: 'default', enabled: false })
  assert.deepEqual([off.checked, off.disabled, off.kind], [false, false, 'muted'])
})

test('权限被拒绝/忽略的文案不假装成功', () => {
  assert.match(permissionDeniedText('denied'), /拒绝/)
  assert.match(permissionDeniedText('default'), /没有获得/)
  assert.match(permissionDeniedText('unsupported'), /不支持/)
})
