// 头像上传的纯逻辑（docs/build/m4-addendum.md §C、docs/design/bots.md §4）。
//
// 约束：只接受 PNG / JPEG / WebP / GIF，≤256KB，读成 dataURL 存进 avatar.image。
// 这里不碰 DOM，也不发请求；读文件只依赖 File 的 arrayBuffer()，因此在 node:test 里
// 可以直接用假 File 测（浏览器与 Node 20+ 都有 btoa / File.arrayBuffer）。
//
// 返回形状固定为 {ok:true,...} / {ok:false,error,code}，调用方只在 ok 时改 state；
// 失败时 state 保持不变，错误文案原样显示在原地。

/** 单张图片的上限：256KB（docs/build/m4-addendum.md §C）。 */
export const AVATAR_MAX_BYTES = 256 * 1024

/** 允许的 MIME；顺序就是 input accept 的顺序。 */
export const AVATAR_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/** 直接给 <input type=file accept="..."> 用。 */
export const AVATAR_ACCEPT = AVATAR_TYPES.join(',')

const DATA_URL_RE = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]*={0,2})$/

function fail(code, error) {
  return { ok: false, code, error }
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '未知大小'
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) {
    const kb = bytes / 1024
    return `${Number.isInteger(kb) ? kb : kb.toFixed(1)}KB`
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

/** base64 里实际装了多少字节（用于把 dataURL 大小再核一遍）。 */
function base64Bytes(text) {
  if (text.length % 4 !== 0) return -1
  const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0
  return (text.length / 4) * 3 - padding
}

function base64FromBytes(bytes) {
  if (typeof btoa === 'function') {
    // 分块，避免 256KB 时 String.fromCharCode(...array) 撑爆调用栈。
    let binary = ''
    const chunk = 0x8000
    for (let index = 0; index < bytes.length; index += chunk) {
      binary += String.fromCharCode(...bytes.subarray(index, index + chunk))
    }
    return btoa(binary)
  }
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64')
  return ''
}

/**
 * 校验一个值是不是我们接受的头像 dataURL。
 * 除了前缀与 base64 形状，还核对解码后字节数：>0 且 ≤256KB。
 */
export function isAvatarDataUrl(value) {
  if (typeof value !== 'string' || value.length === 0) return false
  const match = DATA_URL_RE.exec(value)
  if (!match) return false
  const bytes = base64Bytes(match[2])
  return bytes > 0 && bytes <= AVATAR_MAX_BYTES
}

/**
 * 头像的显示类型：上传过图片就是「自定义图片」，否则是程序化 glyph。
 * 坏值（类型不对 / 超限 / 空串）一律按程序化图标，避免把不能用的图片当真。
 */
export function avatarLabel(bot) {
  const avatar = bot && typeof bot === 'object' ? bot.avatar : null
  const image = avatar && typeof avatar === 'object' ? avatar.image : ''
  return isAvatarDataUrl(image) ? '自定义图片' : '程序化图标'
}

/**
 * 把用户选的 File 读成 dataURL。
 *
 * @param {{type?: string, size?: number, arrayBuffer?: () => Promise<ArrayBuffer>}} file
 * @returns {Promise<
 *   {ok: true, dataUrl: string, type: string, bytes: number} |
 *   {ok: false, code: string, error: string}
 * >}
 */
export async function readAvatarFile(file) {
  if (!file || typeof file !== 'object') {
    return fail('avatar.missing', '没有选择文件。')
  }

  const type = typeof file.type === 'string' ? file.type.trim().toLowerCase() : ''
  if (!AVATAR_TYPES.includes(type)) {
    return fail(
      'avatar.type',
      `只支持 PNG、JPEG、WebP、GIF；这个文件是 ${type === '' ? '未知类型' : type}。`
    )
  }

  const size = typeof file.size === 'number' ? file.size : Number.NaN
  if (!Number.isFinite(size) || size <= 0) {
    // size 为 0 时有些浏览器仍可读，但空文件没有意义。
    return fail('avatar.empty', '这个文件是空的，换一张图片。')
  }
  if (size > AVATAR_MAX_BYTES) {
    return fail('avatar.size', `图片不能超过 256KB（这个 ${formatBytes(size)}）。`)
  }

  if (typeof file.arrayBuffer !== 'function') {
    return fail('avatar.unreadable', '这个环境读不了文件，换一张试试。')
  }

  let buffer
  try {
    buffer = await file.arrayBuffer()
  } catch {
    return fail('avatar.unreadable', '读不出来这个文件，换一张试试。')
  }
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength === 0) {
    return fail('avatar.empty', '这个文件是空的，换一张图片。')
  }
  // 声明的大小可能不准（或被伪造）；以真正读到的字节数再卡一次。
  if (buffer.byteLength > AVATAR_MAX_BYTES) {
    return fail(
      'avatar.size',
      `图片不能超过 256KB（这个 ${formatBytes(buffer.byteLength)}）。`
    )
  }

  const encoded = base64FromBytes(new Uint8Array(buffer))
  if (encoded === '') {
    return fail('avatar.unreadable', '这个环境读不了文件，换一张试试。')
  }

  return {
    ok: true,
    dataUrl: `data:${type};base64,${encoded}`,
    type,
    bytes: buffer.byteLength,
  }
}
