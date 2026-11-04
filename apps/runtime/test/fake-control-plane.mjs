// 测试用控制面：内部房间/消息/assignments/advance/say，全部本地假实现。
//
// options:
//   rooms           内部接口返回的房间（含 members）
//   messages        房间消息（按 seq 增量返回）
//   assignments     房间 → RoundAssignment[]；对象/函数/数字(状态码)；缺省 = 404
//   failRooms       GET /api/internal/rooms 先失败几次（测退避）
//   failMessages    GET …/messages 先失败几次
//   advanceStatus   advance 固定返回的状态码（如 409 = 轮次已结束）
import { createServer } from 'node:http'

function readBody(req) {
  return new Promise((resolve) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => resolve(body))
  })
}

export async function createFakeControlPlane(options = {}) {
  const state = {
    rooms: options.rooms ?? [{ id: 'rm_test', members: [] }],
    messages: options.messages ?? [],
    assignments: options.assignments,
    failRooms: options.failRooms ?? 0,
    failMessages: options.failMessages ?? 0,
    advanceStatus: options.advanceStatus ?? 0,
    roomsRequests: 0,
    requests: [],
    said: [],
    advances: []
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
      if (state.advanceStatus >= 400) {
        json(state.advanceStatus, { ok: false, error: { code: 'round_not_running', message: 'round is not running' } })
        return
      }
      state.advances.push({
        roundId: decodeURIComponent(advanceMatch[1]),
        ...parsed,
        at: Date.now()
      })
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
