// 设计见 docs/design/artifacts.md。只有类型与渲染策略判定。

export type ArtifactKind = 'image' | 'pdf' | 'html' | 'table' | 'code' | 'page'

export interface ArtifactRef {
  id: string          // 内容寻址
  kind: ArtifactKind
  name: string
  size: number
  mime: string
  thumbId?: string
}

/** 渲染策略：决定聊天流里画什么、能不能内联。 */
export type RenderMode =
  | 'inline-image'    // 缩略图内联，点击放大
  | 'card-preview'    // 卡片 + 缩略图 + 下载
  | 'card-download'   // 只给下载（过大/不可预览）
  | 'code-block'      // 代码块
  | 'sandbox-frame'   // HTML/页面：独立源 iframe 或新标签
  | 'table-preview'   // 前 N 行

export function renderModeOf(kind: ArtifactKind, size: number, mime: string): RenderMode {
  if (kind === 'image') return size > MAX_INLINE_IMAGE_BYTES ? 'card-download' : 'inline-image'
  if (kind === 'pdf') return 'card-preview'
  if (kind === 'html') return 'sandbox-frame'
  if (kind === 'page') return 'sandbox-frame'
  if (kind === 'table') return 'table-preview'
  if (kind === 'code') return 'code-block'
  // 未知类型：按 mime 兜底
  if (mime.startsWith('image/')) return 'inline-image'
  return 'card-download'
}

export const MAX_INLINE_IMAGE_BYTES = 8 * 1024 * 1024
export const MAX_ARTIFACT_BYTES = 50 * 1024 * 1024
export const PREVIEW_ROWS = 20
export const THUMB_LONG_EDGE = 640
export const INLINE_IMAGE_LONG_EDGE = 320
export const PAGE_VERSIONS_KEPT = 10

/** HTML/SVG 永远不能内联进聊天 DOM：它们是脚本。 */
export function requiresSandbox(kind: ArtifactKind, mime: string): boolean {
  return kind === 'html' || kind === 'page' || mime === 'image/svg+xml' || mime === 'text/html'
}

/** 哪些产物可以生成缩略图（PDF 首页也算）。 */
export function canThumbnail(kind: ArtifactKind, mime: string): boolean {
  return kind === 'image' || kind === 'pdf' || mime.startsWith('image/')
}

/** 过大的产物只给下载，避免渲染卡死。 */
export function shouldDownloadOnly(kind: ArtifactKind, size: number, longEdge?: number): boolean {
  if (size > MAX_ARTIFACT_BYTES) return true
  if (longEdge !== undefined && longEdge > 8000) return true
  return kind === 'table' && size > 20 * 1024 * 1024
}

/** 消息级授权：只有消息里明确引用的产物才能被下载。 */
export function messageMayServe(messageArtifactIds: readonly string[], requestedId: string): boolean {
  return messageArtifactIds.includes(requestedId)
}
