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
