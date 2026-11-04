// 设置页「设备」分区：列表、状态、吊销（docs/design/auth.md §10）。
//
// 吊销当前设备后服务端会立即让会话失效，所以先给出明确提示再回配对页。
// 已吊销的行禁用按钮；503/404/403 的文案由 lib/settings.js 统一。

import { el } from '../lib/dom.js'
import { isAuthError } from '../lib/api-client.js'
import { deviceErrorText, deviceRows } from '../lib/settings.js'
import * as ui from '../lib/ui.js'

function notice(title, body, action) {
  return ui.emptyState({ title, body, action })
}

/**
 * @param {object} ctx 页面上下文
 * @param {object} state 设备槽位 {mode, rows, error}
 * @param {() => void} remount 重新挂载设置页
 */
export function devicesSection(ctx, state, remount) {
  const description =
    '设备会话约 30 天有效；吊销后该设备立即失效。吊销当前设备后需要重新配对。'

  if (state.mode === 'not-ready') {
    return ui.section(
      '设备',
      [
        notice(
          '成员/设备接口未就绪',
          '控制面还没有可用的设备接口（HTTP 503 runtime.not_configured / devices_unavailable）。界面不会假装成功；接口上线后点「重试」即可。',
          ui.button('重试', { variant: 'primary', onClick: remount })
        ),
      ],
      { description }
    )
  }

  if (state.mode === 'forbidden') {
    return ui.section(
      '设备',
      [
        notice(
          '没有权限查看设备',
          '当前会话不能查看或吊销设备。请让 owner/admin 处理。',
          ui.button('重试', { variant: 'primary', onClick: remount })
        ),
      ],
      { description }
    )
  }

  if (state.mode === 'error') {
    return ui.section(
      '设备',
      [
        ui.errorState({
          error: state.error,
          message: `设备载入失败：${state.error instanceof Error ? state.error.message : String(state.error)}`,
          onRetry: remount,
        }),
      ],
      { description }
    )
  }

  let devices = Array.isArray(state.rows) ? state.rows.slice() : []
  const sectionStatus = ui.statusLine('')
  const list = el('ul', { class: 'grant-list' })
  const empty = ui.emptyState({
    title: '还没有设备记录',
    body: '设备列表为空；这里不会造样例数据。配对成功后设备会出现在这里。',
  })

  function renderRows() {
    const view = deviceRows(devices, { now: Date.now() })
    list.replaceChildren()
    for (const row of view.rows) list.append(deviceRow(row))
    empty.hidden = view.rows.length > 0
  }

  function deviceRow(row) {
    const item = el('li', { class: `grant-row${row.status.current ? ' is-current' : ''}` })
    const main = el('div', { class: 'grant-main' })
    const top = el('div', { class: 'grant-top' })
    top.append(el('span', { class: 'grant-key', text: row.label }))
    top.append(ui.badge(row.platformLabel, ''))
    top.append(ui.badge(row.status.label, row.status.kind))
    main.append(top)

    const dl = el('dl', { class: 'need-meta grant-meta' })
    const fields = [
      ['创建时间', row.createdAtLabel],
      ['到期', `${row.expiryRelative} · ${row.expiresAtLabel}`],
      ['最近活跃', row.lastSeenLabel],
    ]
    for (const [label, value] of fields) {
      const line = el('div')
      line.append(el('dt', { text: label }), el('dd', { text: value }))
      dl.append(line)
    }
    main.append(dl)

    const note = ui.statusLine('')
    main.append(note)

    const revoke = ui.button('吊销', {
      variant: 'ghost',
      size: 'sm',
      disabled: !row.canRevoke,
      title: row.canRevoke
        ? '吊销后这台设备立即退出，需要重新配对才能使用'
        : '已吊销的设备不能再吊销',
      onClick: () => void revokeDevice(row, revoke, note),
    })
    item.append(main, el('div', { class: 'grant-actions' }, [revoke]))
    return item
  }

  async function revokeDevice(row, button, note) {
    const prompt = `吊销设备「${row.label}」？这台设备会立即退出，需要重新配对才能使用。`
    if (typeof window !== 'undefined' && typeof window.confirm === 'function' && !window.confirm(prompt)) {
      return
    }
    ui.setStatus(note, '')
    ui.setBusy(button, true, '吊销中…')
    try {
      await ctx.api.del(`/api/devices/${encodeURIComponent(row.id)}`)
      if (row.status.current) {
        // 当前会话已经被服务端吊销：先给出明确提示，再回配对页。
        ui.setStatus(sectionStatus, '已吊销当前设备，请重新配对')
        ctx.requirePair('已吊销当前设备，请重新配对')
        return
      }
      const source = devices.find((device) => device && device.id === row.id)
      if (source) source.revokedAt = Date.now()
      renderRows()
      ui.setStatus(sectionStatus, `已吊销设备「${row.label}」。`)
    } catch (cause) {
      if (isAuthError(cause)) {
        ctx.requirePair()
        return
      }
      ui.setBusy(button, false)
      ui.setStatus(note, deviceErrorText(cause), 'error')
    }
  }

  renderRows()
  return ui.section('设备', [sectionStatus, empty, list], { description })
}
