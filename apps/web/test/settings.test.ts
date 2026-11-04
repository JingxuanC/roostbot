import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  canManageMembers,
  canRevokeDevice,
  deviceErrorText,
  deviceRows,
  deviceStatus,
  expiryRelative,
  inferCurrentAccountId,
  isSettingsForbidden,
  isSettingsNotReady,
  lastSeenLabel,
  memberErrorText,
  memberRows,
  platformLabel,
  roleBadge,
  roleLabel,
  roleOptions,
  settingsTimeLabel,
} from '../lib/settings.js'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const NOW = new Date(2026, 0, 1, 0, 0, 0).getTime()

test('角色文案与徽章：owner/admin/member/viewer 都有中文名', () => {
  assert.equal(roleLabel('owner'), '所有者')
  assert.equal(roleLabel('admin'), '管理员')
  assert.equal(roleLabel('member'), '成员')
  assert.equal(roleLabel('viewer'), '只读')
  assert.equal(roleLabel(''), '未知角色')
  assert.equal(roleLabel('auditor'), 'auditor')

  assert.deepEqual(roleBadge('owner'), { role: 'owner', label: '所有者', kind: 'accent' })
  assert.deepEqual(roleBadge('admin'), { role: 'admin', label: '管理员', kind: 'warn' })
  assert.deepEqual(roleBadge('member'), { role: 'member', label: '成员', kind: 'ok' })
  assert.deepEqual(roleBadge('viewer'), { role: 'viewer', label: '只读', kind: '' })
  assert.deepEqual(roleBadge(''), { role: '', label: '未知角色', kind: '' })
})

test('角色下拉顺序固定为 owner/admin/member/viewer', () => {
  assert.deepEqual(
    roleOptions().map((option) => option.value),
    ['owner', 'admin', 'member', 'viewer']
  )
  assert.deepEqual(
    roleOptions().map((option) => option.label),
    ['所有者', '管理员', '成员', '只读']
  )
})

test('只有 owner/admin 能管理成员', () => {
  assert.equal(canManageMembers('owner'), true)
  assert.equal(canManageMembers('admin'), true)
  assert.equal(canManageMembers('member'), false)
  assert.equal(canManageMembers('viewer'), false)
  assert.equal(canManageMembers(''), false)
  assert.equal(canManageMembers(undefined), false)
})

test('成员行：按加入时间升序、补角色徽章与「你」标记', () => {
  const members = [
    {
      accountId: 'acc_b',
      role: 'member',
      invitedBy: 'acc_a',
      createdAt: new Date(2026, 0, 2, 3, 4).getTime(),
    },
    {
      accountId: 'acc_a',
      role: 'owner',
      invitedBy: null,
      createdAt: new Date(2026, 0, 1, 1, 1).getTime(),
    },
    {
      accountId: 'acc_c',
      role: 'admin',
      invitedBy: 'acc_a',
      createdAt: new Date(2026, 0, 3, 5, 6).getTime(),
    },
  ]

  const view = memberRows(members, { currentAccountId: 'acc_a' })
  assert.equal(view.count, 3)
  assert.equal(view.ownerCount, 1)
  assert.deepEqual(
    view.rows.map((row) => row.accountId),
    ['acc_a', 'acc_b', 'acc_c']
  )

  const current = view.rows[0]
  assert.equal(current.roleLabel, '所有者')
  assert.equal(current.roleKind, 'accent')
  assert.equal(current.isCurrent, true)
  assert.equal(current.isLastOwner, true)
  assert.equal(current.invitedBy, '')
  assert.equal(current.joinedAtLabel, '2026-01-01 01:01')

  assert.equal(view.rows[1].isCurrent, false)
  assert.equal(view.rows[1].invitedBy, 'acc_a')
  assert.equal(view.rows[2].isLastOwner, false)
})

test('成员行：多个 owner 时谁都不是「最后一个 owner」', () => {
  const members = [
    { accountId: 'acc_a', role: 'owner', createdAt: 1 },
    { accountId: 'acc_b', role: 'owner', createdAt: 2 },
  ]
  const view = memberRows(members, {})
  assert.equal(view.ownerCount, 2)
  assert.deepEqual(
    view.rows.map((row) => row.isLastOwner),
    [false, false]
  )
})

