// dsh web 子进程封装（apps/runtime/dsh-web.mjs）+ room-agent 的后台接线。
//
// 假 bin 是临时目录里生成的 `dsh` shell 包装（指向一个真 node 脚本）：
//   - 打印 HTML 并常驻 → ready
//   - 200 但不是 HTML 壳 / 永不 listen / bin 不存在 → ready=false 且不抛
// 另有一条 room-agent 集成测试：默认开 dsh web、日志 `dsh web ready`、stop 时 kill。

import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { startDshWeb } from '../dsh-web.mjs'
import { startRoomAgent } from '../room-agent.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

const ARGV_RECORD = `
import { writeFileSync } from 'node:fs'
if (process.env.FAKE_ARGV_FILE) writeFileSync(process.env.FAKE_ARGV_FILE, process.argv.slice(2).join(' '))
`

// 200 + HTML 壳并常驻；收到 SIGTERM 正常退出。
const HTML_SCRIPT = `
import http from 'node:http'
${ARGV_RECORD}
const index = process.argv.indexOf('--port')
const port = index >= 0 ? Number(process.argv[index + 1]) : 0
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end('<!doctype html><html><body>panel</body></html>')
})
server.listen(port, '127.0.0.1')
const shutdown = () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 200) }
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
`

// 200 但不是 HTML（模拟端口被别的服务占了）。
const NOT_HTML_SCRIPT = `
import http from 'node:http'
const index = process.argv.indexOf('--port')
const port = index >= 0 ? Number(process.argv[index + 1]) : 0
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' })
  res.end('not the web ui')
})
server.listen(port, '127.0.0.1')
process.on('SIGTERM', () => process.exit(0))
`

// 永不 listen：占着进程等超时。
const NEVER_READY_SCRIPT = `
setInterval(() => {}, 1000)
process.on('SIGTERM', () => process.exit(0))
`

interface FakeBin {
  bin: string
  dir: string
  cleanup: () => Promise<void>
}

async function makeFakeBin(script: string): Promise<FakeBin> {
  const dir = await mkdtemp(join(tmpdir(), 'roost-dsh-web-'))
  const payload = join(dir, 'payload.mjs')
  await writeFile(payload, script, 'utf8')
  // shell 包装而不是 `#!node`：process.execPath 可能含空格（macOS app 路径）。
  const bin = join(dir, 'dsh')
  await writeFile(bin, `#!/bin/sh\nexec "${process.execPath}" "${payload}" "$@"\n`, 'utf8')
  await chmod(bin, 0o755)
  return { bin, dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createNetServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await sleep(20)
  }
  throw new Error(`condition not met within ${timeoutMs}ms`)
}

async function portClosed(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) })
    return false
  } catch {
    return true
  }
}

function processAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test('就绪：200 且 body 含 <!doctype html；参数是 dsh web --port <port> --no-open', async (t) => {
  const fake = await makeFakeBin(HTML_SCRIPT)
  const port = await freePort()
  const argvFile = join(fake.dir, 'argv.txt')
  t.after(async () => {
    await fake.cleanup()
  })

  const handle = await startDshWeb({
    bin: fake.bin,
    port,
    readyTimeoutMs: 5_000,
    env: { FAKE_ARGV_FILE: argvFile },
    log: () => {},
  })
  t.after(async () => {
    await handle.stop()
  })

  assert.equal(handle.ready, true)
  assert.equal(handle.port, port)
  assert.match(handle.url, new RegExp(`:${port}/$`))

  const response = await fetch(handle.url)
  assert.equal(response.status, 200)
  assert.match(await response.text(), /<!doctype html/i)

  await waitFor(async () => {
    try {
      return (await readFile(argvFile, 'utf8')) !== ''
    } catch {
      return false
    }
  })
  assert.equal((await readFile(argvFile, 'utf8')).trim(), `web --port ${port} --no-open`)
})

test('stop 幂等，停完端口真的关了', async (t) => {
  const fake = await makeFakeBin(HTML_SCRIPT)
  const port = await freePort()
  t.after(async () => {
    await fake.cleanup()
  })

  const handle = await startDshWeb({ bin: fake.bin, port, readyTimeoutMs: 5_000, log: () => {} })
  assert.equal(handle.ready, true)
  assert.equal(await portClosed(port), false)

  await handle.stop()
  await handle.stop() // 第二次必须是 no-op，不能抛
  assert.equal(await portClosed(port), true)
  assert.equal(processAlive(handle.pid), false)
})

