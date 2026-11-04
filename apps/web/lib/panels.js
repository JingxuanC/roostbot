// 插件面板（ADR 0004 / plugin-marketplace.md §3 C 级）：反代源、路径拼接、状态与失败文案。
// 纯函数，不碰 DOM；等价于 packages/plugins/src/surface.ts 的约定，但前端不能直接 import TS。
//
// 安全边界：iframe 的 src 只能由本模块生成——反代源必须是 http(s) origin，
// 路径固定为 `/w/<workspaceId>/dsh/`，panel.path 只允许 [A-Za-z0-9/_.-]，
// 拒绝空段、`.`、`..` 与绝对路径，绝不接受任意 URL。

const WORKSPACE_ID = /^[A-Za-z0-9_-]+$/
const PANEL_PATH = /^[A-Za-z0-9/_.-]+$/
const MAX_PANEL_PATH = 512

/** 控制面未启用独立反代端口时的失败文案。 */
export const PANEL_NOT_CONFIGURED_MESSAGE = '面板容器未配置（控制面未启用 ROOST_DSH_PROXY_PORT）。'

/**
 * 校验 GET /api/config 的 dshBase：只接受 http(s) origin（无路径/query/hash/凭据）。
 * 返回规范化 origin（默认端口会被去掉）；不合法返回 null。
 * @param {unknown} value
 * @returns {string|null}
 */
export function normalizeDshBase(value) {
  if (typeof value !== 'string') return null
  const raw = value.trim()
  if (raw === '') return null
  let url
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (url.username !== '' || url.password !== '') return null
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') return null
  return url.origin
}

/**
 * 面板代理地址。workspaceId 不合法或 panelPath 含非法字符/路径穿越时返回 null。
 * panelPath 为空表示 DSH Web 根（整页面板容器）。
 * @param {string} workspaceId
 * @param {string} [panelPath]
 * @returns {string|null}
 */
export function panelProxyPath(workspaceId, panelPath) {
  if (typeof workspaceId !== 'string' || !WORKSPACE_ID.test(workspaceId)) return null
  const base = `/w/${workspaceId}/dsh/`
  if (panelPath === undefined || panelPath === null || panelPath === '') return base
  if (typeof panelPath !== 'string' || panelPath.length > MAX_PANEL_PATH) return null
  if (!PANEL_PATH.test(panelPath)) return null
  // 绝对路径会变成 //host 这类协议相对地址，直接拒绝。
  if (panelPath.startsWith('/')) return null
  const segments = panelPath.split('/')
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return null
  return `${base}${panelPath}`
}

/**
 * 面板的完整 URL：合法 dshBase + 合法路径才返回；任一项不合法返回 null。
 * @param {unknown} dshBase
 * @param {string} workspaceId
 * @param {string} [panelPath]
 * @returns {string|null}
 */
export function panelProxyUrl(dshBase, workspaceId, panelPath) {
  const origin = normalizeDshBase(dshBase)
  const path = panelProxyPath(workspaceId, panelPath)
  if (origin === null || path === null) return null
  return `${origin}${path}`
}

/** idle / loading / ready / failed 的中文文案；未知状态原样说明。 */
export function panelStateLabel(state) {
  switch (state) {
    case 'idle':
      return '等待启动'
    case 'loading':
      return '面板容器启动中…'
    case 'ready':
      return '面板已就绪'
    case 'failed':
      return '面板未就绪'
    default:
      return '状态未知'
  }
}

/**
 * 失败态文案。status 为 HTTP 状态（0 表示没有响应）；code 可覆盖网络/超时。
 * 401 的跳转由调用方处理（requirePair），这里只给原因。
 */
export function panelFailureMessage(status, code) {
  const normalizedCode = typeof code === 'string' ? code : ''
  if (normalizedCode === 'network') {
    return '连不上控制面（网络中断）：插件面板未就绪。检查控制面是否在跑，然后重试。'
  }
  if (normalizedCode === 'timeout' || status === 0) {
    return '面板加载超时：插件面板未就绪（沙箱可能未启动）。点「重试」再试；一直超时请确认沙箱是否在运行。'
  }
  if (normalizedCode === 'dsh.not_running') {
    return '面板未运行（HTTP 503 · dsh.not_running）：沙箱里的 DSH Web 没有启动。点「重试」再次唤醒工作区。'
  }
  switch (status) {
    case 401:
      return '鉴权失败（HTTP 401）：面板会话没有生效。重新配对后再打开面板。'
    case 402:
      return '面板容器要求授权（HTTP 402）：插件面板未就绪。'
    case 403:
      return '没有权限打开这个工作区的插件面板（HTTP 403）。'
    case 404:
      return '找不到这个工作区的插件面板（HTTP 404）；也可能当前账号不是成员。'
    case 502:
      return '插件面板未就绪（沙箱可能未启动）：dsh web 不可达（HTTP 502 · dsh.unavailable）。'
    case 503:
      return '插件面板服务未就绪（HTTP 503）：控制面可能缺少运行配置。'
    default:
      return status > 0
        ? `面板加载失败（HTTP ${status}）：插件面板未就绪。`
        : '面板加载失败：插件面板未就绪。'
  }
}