test('成员行：坏数据不抛异常，也不显示 undefined', () => {
  const view = memberRows([null, 'oops', { accountId: 'acc_x' }], {})
  assert.equal(view.count, 1)
  assert.equal(view.rows[0].roleLabel, '未知角色')
  assert.equal(view.rows[0].joinedAtLabel, '时间未知')
  assert.equal(view.rows[0].invitedBy, '')

  assert.deepEqual(memberRows(undefined, {}), { rows: [], count: 0, ownerCount: 0 })
})

test('当前账号推断：后端 isCurrent 优先于角色唯一性', () => {
  const members = [
    { accountId: 'acc_a', role: 'owner' },
    { accountId: 'acc_b', role: 'owner' },
    { accountId: 'acc_c', role: 'member', isCurrent: true },
  ]
  assert.equal(inferCurrentAccountId(members, 'owner'), 'acc_c')
})

test('当前账号推断：角色在列表里唯一时才认，多个同角色不猜', () => {
  assert.equal(
    inferCurrentAccountId(
      [
        { accountId: 'acc_a', role: 'owner' },
        { accountId: 'acc_b', role: 'member' },
      ],
      'owner'
    ),
    'acc_a'
  )
  assert.equal(
    inferCurrentAccountId(
      [
        { accountId: 'acc_a', role: 'member' },
        { accountId: 'acc_b', role: 'member' },
      ],
      'member'
    ),
    ''
  )
  assert.equal(inferCurrentAccountId([{ accountId: 'acc_a', role: 'owner' }], ''), '')
  assert.equal(inferCurrentAccountId(undefined, 'owner'), '')
})

test('到期相对时间：过期 / 分钟 / 小时 / 天', () => {
  assert.equal(expiryRelative(NOW + 29 * DAY, NOW), '29 天后到期')
  assert.equal(expiryRelative(NOW + 2 * HOUR, NOW), '2 小时后到期')
  assert.equal(expiryRelative(NOW + 5 * MINUTE, NOW), '5 分钟后到期')
  assert.equal(expiryRelative(NOW + 30_000, NOW), '不到 1 分钟后到期')
  assert.equal(expiryRelative(NOW - 1, NOW), '已过期')
  assert.equal(expiryRelative(undefined, NOW), '时间未知')
  assert.equal(expiryRelative('not-a-date', NOW), '时间未知')
})

test('最近活跃：缺失就是「从未活跃」，不用当前时间冒充', () => {
  assert.equal(lastSeenLabel(undefined, NOW), '从未活跃')
  assert.equal(lastSeenLabel(0, NOW), '从未活跃')
  assert.equal(lastSeenLabel(NOW - 30_000, NOW), '刚刚')
  assert.equal(lastSeenLabel(NOW - 5 * MINUTE, NOW), '5 分钟前')
  assert.equal(lastSeenLabel(NOW - 3 * HOUR, NOW), '3 小时前')
  assert.equal(lastSeenLabel(NOW - 2 * DAY, NOW), '2 天前')
})

test('平台文案：未知平台原样显示', () => {
  assert.equal(platformLabel('web'), '浏览器')
  assert.equal(platformLabel('desktop'), '桌面端')
  assert.equal(platformLabel('cli'), '命令行')
  assert.equal(platformLabel(''), '未知平台')
  assert.equal(platformLabel('tv'), 'tv')
})

test('设备状态：吊销优先于当前设备', () => {
  assert.deepEqual(deviceStatus({ id: 's1', revokedAt: 1, isCurrent: true }), {
    label: '已吊销',
    kind: 'danger',
    revoked: true,
    current: false,
  })
  assert.deepEqual(deviceStatus({ id: 's2', revokedAt: null, isCurrent: true }), {
    label: '当前设备',
    kind: 'ok',
    revoked: false,
    current: true,
  })
  assert.deepEqual(deviceStatus({ id: 's3', revokedAt: null, isCurrent: false }), {
    label: '正常',
    kind: '',
    revoked: false,
    current: false,
  })
  assert.equal(deviceStatus(null).label, '状态未知')
})

test('吊销能力：已吊销或缺 id 一律禁用', () => {
  assert.equal(canRevokeDevice({ id: 's1', revokedAt: null }), true)
  assert.equal(canRevokeDevice({ id: 's1' }), true)
  assert.equal(canRevokeDevice({ id: 's1', revokedAt: 1 }), false)
  assert.equal(canRevokeDevice({ id: '', revokedAt: null }), false)
  assert.equal(canRevokeDevice(null), false)
})

