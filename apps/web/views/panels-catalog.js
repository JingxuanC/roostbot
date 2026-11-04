// 插件面板页的清单块（GET /api/workspaces/:id/panels）。
// 只负责渲染插件名/面板名与「打开」入口；iframe 由 views/panels.js 管。
// 所有服务端文本只进 textContent；面板路径先过 lib/panels.js 的白名单。

import { isAuthError } from '../lib/api-client.js'
import { el } from '../lib/dom.js'
import { panelProxyPath } from '../lib/panels.js'
import * as ui from '../lib/ui.js'

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function statusOf(error) {
  return error && typeof error.status === 'number' ? error.status : 0
}

/**
 * @param {object} ctx pageContext
 * @param {string} workspaceId
 * @param {{onOpen?: (path: string|undefined) => void}} [options]
 */
export function createPanelsCatalog(ctx, workspaceId, options = {}) {
  const onOpen = typeof options.onOpen === 'function' ? options.onOpen : () => {}

  const status = ui.statusLine('')
  const list = el('ul', { class: 'panel-list' })
  const empty = el('div', { class: 'panel-catalog-empty' })
  const node = el('section', { class: 'page-card panel-catalog' }, [
    el('div', { class: 'section-head' }, [el('h2', { class: 'section-title', text: '面板清单' })]),
    el('p', {
      class: 'section-desc',
      text: '来自已启用插件 manifest 的 panels 声明；DSH Web 实际注册数以沙箱为准。',
    }),
    status,
    list,
    empty,
  ])

  async function load() {
    ui.setStatus(status, '')
    list.hidden = true
    empty.hidden = false
    empty.replaceChildren(ui.loading('正在载入面板清单…'))

    let data
    try {
      data = await ctx.api.get(`/api/workspaces/${encodeURIComponent(workspaceId)}/panels`)
    } catch (error) {
      if (isAuthError(error)) {
        ctx.requirePair()
        return
      }
      if (statusOf(error) === 403) {
        empty.replaceChildren(
          ui.emptyState({
            title: '没有权限查看面板清单',
            body: '面板清单按工作区隔离；当前账号不是这个工作区的成员。',
          })
        )
        return
      }
      if (statusOf(error) === 404) {
        empty.replaceChildren(
          ui.emptyState({
            title: '找不到这个工作区',
            body: '工作区不存在，或当前账号不是成员；面板容器仍会尝试用当前工作区地址打开。',
          })
        )
        return
      }
      empty.replaceChildren(
        ui.emptyState({
          title: '面板清单载入失败',
          body: `面板清单暂时不可用（${error instanceof Error ? error.message : String(error)}）；面板容器仍会尝试打开。`,
          action: ui.button('重试', { variant: 'ghost', onClick: () => void load() }),
        })
      )
      return
    }

    render((Array.isArray(data?.panels) ? data.panels : []).filter(isObject))
  }

  function render(panels) {
    list.replaceChildren()
    if (panels.length === 0) {
      list.hidden = true
      empty.hidden = false
      empty.replaceChildren(
        ui.emptyState({
          title: '还没有可显示的面板',
          body: '先安装带面板的插件。插件面板由 A/B/C 级插件的 manifest 提供；面板容器仍可以先打开。',
          action: ui.linkButton('去插件市场', '#/plugins', { variant: 'primary' }),
        })
      )
      return
    }
    empty.hidden = true
    list.hidden = false
    for (const panel of panels) list.append(panelRow(panel))
    ui.setStatus(status, `${panels.length} 个面板声明（来自已启用插件的 manifest）。`)
  }

  function panelRow(panel) {
    const name = text(panel.name) || '未命名面板'
    const title = text(panel.title)
    const slug = text(panel.pluginSlug)
    const slot = text(panel.slot)
    const row = el('li', { class: 'panel-item' })

    const main = el('div', { class: 'panel-item-main' })
    const top = el('div', { class: 'panel-item-top' })
    top.append(el('span', { class: 'panel-item-name', text: title || name }))
    if (title !== '' && title !== name) top.append(el('span', { class: 'panel-item-code muted', text: name }))
    if (slug !== '') top.append(el('span', { class: 'panel-item-plugin muted', text: `插件 ${slug}` }))
    if (slot !== '') top.append(ui.badge(slot, 'accent'))
    main.append(top)
    row.append(main)

    const pathValue = typeof panel.path === 'string' && panel.path !== '' ? panel.path : undefined
    if (panelProxyPath(workspaceId, pathValue) === null) {
      row.append(el('span', { class: 'panel-item-invalid', text: '面板路径不合法，已忽略' }))
      return row
    }
    row.append(
      ui.button('打开', {
        variant: 'ghost',
        size: 'sm',
        onClick: () => onOpen(pathValue),
      })
    )
    return row
  }

  return { node, load }
}
