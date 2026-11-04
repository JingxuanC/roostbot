// 插件市场（docs/design/plugin-marketplace.md §7）：市场 / 已安装两块，页内切换。
//
// 数据来自 GET /api/marketplace/plugins 与 GET /api/plugin-installs。
// 接口未就绪（404/405/501/503 runtime.not_configured）时显示「插件接口未就绪」，
// 不拿样例凑数；市场为空就诚实显示「还没有上架插件」。
// 所有服务端文本只进 textContent；图标/截图走 lib/plugins.js 的 safeAssetUrl 白名单。

import { isAuthError } from '../lib/api-client.js'
import { el } from '../lib/dom.js'
import { pluginDetailHref } from '../lib/plugins.js'
import * as ui from '../lib/ui.js'
import { createInstalledPane } from './plugin-installed.js'
import {
  isPluginForbidden,
  isPluginNotReady,
  pluginForbiddenMessage,
  pluginIcon,
  pluginNotReadyState,
  pluginTierPill,
} from './plugin-kit.js'

const PAGE_TITLE = '插件'
const PAGE_SUBTITLE =
  '市场里的插件由控制面目录同步；安装只写记录，沙箱同步由下一批完成，界面不会把「等待同步」说成「已安装」。'

const TIER_OPTIONS = [
  { value: '', label: '全部级别' },
  { value: 'A', label: 'A 级 · 直接可用' },
  { value: 'B', label: 'B 级 · 需要授权资源' },
  { value: 'C', label: 'C 级 · 需要界面容器' },
  { value: 'D', label: 'D 级 · 仅桌面' },
]

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export async function mountPluginsPage(root, ctx) {
  root.replaceChildren(ui.loading('正在载入插件…'))

  let workspaceId = ''
  try {
    workspaceId = await ctx.ensureWorkspaceId()
  } catch (error) {
    if (isAuthError(error)) {
      ctx.requirePair()
      return
    }
    root.replaceChildren(
      ui.pageHeader(PAGE_TITLE),
      ui.errorState({
        error,
        message: `工作区载入失败：${error instanceof Error ? error.message : String(error)}`,
        onRetry: () => void mountPluginsPage(root, ctx),
        onPair: typeof ctx.hasToken === 'function' && ctx.hasToken() ? undefined : true,
      })
    )
    return
  }

  root.replaceChildren(pluginsView(ctx, root, workspaceId))
  const main = root.closest('main')
  if (main) main.focus()
}

