#!/usr/bin/env node
// 官网本地预览：零依赖静态服务器，只服务 apps/site。
//   node scripts/serve-site.mjs           → http://127.0.0.1:4173
//   PORT=8080 node scripts/serve-site.mjs
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)), 'apps/site')
const port = Number(process.env.PORT ?? 4173)
const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const pathname = decodeURIComponent(url.pathname)
    const rel = normalize(pathname === '/' ? 'index.html' : pathname).replace(/^([/\\])+/, '')
    const file = resolve(join(root, rel))
    if (!file.startsWith(root)) {
      res.writeHead(403).end('forbidden')
      return
    }
    const info = await stat(file)
    if (!info.isFile()) throw new Error('not a file')
    const body = await readFile(file)
    res.writeHead(200, {
      'content-type': types[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-cache'
    })
    res.end(body)
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found')
  }
})

server.listen(port, '127.0.0.1', () => {
  console.log(`roost site: http://127.0.0.1:${port}`)
})