test('200 但不是 HTML 壳 → ready=false，进程被 kill，不抛', async (t) => {
  const fake = await makeFakeBin(NOT_HTML_SCRIPT)
  const port = await freePort()
  t.after(async () => {
    await fake.cleanup()
  })

  const handle = await startDshWeb({
    bin: fake.bin,
    port,
    readyTimeoutMs: 600,
    pollIntervalMs: 20,
    log: () => {},
  })
  assert.equal(handle.ready, false)
  assert.equal(processAlive(handle.pid), false)
  assert.equal(await portClosed(port), true)
})

test('启动超时 → ready=false，不抛，子进程被 kill', async (t) => {
  const fake = await makeFakeBin(NEVER_READY_SCRIPT)
  const port = await freePort()
  t.after(async () => {
    await fake.cleanup()
  })

  const startedAt = Date.now()
  const handle = await startDshWeb({
    bin: fake.bin,
    port,
    readyTimeoutMs: 300,
    pollIntervalMs: 20,
    stopTimeoutMs: 500,
    log: () => {},
  })
  assert.equal(handle.ready, false)
  assert.ok(Date.now() - startedAt < 5_000, '超时后应立即返回，不等满默认时间')
  assert.equal(processAlive(handle.pid), false)
})

test('bin 不存在 → ready=false，不抛', async () => {
  const port = await freePort()
  const handle = await startDshWeb({
    bin: join(tmpdir(), 'roost-definitely-missing-dsh'),
    port,
    readyTimeoutMs: 1_000,
    log: () => {},
  })
  assert.equal(handle.ready, false)
  assert.equal(await portClosed(port), true)
})

test('abort 立刻中止启动（room-agent stop 用）', async (t) => {
  const fake = await makeFakeBin(NEVER_READY_SCRIPT)
  const port = await freePort()
  t.after(async () => {
    await fake.cleanup()
  })

  const controller = new AbortController()
  const pending = startDshWeb({
    bin: fake.bin,
    port,
    readyTimeoutMs: 10_000,
    pollIntervalMs: 50,
    signal: controller.signal,
    log: () => {},
  })
  await sleep(100)
  const startedAt = Date.now()
  controller.abort()
  const handle = await pending
  assert.equal(handle.ready, false)
  assert.ok(Date.now() - startedAt < 5_000)
  assert.equal(processAlive(handle.pid), false)
})

// ---- room-agent 接线 ---------------------------------------------------------

async function quietControlPlane(): Promise<{ base: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ rooms: [] }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    base: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      }),
  }
}

test('room-agent：默认启动 dsh web，日志 dsh web ready，stop 时一起退出', async (t) => {
  const fakeWeb = await makeFakeBin(HTML_SCRIPT)
  const cp = await quietControlPlane()
  const port = await freePort()
  const lines: string[] = []
  t.after(async () => {
    await fakeWeb.cleanup()
    await cp.close()
  })

  const agent = await startRoomAgent({
    apiBase: cp.base,
    runtimeToken: 'rt',
    botId: 'selector',
    dshBin: join(HERE, 'fake-dsh.mjs'),
    dshWebBin: fakeWeb.bin,
    dshWebPort: port,
    dshWebReadyTimeoutMs: 5_000,
    pollMs: 50,
    log: (line: string) => lines.push(line),
  })
  t.after(async () => {
    await agent.stop()
  })

  await waitFor(() => lines.includes('dsh web ready'))
  const response = await fetch(`http://127.0.0.1:${port}/`)
  assert.equal(response.status, 200)

  await agent.stop()
  assert.equal(await portClosed(port), true)
})

test('ROOST_DSH_WEB=0 时不启 dsh web', async (t) => {
  const marker = join(tmpdir(), `roost-dsh-web-disabled-${process.pid}-${Date.now()}.txt`)
  const fakeWeb = await makeFakeBin(`
import { writeFileSync } from 'node:fs'
writeFileSync(${JSON.stringify(marker)}, 'started')
setInterval(() => {}, 1000)
`)
  const cp = await quietControlPlane()
  const previous = process.env.ROOST_DSH_WEB
  process.env.ROOST_DSH_WEB = '0'
  const lines: string[] = []
  t.after(async () => {
    if (previous === undefined) delete process.env.ROOST_DSH_WEB
    else process.env.ROOST_DSH_WEB = previous
    await fakeWeb.cleanup()
    await cp.close()
    await rm(marker, { force: true })
  })

  const agent = await startRoomAgent({
    apiBase: cp.base,
    runtimeToken: 'rt',
    botId: 'selector',
    dshBin: join(HERE, 'fake-dsh.mjs'),
    dshWebBin: fakeWeb.bin,
    dshWebPort: await freePort(),
    pollMs: 50,
    log: (line: string) => lines.push(line),
  })
  t.after(async () => {
    await agent.stop()
  })

  await sleep(200)
  assert.equal(lines.includes('dsh web ready'), false)
  await assert.rejects(readFile(marker, 'utf8'), 'dsh web 不该被启动')
})
