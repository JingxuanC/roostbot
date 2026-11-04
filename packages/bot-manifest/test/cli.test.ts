import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url))

const valid = {
  schema: 'roostbot.bot/v1',
  id: 'selector',
  name: '选股师',
  role: '选股',
  instructions: 'skills/selector.md',
}

function run(input: string, args: string[] = []) {
  return spawnSync(process.execPath, ['--experimental-strip-types', cli, ...args], {
    input,
    encoding: 'utf8',
  })
}

test('CLI：合法 manifest 从文件读取，退出码 0', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'roost-bot-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'bot.json')
  writeFileSync(file, JSON.stringify(valid))

  const result = run('', [file])
  assert.equal(result.status, 0)
  assert.equal(result.stdout, 'ok: bot selector\n')
})

test('CLI：合法 manifest 从 stdin 读取，退出码 0', () => {
  const result = run(JSON.stringify(valid))
  assert.equal(result.status, 0)
  assert.equal(result.stdout, 'ok: bot selector\n')
})

test('CLI：非法 manifest 退出码 1，错误可读', () => {
  const result = run(JSON.stringify({ ...valid, id: 'Bad ID' }))
  assert.equal(result.status, 1)
  assert.match(result.stderr, /invalid: stdin/)
  assert.match(result.stderr, /\$\.id: expected \/\^\[a-z\]/)
})

test('CLI：JSON 解析失败退出码 1', () => {
  const result = run(']')
  assert.equal(result.status, 1)
  assert.match(result.stderr, /^error: invalid JSON:/)
})

test('CLI：--help 退出码 0', () => {
  const result = run('', ['--help'])
  assert.equal(result.status, 0)
  assert.match(result.stdout, /用法：bot-manifest/)
})
