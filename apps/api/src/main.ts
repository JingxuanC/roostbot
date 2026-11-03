#!/usr/bin/env node
// 控制面最小 API 的可执行入口。
//
//   PORT=8787 node --experimental-strip-types apps/api/src/main.ts
//
// v0 用内存 store：进程退出即丢状态，这是有意的（真实存储在 packages/store，
// 由 Lead 写适配器接上 port.ts 的 StorePort）。监听地址固定回环 127.0.0.1。
import { DEFAULT_HOST, DEFAULT_PORT, startServer } from './server.ts'
import type { StartedServer } from './server.ts'
import { createMemoryStore } from './memory-store.ts'
import { createStorePort } from './store-adapter.ts'
import { openStore } from '../../../packages/store/src/index.ts'

function readPort(): number {
  const raw = process.env['PORT']
  if (raw === undefined || raw.trim() === '') return DEFAULT_PORT
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`roost api: PORT must be an integer between 0 and 65535, got ${JSON.stringify(raw)}`)
    process.exit(2)
  }
  return port
}

function installShutdown(started: StartedServer): void {
  let closing = false
  const shutdown = (signal: string): void => {
    if (closing) return
    closing = true
    console.log(`roost api: ${signal} received, closing`)
    const timer = setTimeout(() => {
      console.error('roost api: close timed out, exiting')
      process.exit(1)
    }, 5000)
    timer.unref()
    started.close().then(
      () => {
        clearTimeout(timer)
        process.exit(0)
      },
      (err: unknown) => {
        console.error('roost api: close failed', err)
        process.exit(1)
      }
    )
  }
  process.once('SIGINT', () => shutdown('SIGINT'))
  process.once('SIGTERM', () => shutdown('SIGTERM'))
}

async function main(): Promise<void> {
  const port = readPort()
  // ROOST_DB 给了路径 = 用真实 SQLite 卷；否则内存实现（重启即丢，界面上会说明）。
  const dbPath = process.env.ROOST_DB
  const store = dbPath === undefined || dbPath === '' ? createMemoryStore() : createStorePort(openStore(dbPath))

  let started: StartedServer
  try {
    started = await startServer({ store, port, host: DEFAULT_HOST })
  } catch (err) {
    console.error(`roost api: failed to listen on ${DEFAULT_HOST}:${port}`, err)
    process.exitCode = 1
    return
  }

  console.log(`roost api listening on ${started.url} (${dbPath ?? "?"}${dbPath === undefined ? "memory store; state is lost on exit" : "sqlite store"})`)
  installShutdown(started)
}

await main()
