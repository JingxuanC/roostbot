import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url))

const valid = {
  id: 'ev_cli',
  seq: 7,
  at: '2026-11-03T12:00:00Z',
  domain: 'chat',
  kind: 'chat.message',
  v: 1,
  payload: { text: 'hi' },
}

function run(input: string, args: string[] = []) {
  return spawnSync(process.execPath, ['--experimental-strip-types', cli, ...args], {
    input,
    encoding: 'utf8',
  })
}

test('CLI：合法事件从 stdin 读取，退出码 0', () => {
  const result = run(JSON.stringify(valid))
  assert.equal(result.status, 0)
  assert.equal(result.stdout, 'ok: event chat.message seq=7\n')
})

test('CLI：合法事件从文件读取，退出码 0', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'roost-event-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'event.json')
  writeFileSync(file, JSON.stringify(valid))

  const result = run('', [file])
  assert.equal(result.status, 0)
  assert.equal(result.stdout, 'ok: event chat.message seq=7\n')
})

test('CLI：非法事件退出码 1，错误可读', () => {
  const result = run(JSON.stringify({ ...valid, kind: 'chat.nope' }))
  assert.equal(result.status, 1)
  assert.match(result.stderr, /invalid: stdin/)
  assert.match(result.stderr, /\$\.kind: unknown kind "chat\.nope"/)
})

test('CLI：JSON 解析失败退出码 1', () => {
  const result = run('{not json')
  assert.equal(result.status, 1)
  assert.match(result.stderr, /^error: invalid JSON:/)
})

test('CLI：文件不存在退出码 1', () => {
  const result = run('', ['/tmp/roost-event-missing-file.json'])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /cannot read \/tmp\/roost-event-missing-file\.json/)
})
