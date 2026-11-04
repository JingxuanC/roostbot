// 插件面板的 UI 表面（ADR 0004）：沙箱里的 dsh web + 控制面反代 + iframe。
// 这里只有纯函数：路径拼接、iframe 属性、面板可否嵌入的判定。

/** 沙箱内 dsh web 监听的端口（只绑 127.0.0.1）。 */
export const DSH_WEB_PORT = 4099

/** 反代路径前缀：/w/<workspaceId>/dsh/ */
export function dshWebBasePath(workspaceId: string): string {
  const safe = workspaceId.replace(/[^A-Za-z0-9_-]/g, '_')
  return `/w/${safe}/dsh/`
}

/** 某个面板（或整页）的 URL；panel 为空表示 DSH Web 根。 */
export function panelProxyUrl(workspaceId: string, panel?: string): string {
  const base = dshWebBasePath(workspaceId)
  if (panel === undefined || panel === '') return base
  const safePanel = panel.replace(/[^A-Za-z0-9_-]/g, '_')
  return `${base}?panel=${safePanel}`
}

/** iframe 必须带的属性：独立源、只给脚本、不给同源。 */
export function iframeAttrs(): { sandbox: string; referrerPolicy: string; allow: string } {
  return {
    sandbox: 'allow-scripts allow-forms allow-popups',
    referrerPolicy: 'no-referrer',
    allow: 'clipboard-write'
  }
}

/**
 * 面板能不能嵌：D 级（桌面专有）不能；没有面板的插件也不需要嵌。
 * C 级（client 半）在云端靠 DSH Web 渲染。
 */
export function canEmbedPanel(tier: 'A' | 'B' | 'C' | 'D', hasPanel: boolean): boolean {
  return hasPanel && tier !== 'D'
}

// ---- 面板清单与冒烟（wave1 §C / TODO 5.2.1） --------------------------------

/** 插件 manifest 里声明的一个面板。 */
export interface PanelDeclaration {
  id: string
  title: string
  slot: string
}

/**
 * 从插件 manifest 读面板声明（`manifest.panels`）。
 * 只认 `{ id, title, slot }` 三个非空字符串；缺一个就丢掉，不猜默认值。
 * panels 不是数组（含旧版的纯数量声明 `panels: 7`）时返回 []。
 */
export function panelsFromManifest(manifest: unknown): PanelDeclaration[] {
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) return []
  const declared = (manifest as Record<string, unknown>)['panels']
  if (!Array.isArray(declared)) return []

  const panels: PanelDeclaration[] = []
  for (const entry of declared) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
    const record = entry as Record<string, unknown>
    const id = readDeclarationText(record['id'])
    const title = readDeclarationText(record['title'])
    const slot = readDeclarationText(record['slot'])
    if (id === null || title === null || slot === null) continue
    panels.push({ id, title, slot })
  }
  return panels
}

function readDeclarationText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

export interface PanelSmokeOptions {
  /** 沙箱内 dsh web 端口。 */
  port?: number
  /** wave1 契约里的旧写法；与 port 等价，port 优先。 */
  webPort?: number
  /** 测试注入的 fetch。 */
  fetchImpl?: typeof fetch
  /** 单次请求超时（毫秒）；默认 1500。 */
  timeoutMs?: number
}

export interface PanelSmokeResult {
  ok: boolean
  reason?: 'bad_port' | 'unreachable' | 'bad_status' | 'not_html'
  /** bad_status 时的上游状态码。 */
  status?: number
}

/**
 * 面板容器冒烟：GET `http://127.0.0.1:<port>/` 必须 200 且 body 含 `<!doctype html`
 * （大小写不敏感）。失败返回 `{ ok: false, reason }`，不抛。
 */
export async function panelSmoke(options: PanelSmokeOptions = {}): Promise<PanelSmokeResult> {
  const port = options.port ?? options.webPort
  if (port === undefined || !Number.isInteger(port) || port <= 0 || port >= 65_536) {
    return { ok: false, reason: 'bad_port' }
  }
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as typeof fetch | undefined)
  if (typeof fetchImpl !== 'function') return { ok: false, reason: 'unreachable' }
  const timeoutMs =
    Number.isFinite(options.timeoutMs) && (options.timeoutMs as number) > 0
      ? (options.timeoutMs as number)
      : 1_500

  let response: Response
  try {
    response = await fetchImpl(`http://127.0.0.1:${port}/`, {
      method: 'GET',
      headers: { accept: 'text/html' },
      signal: AbortSignal.timeout(timeoutMs)
    })
  } catch {
    return { ok: false, reason: 'unreachable' }
  }

  if (response.status !== 200) {
    await response.text().catch(() => '')
    return { ok: false, reason: 'bad_status', status: response.status }
  }

  let body: string
  try {
    body = await response.text()
  } catch {
    return { ok: false, reason: 'unreachable' }
  }
  if (!body.toLowerCase().includes('<!doctype html')) return { ok: false, reason: 'not_html' }
  return { ok: true }
}
