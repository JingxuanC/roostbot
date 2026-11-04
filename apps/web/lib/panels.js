// 插件面板（ADR 0004 / plugin-marketplace.md §3 C 级）：路径拼接、状态与失败文案。
// 纯函数，不碰 DOM；等价于 packages/plugins/src/surface.ts 的约定，但前端不能直接 import TS。
//
// 安全边界：iframe 的 src 只能由本模块生成——固定 `/w/<workspaceId>/dsh/` 前缀，
// panel.path 只允许 [A-Za-z0-9/_.-]，拒绝空段、`.`、`..` 与绝对路径，绝不接受任意 URL。

const WORKSPACE_ID = /^[A-Za-z0-9_-]+$/
const PANEL_PATH = /^[A-Za-z0-9/_.-]+$/
const MAX_PANEL_PATH = 512

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
