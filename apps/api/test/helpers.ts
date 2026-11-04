// 测试脚手架：每个测试起一个独立的 server（随机端口、独立内存 store、注入时钟），
// 结束用 t.after 关掉。不要跨测试复用 server —— 全局失败窗口是 per-server 的。
import { openStore } from '../../../packages/store/src/index.ts'
import type { Store } from '../../../packages/store/src/types.ts'
import { createMemoryStore } from '../src/memory-store.ts'
import { startServer } from '../src/server.ts'
import { createStorePort } from '../src/store-adapter.ts'
import type { StorePort } from '../src/port.ts'

export const TEST_ACCOUNT = 'acc_test_one'

export interface ManualClock {
  now: () => number
  advance: (ms: number) => void
  set: (value: number) => void
}

export function manualClock(start = Date.UTC(2026, 10, 3, 12, 0, 0)): ManualClock {
  let current = start
  return {
    now: () => current,
    advance(ms: number) {
      current += ms
    },
    set(value: number) {
      current = value
    }
  }
}

export interface CallOptions {
  body?: unknown
  rawBody?: string
  token?: string
  headers?: Record<string, string>
}

export interface ApiResult {
  status: number
  headers: Headers
  json: any
  /** 原始响应文本（HTML 等非 JSON 响应用）。 */
  text: string
}

export interface Harness {
  store: StorePort
  clock: ManualClock
  baseUrl: string
  call: (method: string, path: string, options?: CallOptions) => Promise<ApiResult>
  close: () => Promise<void>
  /** 仅 SQLite harness 有：设备/会话/事件相关接口需要它。 */
  rawStore?: Store
}

function makeCaller(baseUrl: string) {
  return async function call(method: string, path: string, options: CallOptions = {}): Promise<ApiResult> {
    const headers: Record<string, string> = { ...(options.headers ?? {}) }
    if (options.token !== undefined) headers['authorization'] = `Bearer ${options.token}`

    let body: string | undefined
    if (options.rawBody !== undefined) {
      body = options.rawBody
      if (headers['content-type'] === undefined) headers['content-type'] = 'application/json'
    } else if (options.body !== undefined) {
      body = JSON.stringify(options.body)
      if (headers['content-type'] === undefined) headers['content-type'] = 'application/json'
    }

    const init: RequestInit = { method, headers }
    if (body !== undefined) init.body = body
    const response = await fetch(`${baseUrl}${path}`, init)
    const text = await response.text()
    let json: any = null
    if (text !== '') {
      try {
        json = JSON.parse(text)
      } catch {
        json = { __unparsed: text }
      }
    }
    return { status: response.status, headers: response.headers, json, text }
  }
}

export interface HarnessOptions {
  /** 假上游 dsh web 端口（反代测试用）；不传则用默认 4099。 */
  dshWebPort?: number
}

export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const store = createMemoryStore()
  const clock = manualClock()
  const started = await startServer({
    store,
    now: clock.now,
    port: 0,
    host: '127.0.0.1',
    ...(options.dshWebPort === undefined ? {} : { dshWebPort: options.dshWebPort }),
  })

  return {
    store,
    clock,
    baseUrl: started.url,
    call: makeCaller(started.url),
    close: started.close
  }
}

/**
 * 真实 SQLite（:memory:）+ store-adapter 的 harness。
 * 设备列表/吊销、会话续期、auth.session.revoked 事件都依赖 rawStore，只有它能测。
 */
export async function startSqliteHarness(options: HarnessOptions = {}): Promise<Harness> {
  const rawStore = openStore(':memory:')
  const store = createStorePort(rawStore)
  const clock = manualClock()
  const started = await startServer({
    store,
    rawStore,
    now: clock.now,
    port: 0,
    host: '127.0.0.1',
    ...(options.dshWebPort === undefined ? {} : { dshWebPort: options.dshWebPort }),
  })

  return {
    store,
    rawStore,
    clock,
    baseUrl: started.url,
    call: makeCaller(started.url),
    close: async () => {
      await started.close()
      rawStore.close()
    }
  }
}

/**
 * 走完配对码 → claim，返回会话 token（测试里最常用的前置动作）。
 * token 用于同账号第二次签发：配对码鉴权要求有会话时必须带 Bearer。
 */
export async function pairDevice(harness: Harness, workspaceId?: string, token?: string): Promise<string> {
  const minted = await harness.call('POST', '/api/pairing/code', {
    body: workspaceId === undefined ? { accountId: TEST_ACCOUNT } : { accountId: TEST_ACCOUNT, workspaceId },
    ...(token === undefined ? {} : { token })
  })
  if (minted.status !== 200) throw new Error(`mint failed: ${minted.status} ${JSON.stringify(minted.json)}`)

  const claimed = await harness.call('POST', '/api/pairing/claim', { body: { code: minted.json.code } })
  if (claimed.status !== 200) throw new Error(`claim failed: ${claimed.status} ${JSON.stringify(claimed.json)}`)
  return claimed.json.sessionToken as string
}