// ---------------------------------------------------------------------------
// Wave 1：面板清单 / 唤醒（docs/build/wave1.md §C/§D）
// ---------------------------------------------------------------------------
// 新链路不再依赖 /api/config 的独立反代源：
//   1. GET  /api/plugins/panels?workspaceId=   列已启用插件声明的面板；404 时降级为整页面板
//   2. POST /api/panels/wake {workspaceId}     唤醒 workspace runtime + 本地转发
//   3. iframe src = /w/<workspaceId>/dsh/      同源反代
// 503 dsh.not_running 是“面板未运行”，不是白屏，也不是“加载中”。

const PANELS_ROUTE_MISSING = new Set([404, 405, 501])

function asText(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function errorStatus(error) {
  return error && typeof error.status === 'number' ? error.status : 0
}

function errorCode(error) {
  return error && typeof error.code === 'string' ? error.code : ''
}

/** 面板清单接口地址；workspaceId 必填时也支持空串（返回无 query 的路径）。 */
export function panelsListPath(workspaceId) {
  const id = asText(workspaceId)
  return id === '' ? '/api/plugins/panels' : `/api/plugins/panels?workspaceId=${encodeURIComponent(id)}`
}

/** 老控制面的面板清单路径；新接口 404 时先试它，再决定是否降级。 */
export function legacyPanelsListPath(workspaceId) {
  const id = asText(workspaceId)
  return id === '' ? '' : `/api/workspaces/${encodeURIComponent(id)}/panels`
}

export function panelWakePath() {
  return '/api/panels/wake'
}

export function panelWakePayload(workspaceId) {
  return { workspaceId: asText(workspaceId) }
}

/** iframe 固定指向同源反代的根；不拼接面板自带 URL。 */
export function panelFramePath(workspaceId) {
  return panelProxyPath(workspaceId)
}

/** 404/405/501 视为清单接口未上线；页面降级但不白屏。 */
export function isPanelsListMissing(error) {
  return PANELS_ROUTE_MISSING.has(errorStatus(error))
}

/** 503 dsh.not_running：沙箱里的 DSH Web 没起来。 */
export function isDshNotRunning(error) {
  return errorStatus(error) === 503 && errorCode(error) === 'dsh.not_running'
}

/** 面板清单的容错：接受 {panels:[...]} 或裸数组；只保留有名字的对象。 */
export function panelsFromPayload(payload) {
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.panels)
      ? payload.panels
      : []
  const rows = []
  for (const item of list) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
    const name = asText(item.name) || asText(item.id) || asText(item.title)
    if (name === '') continue
    rows.push({
      name,
      title: asText(item.title),
      pluginSlug: asText(item.pluginSlug) || asText(item.slug),
      slot: asText(item.slot),
      path: asText(item.path),
    })
  }
  return rows
}

/**
 * 打开面板失败时的标题/说明。401 的跳转由调用方 requirePair 处理；
 * 这里只给“为什么”和“能不能重试”。
 */
export function panelOpenFailure(error) {
  const status = errorStatus(error)
  const code = errorCode(error)
  if (isDshNotRunning(error)) {
    return {
      title: '面板未运行',
      message:
        '沙箱里的 DSH Web 没有启动（HTTP 503 · dsh.not_running）。点「重试」会再次唤醒工作区；' +
        '一直失败请检查工作区运行时是否在跑。',
      retryable: true,
    }
  }
  if (status === 404) {
    return {
      title: '面板接口未就绪',
      message: '控制面还没有 POST /api/panels/wake（或返回 404）；这次没有打开面板，也没有假装打开。',
      retryable: true,
    }
  }
  if (status === 403) {
    return {
      title: '没有权限打开面板',
      message: '当前账号不是这个工作区的成员，或没有打开面板的权限。',
      retryable: false,
    }
  }
  if (code === 'network') {
    return {
      title: '连不上面板服务',
      message: '连不上控制面（网络中断）：面板没有打开。检查控制面是否在跑，然后重试。',
      retryable: true,
    }
  }
  if (code === 'timeout') {
    return {
      title: '面板加载超时',
      message: '唤醒成功但面板 iframe 在 15 秒内没有加载完成；DSH Web 可能还在启动。点「重试」再试。',
      retryable: true,
    }
  }
  if (status === 503) {
    return {
      title: '面板服务未就绪',
      message: `面板服务暂不可用（HTTP 503${code === '' ? '' : ` · ${code}`}）。稍后重试。`,
      retryable: true,
    }
  }
  return {
    title: status > 0 ? `面板打开失败（HTTP ${status}）` : '面板打开失败',
    message: error instanceof Error && error.message ? error.message : '没有可用的错误信息。',
    retryable: true,
  }
}
