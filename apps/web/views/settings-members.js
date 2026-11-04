// 设置页「成员」分区：列表、角色下拉、移除（docs/design/auth.md §5/§13）。
//
// 只有 owner/admin 显示管理控件；403 / 409 / 404 / 503 的文案由 lib/settings.js 统一。
// 所有账号名与角色只进 textContent / value。

import { el } from '../lib/dom.js'
import { isAuthError } from '../lib/api-client.js'
import {
  canManageMembers,
  inferCurrentAccountId,
  memberErrorText,
  memberRows,
  roleLabel,
  roleOptions,
} from '../lib/settings.js'
import * as ui from '../lib/ui.js'

function notice(title, body, action) {
  return ui.emptyState({ title, body, action })
}

function membersPath(workspaceId) {
  return `/api/workspaces/${encodeURIComponent(workspaceId)}/members`
}

/**
 * @param {object} ctx 页面上下文
 * @param {object} state 成员槽位 {mode, rows, error}
 * @param {() => void} remount 重新挂载设置页
 */
export function membersSection(ctx, state, remount) {
  const description =
    '成员可以查看工作区；只有 owner/admin 能改角色或移除成员。最后一个 owner 不能被降级或移除。'

  if (state.mode === 'forbidden') {
    return ui.section(
      '成员',
      [
        notice(
          '仅 owner/admin 可管理成员',
          '当前会话不能管理这个工作区的成员。需要改角色或移除成员时，请让 owner/admin 操作。',
          ui.button('重试', { variant: 'primary', onClick: remount })
        ),
      ],
      { description }
    )
  }

  if (state.mode === 'not-ready') {
    return ui.section(
      '成员',
      [
        notice(
          '成员/设备接口未就绪',
          '控制面还没有可用的成员接口（HTTP 503 runtime.not_configured）。界面不会假装有人；接口上线后点「重试」即可。',
          ui.button('重试', { variant: 'primary', onClick: remount })
        ),
      ],
      { description }
    )
  }

  if (state.mode === 'error') {
    return ui.section(
      '成员',
      [
        ui.errorState({
          error: state.error,
          message: `成员载入失败：${state.error instanceof Error ? state.error.message : String(state.error)}`,
          onRetry: remount,
        }),
      ],
      { description }
    )
  }

  let members = Array.isArray(state.rows) ? state.rows.slice() : []
  const canManage = canManageMembers(ctx.role)
  const sectionStatus = ui.statusLine('')
  const list = el('ul', { class: 'grant-list' })
  const empty = ui.emptyState({
    title: '还没有成员',
    body: '成员列表为空；这里不会造样例数据。',
  })
  const hint = canManage ? '' : '当前角色只能查看成员；改角色与移除需要 owner/admin。'

  function renderRows() {
    const currentAccountId = inferCurrentAccountId(members, ctx.role)
    const view = memberRows(members, { currentAccountId })
    list.replaceChildren()
    for (const row of view.rows) list.append(memberRow(row))
    empty.hidden = view.rows.length > 0
  }

  function memberRow(row) {
    const item = el('li', {
      class: `grant-row member-manage-row${row.isCurrent ? ' is-current' : ''}`,
    })
    const main = el('div', { class: 'grant-main' })
    const top = el('div', { class: 'grant-top' })
    top.append(el('span', { class: 'grant-key', text: row.accountId || '（accountId 缺失）' }))
    if (row.isCurrent) top.append(ui.badge('你', 'ok'))
    top.append(ui.badge(row.roleLabel, row.roleKind))
    if (row.isLastOwner) top.append(ui.badge('最后一个 owner', 'warn'))
    main.append(top)

    const dl = el('dl', { class: 'need-meta grant-meta' })
    const fields = [
      ['加入时间', row.joinedAtLabel],
      ['邀请人', row.invitedBy || '—'],
    ]
    for (const [label, value] of fields) {
      const line = el('div')
      line.append(el('dt', { text: label }), el('dd', { text: value }))
      dl.append(line)
    }
    main.append(dl)

    const note = ui.statusLine('')
    main.append(note)

    const actions = el('div', { class: 'grant-actions settings-manage-actions' })
    if (canManage) {
      const select = ui.select({ options: roleOptions(), value: row.role })
      select.classList.add('settings-role-select')
      select.addEventListener('change', () => void changeRole(row, select, note))
      select.setAttribute('aria-label', `修改 ${row.accountId || '这个成员'} 的角色`)
      const remove = ui.button('移除', {
        variant: 'ghost',
        size: 'sm',
        title: '移除后该账号失去这个工作区的权限',
        onClick: () => void removeMember(row, remove, note),
      })
      actions.append(select, remove)
    }

    item.append(main, actions)
    return item
  }

  async function changeRole(row, select, note) {
    const next = select.value
    if (next === row.role) return
    ui.setStatus(note, '')
    select.disabled = true
    try {
      const data = await ctx.api.patch(
        `${membersPath(ctx.workspaceId)}/${encodeURIComponent(row.accountId)}`,
        { role: next }
      )
      const updated = data && data.member && typeof data.member === 'object' ? data.member : null
      const role = updated && typeof updated.role === 'string' ? updated.role : next
      const index = members.findIndex(
        (member) => member && typeof member === 'object' && member.accountId === row.accountId
      )
      if (index >= 0) members[index] = { ...members[index], role }
      renderRows()
      ui.setStatus(sectionStatus, `已把 ${row.accountId} 的角色改为「${roleLabel(role)}」。`)
    } catch (cause) {
      if (isAuthError(cause)) {
        ctx.requirePair()
        return
      }
      select.value = row.role
      select.disabled = false
      ui.setStatus(note, memberErrorText(cause), 'error')
    }
  }

  async function removeMember(row, button, note) {
    const prompt = `从工作区移除 ${row.accountId}？移除后该账号将失去这里的所有权限。`
    if (typeof window !== 'undefined' && typeof window.confirm === 'function' && !window.confirm(prompt)) {
      return
    }
    ui.setStatus(note, '')
    ui.setBusy(button, true, '移除中…')
    try {
      await ctx.api.del(`${membersPath(ctx.workspaceId)}/${encodeURIComponent(row.accountId)}`)
      members = members.filter(
        (member) => !(member && typeof member === 'object' && member.accountId === row.accountId)
      )
      renderRows()
      ui.setStatus(sectionStatus, `已移除 ${row.accountId}。`)
      if (row.isCurrent) ctx.requirePair('你已被移出这个工作区，请重新配对。')
    } catch (cause) {
      if (isAuthError(cause)) {
        ctx.requirePair()
        return
      }
      ui.setBusy(button, false)
      ui.setStatus(note, memberErrorText(cause), 'error')
    }
  }

  renderRows()
  const children = [sectionStatus]
  if (hint !== '') children.push(el('p', { class: 'field-hint', text: hint }))
  children.push(empty, list)
  return ui.section('成员', children, { description })
}
