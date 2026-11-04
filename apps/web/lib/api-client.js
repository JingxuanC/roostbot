// API 客户端：零依赖，只依赖注入的 fetch。
// 错误统一读 {ok:false,error:{code,message}}，message 原样交给界面显示在原地；
// 网络失败给出中文说明，绝不假装成功（docs/design/ui.md §1 诚实优先）。

export class ApiError extends Error {
  /**
   * @param {string} code 稳定错误码（未拿到服务端 code 时用 network / http_<status>）
   * @param {string} message 面向人的文案（优先服务端给的）
   * @param {{status?: number, body?: unknown, cause?: unknown}} [options]
   */
  constructor(code, message, options = {}) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = options.status
    this.body = options.body
    if (options.cause !== undefined) this.cause = options.cause
  }
}

export function isAuthError(error) {
  if (!(error instanceof ApiError)) return false
  return (
    error.status === 401 ||
    error.code === 'unauthenticated' ||
    error.code === 'session_expired' ||
    error.code === 'session_revoked'
  )
}

export function isMissingRoute(error) {
  return error instanceof ApiError && error.status === 404 && (error.code === 'not_found' || error.code === 'http_404')
}

function errorMessageFrom(status, payload, statusText) {
  const body = payload && typeof payload === 'object' ? payload : null
  const serverMessage = body?.error?.message ?? body?.message ?? body?.error_description ?? null
  if (typeof serverMessage === 'string' && serverMessage.trim() !== '') return serverMessage.trim()
  return `请求失败（HTTP ${status}${statusText ? ` ${statusText}` : ''}）`
}

/**
 * @param {{base?: string, getToken?: () => string, fetchImpl?: typeof fetch}} [options]
 */
export function createApiClient(options = {}) {
  const base = String(options.base ?? '').replace(/\/+$/, '')
  const getToken = typeof options.getToken === 'function' ? options.getToken : () => ''
  const fetchImpl = options.fetchImpl

  async function request(method, path, body) {
    const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null)
    if (!doFetch) {
      throw new ApiError('network', '这个环境没有 fetch，连不上 API')
    }
    const cleanPath = String(path ?? '').startsWith('/') ? String(path) : `/${String(path ?? '')}`
    const headers = {}
    const token = getToken()
    if (token) headers.authorization = `Bearer ${token}`
    if (body !== undefined) headers['content-type'] = 'application/json'

    let response
    try {
      response = await doFetch(`${base}${cleanPath}`, {
        method,
        headers,
        credentials: 'include',
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause)
      throw new ApiError('network', `连不上 API（${reason}）。检查控制面是否在跑。`, { cause })
    }

    let text = ''
    try {
      text = await response.text()
    } catch {
      text = ''
    }
    let payload = null
    if (text !== '') {
      try {
        payload = JSON.parse(text)
      } catch {
        payload = null
      }
    }

    const declaredFailure = payload !== null && typeof payload === 'object' && payload.ok === false
    if (!response.ok || declaredFailure) {
      const bodyError = payload && typeof payload === 'object' ? payload.error : null
      const code =
        bodyError && typeof bodyError.code === 'string' && bodyError.code !== ''
          ? bodyError.code
          : `http_${response.status}`
      const message = errorMessageFrom(response.status, payload, response.statusText)
      throw new ApiError(code, message, { status: response.status, body: payload })
    }

    return payload
  }

  /**
   * 读取二进制（附件/产物）。和 request 一样带 Authorization；
   * 401 等 HTTP 错误抛 ApiError，调用方用 isAuthError 走 requirePair。
   * 返回 { blob, contentType }。
   */
  async function getBlob(path) {
    const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null)
    if (!doFetch) {
      throw new ApiError('network', '这个环境没有 fetch，连不上 API')
    }
    const cleanPath = String(path ?? '').startsWith('/') ? String(path) : `/${String(path ?? '')}`
    const headers = {}
    const token = getToken()
    if (token) headers.authorization = `Bearer ${token}`

    let response
    try {
      response = await doFetch(`${base}${cleanPath}`, {
        method: 'GET',
        headers,
        credentials: 'include',
      })
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause)
      throw new ApiError('network', `连不上 API（${reason}）。检查控制面是否在跑。`, { cause })
    }

    if (!response.ok) {
      // 错误响应通常是 JSON；读不出正文时退回 HTTP 状态文案。
      let text = ''
      try {
        text = await response.text()
      } catch {
        text = ''
      }
      let payload = null
      if (text !== '') {
        try {
          payload = JSON.parse(text)
        } catch {
          payload = null
        }
      }
      const bodyError = payload && typeof payload === 'object' ? payload.error : null
      const code =
        bodyError && typeof bodyError.code === 'string' && bodyError.code !== ''
          ? bodyError.code
          : `http_${response.status}`
      throw new ApiError(code, errorMessageFrom(response.status, payload, response.statusText), {
        status: response.status,
        body: payload,
      })
    }

    let blob
    try {
      blob = await response.blob()
    } catch (cause) {
      throw new ApiError('network', '附件内容读取中断，请重试。', { cause })
    }
    let contentType = ''
    try {
      contentType = response.headers && typeof response.headers.get === 'function' ? response.headers.get('content-type') : ''
    } catch {
      contentType = ''
    }
    return { blob, contentType: String(contentType || blob?.type || '') }
  }

  return {
    request,
    get: (path) => request('GET', path),
    getBlob,
    post: (path, body) => request('POST', path, body),
    patch: (path, body) => request('PATCH', path, body),
    del: (path) => request('DELETE', path),
  }
}
