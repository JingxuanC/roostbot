/**
 * `?api=` 只接受回环或当前页面的源。其它地址会被丢掉，避免钓鱼链接把配对码送到别的主机。
 * @param {string | null | undefined} raw
 * @param {string} pageOrigin
 * @returns {string}
 */
export function resolveApiBase(raw, pageOrigin) {
  const value = String(raw ?? '').trim().replace(/\/+$/, '')
  if (value === '') return ''
  let url
  try {
    url = new URL(value)
  } catch {
    return ''
  }
  if (url.username !== '' || url.password !== '') return ''
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
  let page
  try {
    page = new URL(pageOrigin)
  } catch {
    page = null
  }
  if (page !== null && url.origin === page.origin) return url.origin
  const host = url.hostname.toLowerCase()
  const loopback = host === 'localhost' || host === '127.0.0.1' || host === '::1'
  if (!loopback) return ''
  return url.origin
}
