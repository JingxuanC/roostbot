// 插件页面共用的 DOM 片段：图标、截图、权限清单、降级态。
// 所有服务端文本只进 textContent / 属性；不拼 innerHTML。

import { isMissingRoute } from '../lib/api-client.js'
import { el } from '../lib/dom.js'
import {
  pluginPermissionItems,
  pluginTierBadgeText,
  pluginTierKind,
  safeAssetUrl,
} from '../lib/plugins.js'
import * as ui from '../lib/ui.js'

/** 与审批/设置页一致：404 路由缺失、405/501、503 runtime.not_configured 都算未就绪。 */
export function isPluginNotReady(error) {
  if (!error) return false
  if (isMissingRoute(error)) return true
  if (error.status === 405 || error.status === 501) return true
  return error.status === 503 && error.code === 'runtime.not_configured'
}

export function isPluginForbidden(error) {
  return Boolean(error && (error.status === 403 || error.code === 'forbidden'))
}

/** 403 的权限提示；发布者未验证单独说明，不误报成角色问题。 */
export function pluginForbiddenMessage(error, action = 'install') {
  const code = error && typeof error.code === 'string' ? error.code : ''
  if (code === 'plugin.publisher_unverified') {
    return '这个插件的发布者未验证；v1 只允许安装白名单发布者的插件。'
  }
  if (action === 'manage') return '仅 owner/admin 可管理已安装插件。'
  if (action === 'view') return '当前账号无权查看这个工作区的插件。'
  return '仅 owner/admin 可安装插件。'
}

export function pluginStatusDetail(error) {
  const status = error && typeof error.status === 'number' ? error.status : 0
  const code = error && typeof error.code === 'string' ? error.code : ''
  return `${status > 0 ? `HTTP ${status}` : '没有可用响应'}${code === '' ? '' : ` · ${code}`}`
}

/** 接口未就绪的诚实空态（404/405/501/503 runtime.not_configured）。 */
export function pluginNotReadyState(options = {}) {
  const retry = typeof options.retry === 'function' ? options.retry : undefined
  return ui.emptyState({
    title: '插件接口未就绪',
    body:
      '控制面还没有可用的插件市场接口（或返回 404/405/501/503 runtime.not_configured）。' +
      '界面不会假装有插件，也不会假装安装成功。接口返回：' +
      `${pluginStatusDetail(options.error)}。接口上线后点「重试」即可。`,
    action: retry ? ui.button('重试', { variant: 'primary', onClick: retry }) : undefined,
    secondary: options.backHref
      ? ui.linkButton(options.backLabel || '回插件市场', options.backHref, { variant: 'ghost' })
      : undefined,
  })
}

/** 插件图标：只渲染白名单 URL；缺失时用标题首字，不塞外部占位图。 */
export function pluginIcon(plugin, sizeClass = '') {
  const url = safeAssetUrl(plugin && plugin.icon)
  const className = `plugin-icon ${sizeClass}`.trim()
  if (url !== '') {
    const wrap = el('span', { class: className })
    wrap.append(
      el('img', {
        class: 'plugin-icon-img',
        src: url,
        alt: '',
        loading: 'lazy',
        decoding: 'async',
      })
    )
    return wrap
  }
  const title = plugin && typeof plugin.title === 'string' ? plugin.title.trim() : ''
  const letter = title === '' ? '◇' : title.slice(0, 1)
  return el('span', { class: className }, [
    el('span', { class: 'plugin-icon-fallback', 'aria-hidden': 'true', text: letter }),
  ])
}

/** 截图：同样只接受白名单 URL；一张都没有时返回 null，不渲染空容器。 */
export function pluginScreenshots(screenshots) {
  const urls = (Array.isArray(screenshots) ? screenshots : []).map(safeAssetUrl).filter((url) => url !== '')
  if (urls.length === 0) return null
  const list = el('ul', { class: 'plugin-screenshots' })
  urls.forEach((url, index) => {
    list.append(
      el('li', {}, [
        el('img', {
          class: 'plugin-shot',
          src: url,
          alt: `截图 ${index + 1}`,
          loading: 'lazy',
          decoding: 'async',
        }),
      ])
    )
  })
  return list
}

export function pluginPermissionList(source, options = {}) {
  const items = pluginPermissionItems(source)
  const dl = el('dl', { class: `need-meta plugin-perm-list${options.compact ? ' is-compact' : ''}`.trim() })
  for (const item of items) {
    const row = el('div')
    row.append(el('dt', { text: item.label }))
    row.append(el('dd', { class: item.missing ? 'muted' : '', text: item.value }))
    dl.append(row)
  }
  return dl
}

export function pluginTierPill(tier, tierLabel) {
  return ui.badge(pluginTierBadgeText(tier, tierLabel), pluginTierKind(tier))
}
