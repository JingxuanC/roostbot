// 连接器页「按 Bot 授权」分区（docs/design/connectors.md §3/§9）。
//
// 数据来自：
//   GET /api/connectors/:slug/grants?workspaceId=  → { grants }（owner/admin）
//   PUT /api/connectors/:slug/grants                → { grant }（owner/admin）
// 选择 Bot 后为该 Bot 的每个连接器渲染一张授权表单：read/write + 动作勾选/逗号输入。
// 401 回配对页；403 说明角色不足；404/405/501/503 说明接口未就绪。
// 所有用户可见文本只进 textContent / value，不拼 innerHTML。

import { isAuthError } from '../lib/api-client.js'
import { el } from '../lib/dom.js'
import {
  GRANT_ACCESS_OPTIONS,
  MAX_ACTIONS,
  MAX_ACTION_CHARS,
  canManageConnectors,
  connectorActions,
  connectorErrorText,
  connectorGrantPayload,
  grantActionSelection,
  grantForBot,
  grantSummary,
  isConnectorForbidden,
  validateGrantForm,
} from '../lib/connectors.js'
import * as ui from '../lib/ui.js'

const SECTION_DESC =
  '按 Bot 授权决定该 Bot 能用哪些连接器的哪些动作；未授权的连接器不会进入 Bot 的工具列表。不勾选动作表示该权限下全部动作。'

function botOptions(bots) {
  return (Array.isArray(bots) ? bots : [])
    .filter((bot) => bot && typeof bot === 'object' && typeof bot.id === 'string' && bot.id !== '')
    .map((bot) => {
      const name = typeof bot.name === 'string' && bot.name.trim() !== '' ? bot.name.trim() : bot.id
      return { value: bot.id, label: `${name}（${bot.id}）` }
    })
}

function grantsPath(workspaceId, slug) {
  return `/api/connectors/${encodeURIComponent(slug)}/grants?workspaceId=${encodeURIComponent(workspaceId)}`
}

