// 测试用控制面：内部房间/消息/assignments/advance/say/round，全部本地假实现。
//
// options:
//   rooms           内部接口返回的房间（含 members）
//   messages        房间消息（按 seq 增量返回）
//   assignments     房间 → RoundAssignment[]；对象/函数/数字(状态码)；缺省 = 404
//   round           GET …/round 返回的 round；函数或 {roomId: value} 映射；缺省 = 404
//   stopping        同上的 stopping 字段（stop 轮询用）；advance 命中该 slot 后清空
//   failRooms       GET /api/internal/rooms 先失败几次（测退避）
//   failMessages    GET …/messages 先失败几次
//   advanceStatus   advance 失败的状态码（如 409 = 轮次已结束、408 = 超时）
//   advanceFailCount 前 N 次 advance 用 advanceStatus 失败（缺省 Infinity）
//   advanceDelayMs  前 advanceDelayCount 次 advance 延迟这么久再回（测请求超时）
import { createServer } from 'node:http'

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => resolve(body))
  })
}

/** 函数 / {roomId: value} 映射 / 静态值 三选一。 */
function resolveValue(spec, roomId) {
  if (typeof spec === 'function') return spec(roomId)
  if (spec !== null && typeof spec === 'object' && !Array.isArray(spec) && Object.prototype.hasOwnProperty.call(spec, roomId)) {
    return spec[roomId]
  }
  return spec
}

export async function createFakeControlPlane(options = {}) {
  const state = {
    rooms: options.rooms ?? [{ id: 'rm_test', members: [] }],
    messages: options.messages ?? [],
    assignments: options.assignments,
    round: options.round,
    stopping: options.stopping,
    failRooms: options.failRooms ?? 0,
    failMessages: options.failMessages ?? 0,
    advanceStatus: options.advanceStatus ?? 0,
    advanceFailCount: options.advanceFailCount ?? Number.POSITIVE_INFINITY,
    advanceDelayMs: options.advanceDelayMs ?? 0,
    advanceDelayCount: options.advanceDelayCount ?? 1,
    roomsRequests: 0,
    roundRequests: 0,
    requests: [],
    said: [],
    advances: [],
    advanceAttempts: []
  }

  function clearStopping(roomId, slotIndex) {
    const current = resolveValue(state.stopping, roomId)
    if (current !== slotIndex || current === null) return
    if (state.stopping !== null && typeof state.stopping === 'object' && !Array.isArray(state.stopping)) {
      if (Object.prototype.hasOwnProperty.call(state.stopping, roomId)) {
        state.stopping[roomId] = null
        return
      }
    }
    state.stopping = null
  }

  function assignmentsFor(roomId) {
    const spec = state.assignments
    if (spec === undefined || spec === null) return { status: 404 }
    let value = spec
    if (typeof spec === 'function') value = spec(roomId)
    else if (!Array.isArray(spec) && typeof spec === 'object') value = spec[roomId]
    if (value === undefined) return { status: 404 }
    if (typeof value === 'number') return { status: value }
    if (value !== null && typeof value === 'object' && !Array.isArray(value) && typeof value.status === 'number') {
      return value
    }
    return { status: 200, body: value }
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://local')
    const path = url.pathname
    state.requests.push({ method: req.method, path, at: Date.now() })
    const json = (status, payload) => {
      if (res.writableEnded || res.destroyed) return
      res.statusCode = status
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(payload))
    }

    if (req.method === 'GET' && path === '/api/internal/rooms') {
      state.roomsRequests += 1
      if (state.failRooms > 0) {
        state.failRooms -= 1
        json(500, { ok: false, error: { code: 'unavailable', message: 'control plane down' } })
        return
      }
      json(200, { rooms: state.rooms })
      return
    }

    const roundMatch = /^\/api\/internal\/rooms\/([^/]+)\/round$/.exec(path)
    if (req.method === 'GET' && roundMatch !== null) {
      state.roundRequests += 1
      if (state.round === undefined && state.stopping === undefined) {
        json(404, { ok: false, error: { code: 'not_found', message: 'round unavailable' } })
        return
      }
      const roomId = decodeURIComponent(roundMatch[1])
      json(200, {
        round: resolveValue(state.round, roomId),
        stopping: resolveValue(state.stopping, roomId)
      })
      return
    }

    const messagesMatch = /^\/api\/internal\/rooms\/([^/]+)\/messages$/.exec(path)
    if (req.method === 'GET' && messagesMatch !== null) {
      if (state.failMessages > 0) {
        state.failMessages -= 1
        json(503, { ok: false, error: { code: 'unavailable', message: 'messages down' } })
        return
      }
      const roomId = decodeURIComponent(messagesMatch[1])
      const after = Number(url.searchParams.get('after') ?? '0')
      json(200, { messages: state.messages.filter((m) => m.roomId === undefined || m.roomId === roomId).filter((m) => m.seq > after) })
      return
    }

    const assignmentsMatch = /^\/api\/internal\/rooms\/([^/]+)\/assignments$/.exec(path)
    if (req.method === 'GET' && assignmentsMatch !== null) {
      const roomId = decodeURIComponent(assignmentsMatch[1])
      const found = assignmentsFor(roomId)
      if (found.status !== 200) {
        json(found.status, { ok: false, error: { code: 'not_found', message: 'assignments unavailable' } })
        return
      }
      json(200, Array.isArray(found.body) ? { assignments: found.body } : found.body)
      return
    }

    const advanceMatch = /^\/api\/internal\/rounds\/([^/]+)\/advance$/.exec(path)
    if (req.method === 'POST' && advanceMatch !== null) {
      const body = await readBody(req)
      const parsed = body.trim() === '' ? {} : JSON.parse(body)
      const roundId = decodeURIComponent(advanceMatch[1])
      const attempt = { roundId, ...parsed, at: Date.now() }
      state.advanceAttempts.push(attempt)
      const attemptNumber = state.advanceAttempts.length
      if (state.advanceStatus >= 400 && attemptNumber <= state.advanceFailCount) {
        attempt.status = state.advanceStatus
        json(state.advanceStatus, { ok: false, error: { code: 'round_conflict', message: 'round is not running' } })
        return
      }
      if (state.advanceDelayMs > 0 && attemptNumber <= state.advanceDelayCount) {
        await sleep(state.advanceDelayMs)
      }
      state.advances.push(attempt)
      clearStopping(decodeURIComponent(advanceMatch[1]), parsed.slotIndex)
      json(200, { ok: true })
      return
    }

    const sayMatch = /^\/api\/rooms\/([^/]+)\/say$/.exec(path)
    if (req.method === 'POST' && sayMatch !== null) {
      const body = await readBody(req)
      const parsed = body.trim() === '' ? {} : JSON.parse(body)
      state.said.push({ roomId: decodeURIComponent(sayMatch[1]), ...parsed })
      json(201, { ok: true })
      return
    }

    json(404, { ok: false, error: { code: 'not_found', message: `no route ${req.method} ${path}` } })
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0

  return {
    base: `http://127.0.0.1:${port}`,
    state,
    get said() {
      return state.said
    },
    get advances() {
      return state.advances
    },
    async close() {
      await new Promise((resolve) => {
        server.close(resolve)
        server.closeAllConnections?.()
      })
    }
  }
}