function pluginsView(ctx, root, workspaceId) {
  const state = {
    tab: 'market',
    q: '',
    category: '',
    tier: '',
    categories: [],
  }
  const titles = new Map()
  let searchTimer = null
  let marketSeq = 0
  let marketLoaded = false

  const header = ui.pageHeader(PAGE_TITLE, {
    subtitle: PAGE_SUBTITLE,
    actions: [
      ui.button('刷新', {
        variant: 'ghost',
        onClick: () => {
          if (state.tab === 'market') void loadMarket()
          else void installedPane.reload()
        },
      }),
    ],
  })

  const marketTab = tabButton('市场', 'market')
  const installedTab = tabButton('已安装', 'installed')
  const tabs = el('div', { class: 'plugin-tabs', role: 'tablist', 'aria-label': '插件视图' }, [
    marketTab,
    installedTab,
  ])

  const marketPane = el('div', { class: 'stack plugin-pane' })
  const installedPaneHost = el('div', { class: 'stack plugin-pane', hidden: true })

  const search = ui.input({
    id: 'plugin-search',
    type: 'search',
    placeholder: '搜索插件标题或摘要…',
    autocomplete: 'off',
    ariaLabel: '搜索插件标题或摘要',
  })
  const categorySelect = ui.select({ id: 'plugin-category', options: [{ value: '', label: '全部分类' }] })
  const tierSelect = ui.select({ id: 'plugin-tier', options: TIER_OPTIONS })
  const toolbar = el('div', { class: 'plugin-toolbar' }, [
    el('div', { class: 'plugin-search-field' }, [search]),
    el('label', { class: 'plugin-filter' }, [
      el('span', { class: 'field-label', text: '分类' }),
      categorySelect,
    ]),
    el('label', { class: 'plugin-filter' }, [
      el('span', { class: 'field-label', text: '级别' }),
      tierSelect,
    ]),
  ])
  const countLine = el('p', { class: 'section-desc plugin-count', role: 'status' })
  const results = el('div', { class: 'plugin-results' })
  marketPane.append(toolbar, countLine, results)

  const installedPane = createInstalledPane(ctx, workspaceId, {
    getTitle: (slug) => titles.get(slug) || slug,
    onGoMarket: () => setTab('market'),
    onChanged: () => {
      // 卸载/升级后，市场卡片上的「已安装」标记可能变了；后台刷一次。
      if (marketLoaded) void loadMarket()
    },
  })
  installedPaneHost.append(installedPane.node)

  function tabButton(label, tab) {
    const button = el('button', {
      class: 'plugin-tab',
      type: 'button',
      role: 'tab',
      'aria-selected': String(tab === state.tab),
      text: label,
    })
    button.addEventListener('click', () => setTab(tab))
    return button
  }

  function setTab(tab) {
    state.tab = tab
    const market = tab === 'market'
    marketTab.classList.toggle('is-active', market)
    marketTab.setAttribute('aria-selected', String(market))
    installedTab.classList.toggle('is-active', !market)
    installedTab.setAttribute('aria-selected', String(!market))
    marketPane.hidden = !market
    installedPaneHost.hidden = market
    if (market) {
      if (!marketLoaded) void loadMarket()
    } else {
      void installedPane.load()
    }
  }

  function hasFilters() {
    return state.q !== '' || state.category !== '' || state.tier !== ''
  }

  function updateCategories(plugins) {
    const known = new Set(state.categories)
    for (const plugin of plugins) {
      const category = typeof plugin.category === 'string' ? plugin.category.trim() : ''
      if (category !== '') known.add(category)
    }
    state.categories = [...known].sort((left, right) => left.localeCompare(right, 'zh'))
    ui.setSelectOptions(
      categorySelect,
      [{ value: '', label: '全部分类' }, ...state.categories.map((value) => ({ value, label: value }))],
      state.category
    )
  }

  function renderEmpty() {
    if (hasFilters()) {
      results.replaceChildren(
        ui.emptyState({
          title: '没有匹配的插件',
          body: '没有插件符合当前搜索与筛选。换个关键词，或清空筛选。',
          action: ui.button('清空筛选', { variant: 'ghost', onClick: resetFilters }),
        })
      )
      return
    }
    results.replaceChildren(
      ui.emptyState({
        title: '还没有上架插件',
        body: '市场目录是空的：控制面还没有同步任何插件。这里不会拿样例凑数。',
        action: ui.button('刷新', { variant: 'ghost', onClick: () => void loadMarket() }),
      })
    )
  }

  function resetFilters() {
    state.q = ''
    state.category = ''
    state.tier = ''
    search.value = ''
    categorySelect.value = ''
    tierSelect.value = ''
    void loadMarket()
  }

  function renderCards(plugins) {
    results.replaceChildren()
    if (plugins.length === 0) {
      renderEmpty()
      return
    }
    const list = el('ul', { class: 'plugin-grid' })
    for (const plugin of plugins) list.append(pluginCard(plugin))
    results.append(list)
    countLine.textContent = `${plugins.length} 个插件${hasFilters() ? '（已筛选）' : ''}`
  }

  function pluginCard(plugin) {
    const href = pluginDetailHref(plugin.slug)
    const link = el('a', { class: 'plugin-card', href })
    link.append(pluginIcon(plugin))

    const main = el('div', { class: 'plugin-card-main' })
    const top = el('div', { class: 'plugin-card-top' })
    top.append(el('h3', { class: 'plugin-card-title', text: plugin.title || plugin.slug || '未命名插件' }))
    if (plugin.installed === true) top.append(ui.badge('已安装', 'ok'))
    top.append(pluginTierPill(plugin.tier, plugin.tierLabel))
    main.append(top)

    const publisher = typeof plugin.publisherId === 'string' && plugin.publisherId.trim() !== ''
      ? plugin.publisherId
      : '未知'
    main.append(el('p', { class: 'plugin-card-publisher muted', text: `发布者 ${publisher}` }))
    if (typeof plugin.summary === 'string' && plugin.summary.trim() !== '') {
      main.append(el('p', { class: 'plugin-card-summary', text: plugin.summary }))
    }

    const meta = []
    if (typeof plugin.latest === 'string' && plugin.latest.trim() !== '') meta.push(`最新 ${plugin.latest}`)
    if (typeof plugin.category === 'string' && plugin.category.trim() !== '') meta.push(plugin.category)
    if (Array.isArray(plugin.screenshots) && plugin.screenshots.length > 0) {
      meta.push(`${plugin.screenshots.length} 张截图`)
    }
    if (meta.length > 0) main.append(el('p', { class: 'plugin-card-meta muted', text: meta.join(' · ') }))

    link.append(main)
    link.append(el('span', { class: 'row-chev', 'aria-hidden': 'true', text: '›' }))
    return el('li', { class: 'plugin-card-item' }, [link])
  }

  async function loadMarket() {
    const seq = ++marketSeq
    marketLoaded = true
    countLine.textContent = ''
    results.replaceChildren(ui.loading('正在载入市场…'))

    const params = new URLSearchParams()
    if (state.q !== '') params.set('q', state.q)
    if (state.category !== '') params.set('category', state.category)
    if (state.tier !== '') params.set('tier', state.tier)
    if (workspaceId !== '') params.set('workspaceId', workspaceId)
    const query = params.toString()

    let data
    try {
      data = await ctx.api.get(`/api/marketplace/plugins${query === '' ? '' : `?${query}`}`)
    } catch (error) {
      if (seq !== marketSeq) return
      if (isAuthError(error)) {
        ctx.requirePair()
        return
      }
      if (isPluginForbidden(error)) {
        results.replaceChildren(
          ui.emptyState({
            title: pluginForbiddenMessage(error, 'view'),
            body: '插件市场按工作区隔离；当前账号不是这个工作区的成员，所以看不到目录与安装标记。',
          })
        )
        return
      }
      if (isPluginNotReady(error)) {
        results.replaceChildren(pluginNotReadyState({ error, retry: () => void loadMarket() }))
        return
      }
      results.replaceChildren(
        ui.errorState({
          error,
          message: `插件市场载入失败：${error instanceof Error ? error.message : String(error)}`,
          onRetry: () => void loadMarket(),
          onPair: typeof ctx.hasToken === 'function' && ctx.hasToken() ? undefined : true,
        })
      )
      return
    }
    if (seq !== marketSeq) return

    const plugins = (Array.isArray(data?.plugins) ? data.plugins : []).filter(isObject)
    updateCategories(plugins)
    for (const plugin of plugins) {
      if (typeof plugin.slug === 'string' && typeof plugin.title === 'string' && plugin.title.trim() !== '') {
        titles.set(plugin.slug, plugin.title)
      }
    }
    renderCards(plugins)
  }

  search.addEventListener('input', () => {
    if (searchTimer !== null) clearTimeout(searchTimer)
    searchTimer = setTimeout(() => {
      searchTimer = null
      state.q = search.value.trim()
      void loadMarket()
    }, 250)
  })
  search.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    if (searchTimer !== null) clearTimeout(searchTimer)
    searchTimer = null
    state.q = search.value.trim()
    void loadMarket()
  })
  categorySelect.addEventListener('change', () => {
    state.category = categorySelect.value
    void loadMarket()
  })
  tierSelect.addEventListener('change', () => {
    state.tier = tierSelect.value
    void loadMarket()
  })

  const node = el('div', { class: 'stack' }, [header, tabs, marketPane, installedPaneHost])
  void loadMarket()
  return node
}