test('设备行：缺省名称、到期相对时间、最近活跃与状态', () => {
  const view = deviceRows(
    [
      {
        id: 's1',
        label: '',
        platform: 'web',
        createdAt: NOW - DAY,
        expiresAt: NOW + DAY,
        revokedAt: null,
        isCurrent: true,
      },
      {
        id: 's2',
        label: '笔记本',
        platform: 'desktop',
        createdAt: NOW - 2 * DAY,
        expiresAt: NOW - HOUR,
        lastSeenAt: NOW - 5 * MINUTE,
        revokedAt: NOW - MINUTE,
        isCurrent: false,
      },
    ],
    { now: NOW }
  )

  assert.equal(view.count, 2)
  const first = view.rows[0]
  assert.equal(first.label, '未命名设备')
  assert.equal(first.platformLabel, '浏览器')
  assert.equal(first.expiryRelative, '1 天后到期')
  assert.equal(first.expiresAtLabel, settingsTimeLabel(NOW + DAY))
  assert.equal(first.lastSeenLabel, '从未活跃')
  assert.equal(first.status.label, '当前设备')
  assert.equal(first.canRevoke, true)

  const second = view.rows[1]
  assert.equal(second.label, '笔记本')
  assert.equal(second.expiryRelative, '已过期')
  assert.equal(second.lastSeenLabel, '5 分钟前')
  assert.equal(second.status.label, '已吊销')
  assert.equal(second.canRevoke, false)
})

test('成员错误文案：403 / 409 / 404 / 503 各有明确说法', () => {
  assert.equal(memberErrorText({ status: 403, code: 'forbidden' }), '仅 owner/admin 可管理成员')
  assert.equal(
    memberErrorText({ status: 409, code: 'workspace.last_owner' }),
    '不能移除/降级最后一个 owner'
  )
  assert.equal(
    memberErrorText({ status: 404, code: 'member_not_found' }),
    '这个成员已不在工作区，请刷新后重试'
  )
  assert.equal(
    memberErrorText({ status: 503, code: 'runtime.not_configured' }),
    '成员/设备接口未就绪'
  )
  assert.equal(memberErrorText({ status: 404, code: 'not_found' }), '成员/设备接口未就绪')
  assert.equal(memberErrorText({ status: 400, code: 'workspace.invalid_role' }), '角色不合法')
  assert.equal(
    memberErrorText({ status: 500, code: 'internal_error', message: '成员管理存储失败' }),
    '操作失败：成员管理存储失败'
  )
  assert.equal(memberErrorText(null), '操作失败，请重试。')
})

test('设备错误文案：503 / 404 / 403 不把吊销失败说成成功', () => {
  assert.equal(
    deviceErrorText({ status: 503, code: 'devices_unavailable' }),
    '成员/设备接口未就绪'
  )
  assert.equal(
    deviceErrorText({ status: 503, code: 'runtime.not_configured' }),
    '成员/设备接口未就绪'
  )
  assert.equal(
    deviceErrorText({ status: 404, code: 'device_not_found' }),
    '这台设备已不存在，请刷新后重试'
  )
  assert.equal(deviceErrorText({ status: 403, code: 'forbidden' }), '没有权限吊销这台设备')
  assert.equal(deviceErrorText({ status: 500, message: 'boom' }), '吊销失败：boom')
  assert.equal(deviceErrorText(null), '吊销失败，请重试。')
})

test('接口未就绪与 403 的判定只认确定的状态码', () => {
  assert.equal(isSettingsNotReady({ status: 503, code: 'runtime.not_configured' }), true)
  assert.equal(isSettingsNotReady({ status: 503, code: 'devices_unavailable' }), true)
  assert.equal(isSettingsNotReady({ status: 404, code: 'not_found' }), true)
  assert.equal(isSettingsNotReady({ status: 405 }), true)
  assert.equal(isSettingsNotReady({ status: 501 }), true)
  assert.equal(isSettingsNotReady({ status: 404, code: 'member_not_found' }), false)
  assert.equal(isSettingsNotReady({ status: 500, code: 'internal_error' }), false)
  assert.equal(isSettingsNotReady(null), false)

  assert.equal(isSettingsForbidden({ status: 403 }), true)
  assert.equal(isSettingsForbidden({ code: 'forbidden' }), true)
  assert.equal(isSettingsForbidden({ status: 401 }), false)
  assert.equal(isSettingsForbidden(null), false)
})