function grantPath(slug) {
  return `/api/connectors/${encodeURIComponent(slug)}/grants`
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * @param {object} ctx 页面上下文 {api, requirePair}
 * @param {object} page {workspaceId, role, connectors, bots}
 * @returns {HTMLElement}
 */
export function connectorGrantsSection(ctx, page) {
  const section = ui.section('按 Bot 授权', [], { description: SECTION_DESC })

  if (!canManageConnectors(page.role)) {
    section.append(
      ui.emptyState({
        title: '仅 owner/admin 可管理连接器授权',
        body: '当前账号在这个工作区不是 owner/admin，所以不能查看或修改按 Bot 授权。连接器目录本身仍然可以查看。',
      })
    )
    return section
  }

  const bots = Array.isArray(page.bots) ? page.bots : []
  const options = botOptions(bots)
  if (options.length === 0) {
    section.append(
      ui.emptyState({
        title: '还没有 Bot',
        body: '按 Bot 授权需要先有 Bot。先创建一个 Bot，再回来分配连接器权限。',
        action: ui.linkButton('新建 Bot', '#/bots/new', { variant: 'primary' }),
      })
    )
    return section
  }

  const botSelect = ui.select({ id: 'connector-grant-bot', options })
  const headerNote = ui.statusLine('')
  const formsHost = el('div', { class: 'stack connector-grant-list' })
  section.append(
    ui.field('Bot', botSelect, { id: 'connector-grant-bot', hint: '切换 Bot 会重新载入它的授权。' }),
    headerNote,
    formsHost
  )

  let seq = 0

  async function loadGrants() {
    const current = ++seq
    const botId = botSelect.value
    ui.setStatus(headerNote, '')
    formsHost.replaceChildren(ui.loading('正在载入授权…'))

    const rows = []
    for (const connector of page.connectors) {
      try {
        const data = await ctx.api.get(grantsPath(page.workspaceId, connector.slug))
        if (current !== seq) return
        const grants = Array.isArray(data?.grants) ? data.grants : []
        rows.push({ connector, grant: grantForBot(grants, botId) })
      } catch (error) {
        if (current !== seq) return
        if (isAuthError(error)) {
          ctx.requirePair()
          return
        }
        if (isConnectorForbidden(error)) {
          formsHost.replaceChildren(
            ui.emptyState({
              title: '仅 owner/admin 可管理连接器授权',
              body: '当前账号在这个工作区不是 owner/admin，所以不能查看或修改按 Bot 授权。连接器目录本身仍然可以查看。',
            })
          )
          return
        }
        formsHost.replaceChildren(
          ui.errorState({
            error,
            message: `${connector.title || connector.slug} 授权载入失败：${connectorErrorText(error, 'grants')}`,
            onRetry: () => void loadGrants(),
          })
        )
        return
      }
    }
    if (current !== seq) return

    formsHost.replaceChildren()
    for (const row of rows) {
      formsHost.append(grantForm(row.connector, row.grant, botId))
    }
  }

  function grantForm(connector, grant, botId) {
    const slug = String(connector.slug)
    const known = connectorActions(connector)
    const selection = grantActionSelection(grant, known)
    const title = typeof connector.title === 'string' && connector.title.trim() !== ''
      ? connector.title.trim()
      : slug

    const summary = el('p', { class: 'section-desc connector-grant-summary', text: grantSummary(grant) })
    const access = ui.radioGroup({
      legend: '权限',
      name: `connector-grant-access-${slug}`,
      options: GRANT_ACCESS_OPTIONS,
      value: grant && (grant.access === 'read' || grant.access === 'write') ? grant.access : 'read',
    })
    const checks = known.length > 0
      ? ui.checkboxList({
          legend: '动作（不勾选 = 该权限下全部动作）',
          name: `connector-grant-actions-${slug}`,
          items: known.map((action) => ({
            value: action,
            label: action,
            checked: selection.checked.includes(action),
          })),
          hint: '勾选后只放行勾选的动作；全部不勾选表示不限制动作。',
        })
      : null
    const extra = ui.input({
      id: `connector-grant-extra-${slug}`,
      value: selection.extraText,
      placeholder: '其它动作，用逗号分隔（可留空）',
    })
    const error = ui.inlineError()
    const statusLine = ui.statusLine('')
    const save = ui.button('保存授权', { variant: 'primary', type: 'submit' })

    const form = el('form', { class: 'form connector-grant-form', novalidate: true })
    const head = el('div', { class: 'connector-grant-head' }, [
      el('h3', { class: 'connector-grant-title', text: title }),
      ui.badge(slug, 'accent'),
    ])
    form.append(head, summary, access.node)
    if (checks) form.append(checks.node)
    else form.append(el('p', { class: 'field-hint', text: '这个连接器还没有公开动作清单；可以在下面手填动作名。' }))
    form.append(
      ui.field('额外动作', extra, {
        id: `connector-grant-extra-${slug}`,
        hint: `逗号分隔；每个动作 ≤${MAX_ACTION_CHARS} 字，共 ≤${MAX_ACTIONS} 个。`,
      }),
      error,
      statusLine,
      el('div', { class: 'form-foot' }, [save])
    )

    form.addEventListener('submit', async (event) => {
      event.preventDefault()
      ui.setError(error, '')
      ui.setStatus(statusLine, '')
      const result = validateGrantForm({
        access: access.getValue(),
        selectedActions: checks ? checks.getValues() : [],
        extraActions: extra.value,
      })
      if (!result.ok) {
        ui.setError(error, result.error)
        return
      }
      const payload = connectorGrantPayload({
        workspaceId: page.workspaceId,
        botId,
        access: result.access,
        actions: result.actions,
      })
      if (payload === null) {
        ui.setError(error, '授权请求不完整，请刷新页面后重试。')
        return
      }
      ui.setBusy(save, true, '保存中…')
      try {
        const data = await ctx.api.request('PUT', grantPath(slug), payload)
        const saved = data && typeof data === 'object' && data.grant && typeof data.grant === 'object'
          ? data.grant
          : { access: result.access, actions: result.actions }
        summary.textContent = grantSummary(saved)
        ui.setStatus(statusLine, '已保存。')
      } catch (cause) {
        if (isAuthError(cause)) {
          ctx.requirePair()
          return
        }
        ui.setError(error, connectorErrorText(cause, 'save'))
      } finally {
        ui.setBusy(save, false)
      }
    })

    return form
  }

  botSelect.addEventListener('change', () => void loadGrants())
  void loadGrants()
  return section
}
