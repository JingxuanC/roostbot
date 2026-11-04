// 插件面板清单（GET /api/plugins/panels?workspaceId=，docs/build/wave1.md §C/§D）。
//
// 404/405/501 时降级为“整页面板容器”：不清空页面，也不假装有清单。
// 所有服务端文本只进 textContent。

import { isAuthError } from '../lib/api-client.js'
import { el } from '../lib/dom.js'
import {
  isDshNotRunning,
  isPanelsListMissing,
  legacyPanelsListPath,
  panelsFromPayload,
  panelsListPath,
} from '../lib/panels.js'
import * as ui from '../lib/ui.js'

function errorStatus(error) {
  return error && typeof error.status === 'number' ? error.status : 0
}

/**
 * @param {object} ctx pageContext
 * @param {string} workspaceId
 * @param {{onOpen?: (panel: object|undefined) => void}} [options]
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
      text: '来自已启用插件 manifest 的 panels 声明；打开面板前会先唤醒工作区。',
    }),
    status,
    list,
    empty,
  ])

  function openButton(label = '打开面板') {
    return ui.button(label, {
      variant: 'primary',
      size: 'sm',
      onClick: () => onOpen(undefined),
    })
  }

  async function load() {
    ui.setStatus(status, '')
    list.hidden = true
    empty.hidden = false
    empty.replaceChildren(ui.loading('正在载入面板清单…'))

    let data
    try {
      data = await ctx.api.get(panelsListPath(workspaceId))
    } catch (error) {
      if (isAuthError(error)) {
        ctx.requirePair()
        return
      }
      if (errorStatus(error) === 403) {
        empty.replaceChildren(
          ui.emptyState({
            title: '没有权限查看面板清单',
            body: '面板清单按工作区隔离；当前账号不是这个工作区的成员。',
          })
        )
        return
      }
      if (isPanelsListMissing(error)) {
        // 兼容老控制面的 GET /api/workspaces/:id/panels；两个都没有才降级。
        const legacyPath = legacyPanelsListPath(workspaceId)
        if (legacyPath !== '') {
          try {
            const legacy = await ctx.api.get(legacyPath)
            render(panelsFromPayload(legacy))
            return
          } catch (legacyError) {
            if (isAuthError(legacyError)) {
              ctx.requirePair()
              return
            }
            if (!isPanelsListMissing(legacyError)) {
              empty.replaceChildren(
                ui.emptyState({
                  title: '面板清单载入失败',
                  body: `面板清单暂时不可用（${legacyError instanceof Error ? legacyError.message : String(legacyError)}）；面板容器仍会尝试打开。`,
                  action: ui.button('重试', { variant: 'ghost', onClick: () => void load() }),
                  secondary: openButton('打开整页面板'),
                })
              )
              return
            }
          }
        }
        empty.replaceChildren(
          ui.emptyState({
            title: '面板清单接口未就绪',
            body:
              '控制面还没有 GET /api/plugins/panels（或返回 404/405/501）。' +
              '已降级为整页面板容器：仍可尝试唤醒并打开 /w/<workspace>/dsh/，但看不到具体面板声明。',
            action: openButton('打开整页面板'),
          })
        )
        return
      }
      if (isDshNotRunning(error)) {
        empty.replaceChildren(
          ui.emptyState({
            title: '面板未运行',
            body: '工作区里的 DSH Web 没有启动（503 · dsh.not_running）；先打开一次面板会尝试唤醒。',
            action: openButton('打开整页面板'),
          })
        )
        return
      }
      empty.replaceChildren(
        ui.emptyState({
          title: '面板清单载入失败',
          body: `面板清单暂时不可用（${error instanceof Error ? error.message : String(error)}）；面板容器仍会尝试打开。`,
          action: ui.button('重试', { variant: 'ghost', onClick: () => void load() }),
          secondary: openButton('打开整页面板'),
        })
      )
      return
    }

    render(panelsFromPayload(data))
  }

  function render(panels) {
    list.replaceChildren()
    if (panels.length === 0) {
      list.hidden = true
      empty.hidden = false
      empty.replaceChildren(
        ui.emptyState({
          title: '还没有可显示的面板',
          body: '先安装带面板的插件。面板清单为空时仍可以打开整页面板容器。',
          action: ui.linkButton('去插件市场', '#/plugins', { variant: 'primary' }),
          secondary: openButton('打开整页面板'),
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
    const row = el('li', { class: 'panel-item' })
    const main = el('div', { class: 'panel-item-main' })
    const top = el('div', { class: 'panel-item-top' })
    top.append(el('span', { class: 'panel-item-name', text: panel.title || panel.name }))
    if (panel.title !== '' && panel.title !== panel.name) {
      top.append(el('span', { class: 'panel-item-code muted', text: panel.name }))
    }
    if (panel.pluginSlug !== '') top.append(el('span', { class: 'panel-item-plugin muted', text: `插件 ${panel.pluginSlug}` }))
    if (panel.slot !== '') top.append(ui.badge(panel.slot, 'accent'))
    main.append(top)
    row.append(main)
    row.append(
      ui.button('打开', {
        variant: 'ghost',
        size: 'sm',
        onClick: () => onOpen(panel),
      })
    )
    return row
  }

  return { node, load }
}
