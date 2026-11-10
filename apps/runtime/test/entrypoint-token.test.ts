// M3: RUNTIME_TOKEN is passed to the sidecar only. DSH must not inherit it.
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

const ENTRY = fileURLToPath(new URL('../entrypoint.sh', import.meta.url))

test('DSH does not see RUNTIME_TOKEN and the sidecar does', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'roost-entrypoint-'))
  const sidecarEnv = join(dir, 'sidecar.env')
  const dshEnv = join(dir, 'dsh.env')
  const sidecar = join(dir, 'sidecar.mjs')
  const dsh = join(dir, 'dsh')
  const profile = join(dir, 'profile')
  mkdirSync(profile)
  writeFileSync(
    sidecar,
    `import http from 'node:http'
import { writeFileSync } from 'node:fs'
writeFileSync(process.env.SIDECAR_ENV_OUT, process.env.RUNTIME_TOKEN ?? '')
const server = http.createServer((req, res) => { res.writeHead(200); res.end('ok') })
server.listen(Number(process.env.PORT), '127.0.0.1')
`,
  )
  writeFileSync(
    dsh,
    `#!/bin/sh
printf '%s' "\${RUNTIME_TOKEN-}" > "$DSH_ENV_OUT"
trap 'exit 0' TERM INT
while :; do sleep 1; done
`,
  )
  chmodSync(dsh, 0o755)
  try {
    const port = await freePort()
    const child = spawn('sh', [ENTRY], {
      env: {
        PATH: process.env.PATH ?? '',
        UPSTREAM: 'http://127.0.0.1:9',
        RUNTIME_TOKEN: 'rt_entrypoint_secret',
        BASE_PATH: '/w/ws_test',
        PORT: String(port),
        DSH_BIN: dsh,
        DSH_PROFILE: profile,
        SIDECAR_SCRIPT: sidecar,
        NODE_BIN: process.execPath,
        SIDECAR_ENV_OUT: sidecarEnv,
        DSH_ENV_OUT: dshEnv,
        DSH_HOME: join(dir, 'dsh-home'),
        DSH_SUBCOMMAND: '',
      },
    })
    const result = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
      let stderr = ''
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk) => {
        stderr += chunk
      })
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
      }, 8000)
      const poll = setInterval(() => {
        try {
          if (readFileSync(dshEnv, 'utf8').length >= 0 && readFileSync(sidecarEnv, 'utf8').length >= 0) {
            clearInterval(poll)
            child.kill('SIGTERM')
          }
        } catch {
          // files appear after each process starts
        }
      }, 50)
      child.on('close', (code) => {
        clearTimeout(timer)
        clearInterval(poll)
        resolve({ code, stderr })
      })
    })
    assert.equal(result.code, 0, result.stderr)
    assert.equal(readFileSync(sidecarEnv, 'utf8'), 'rt_entrypoint_secret')
    assert.equal(readFileSync(dshEnv, 'utf8'), '')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
