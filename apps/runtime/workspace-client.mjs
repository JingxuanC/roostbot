// workspace 生命周期的最小 HTTP 封装（控制面 `/api/workspaces/:id/start` 与 `/runtime`）。
//
// 这里只发请求、解析 JSON、把错误规范化成 WorkspaceApiError；**不自动执行**
// 任何后续动作（不轮询 runtime、不在失败时重启、不重试）。重试/退避由调用方决定。
//
// 错误形状统一为：
//   WorkspaceApiError { name, message, code, status, body, cause? }
//   - 控制面返回 {ok:false,error:{code,message}} → 沿用它的 code/message
//   - 2xx 但没有可用 body → 返回 {}
//   - 非 JSON / 网络失败 → code=http_<status> / network_error
//
// 鉴权用控制面的用户侧 Bearer 会话（workspace.md §9 的接口表）。

export class WorkspaceApiError extends Error {
  constructor(message, options = {}) {
    super(message)
    this.name = 'WorkspaceApiError'
    this.code = options.code ?? 'http_error'
    this.status = options.status ?? 0
    this.body = options.body
    if (options.cause !== undefined) this.cause = options.cause
  }
}

function trimBase(apiBase) {
  const base = String(apiBase ?? '').replace(/\/+$/, '')
  if (base === '') {
    throw new WorkspaceApiError('apiBase is required', { code: 'invalid_argument', status: 0 })
  }
  return base
}

function workspaceUrl(apiBase, workspaceId, suffix) {
  const id = String(workspaceId ?? '')
  if (id === '') {
    throw new WorkspaceApiError('workspaceId is required', { code: 'invalid_argument', status: 0 })
  }
  return `${trimBase(apiBase)}/api/workspaces/${encodeURIComponent(id)}${suffix}`
}

function requestHeaders(token) {
  return {
    accept: 'application/json',
    authorization: `Bearer ${String(token ?? '')}`,
    'content-type': 'application/json'
  }
}

/** 解析 body；2xx 时才返回内容。错误统一转成 WorkspaceApiError。 */
async function readResponse(response) {
  const text = await response.text().catch(() => '')
  let body
  if (text.trim() !== '') {
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
  }
  if (!response.ok) {
    const structured = typeof body === 'object' && body !== null ? body.error : undefined
    const code =
      typeof structured?.code === 'string' && structured.code !== ''
        ? structured.code
        : `http_${response.status}`
    const message =
      typeof structured?.message === 'string' && structured.message !== ''
        ? structured.message
        : `HTTP ${response.status}`
    throw new WorkspaceApiError(message, { code, status: response.status, body })
  }
  if (typeof body === 'object' && body !== null && body.ok === false) {
    const structured = body.error
    const code =
      typeof structured?.code === 'string' && structured.code !== '' ? structured.code : 'http_error'
    const message =
      typeof structured?.message === 'string' && structured.message !== ''
        ? structured.message
        : 'workspace request failed'
    throw new WorkspaceApiError(message, { code, status: response.status, body })
  }
  return body === undefined ? {} : body
}

async function send(url, init) {
  let response
  try {
    response = await fetch(url, init)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new WorkspaceApiError(`request failed: ${message}`, {
      code: 'network_error',
      status: 0,
      cause: error
    })
  }
  return readResponse(response)
}

/** 启动 workspace 的 home 沙箱：POST /api/workspaces/:id/start。 */
export async function startWorkspace(apiBase, token, workspaceId) {
  return send(workspaceUrl(apiBase, workspaceId, '/start'), {
    method: 'POST',
    headers: requestHeaders(token),
    body: '{}'
  })
}

/** 读 workspace 的 runtime 状态：GET /api/workspaces/:id/runtime。 */
export async function workspaceRuntime(apiBase, token, workspaceId) {
  return send(workspaceUrl(apiBase, workspaceId, '/runtime'), {
    method: 'GET',
    headers: requestHeaders(token)
  })
}
