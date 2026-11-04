// profile 插件分发：复制包、维护 cordis.patch.yml、幂等且不动别人的条目。
//
// 全部在临时目录里做，不碰真实 $DSH_HOME。

import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { installProfilePlugin, upsertPatch } from '../profile-plugins.mjs'

function tempRoot(t: { after: (fn: () => void) => void }): string {
  const root = mkdtempSync(join(tmpdir(), 'roost-profile-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

/** 造一个最小插件包：package.json + src/plugin.ts + 一个嵌套文件（验证递归复制）。 */
function makePackage(root: string): string {
  const dir = join(root, 'pkg')
  mkdirSync(join(dir, 'src', 'nested'), { recursive: true })
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: '@roost/approvals-bridge', version: '0.0.0', type: 'module', main: './src/index.ts', exports: { '.': './src/index.ts' } }, null, 2) + '\n',
  )
  writeFileSync(join(dir, 'src', 'plugin.ts'), [
    "import type { Marker } from './types.ts'",
    "import { helper } from './helper.ts'",
    'export function apply(ctx: unknown, config: { x?: number }): number {',
    '  return helper(config.x ?? 0)',
    '}',
    '',
  ].join('\n'))
  writeFileSync(join(dir, 'src', 'types.ts'), 'export interface Marker { readonly id: string }\n')
  writeFileSync(join(dir, 'src', 'helper.ts'), 'export function helper(value: number): number { return value + 1 }\n')
  writeFileSync(join(dir, 'src', 'index.ts'), 'export { apply } from "./plugin.ts"\n')
  writeFileSync(join(dir, 'src', 'nested', 'note.txt'), 'copied\n')
  return dir
}

const CONFIG = {
  apiBase: 'http://host.openshell.internal:8792',
  runtimeToken: 'rt_secret',
  workspaceId: 'ws_1',
  botId: 'bot_1',
  timeoutMs: 300_000,
}

function install(root: string, overrides: Record<string, unknown> = {}) {
  return installProfilePlugin({
    dshHome: join(root, 'dsh'),
    profile: 'sdk',
    packageDir: join(root, 'pkg'),
    configJson: CONFIG,
    ...overrides,
  })
}

function readPatch(profileDir: string): string {
  return readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')
}

function configOf(patch: string): unknown {
  const line = patch.split('\n').find((entry) => entry.trim().startsWith('config:'))
  assert.notEqual(line, undefined)
  return JSON.parse(line!.trim().slice('config:'.length).trim())
}

test('全新 profile：按 shipped sdk 模板建 package.json，并写根配置与 patch', (t) => {
  const root = tempRoot(t)
  makePackage(root)
  const result = install(root)

  const manifest = JSON.parse(readFileSync(join(result.profileDir, 'package.json'), 'utf8'))
  assert.equal(manifest.name, 'dsh-profile-sdk')
  assert.deepEqual(manifest.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-sdk-app'])
  assert.equal(readFileSync(join(result.profileDir, 'cordis.yml'), 'utf8').trim(), '[]')
  assert.equal(result.patched, true)
})

test('复制插件包到 node_modules，把 TS 擦成 JS 并把入口改指到 src/plugin.js', (t) => {
  const root = tempRoot(t)
  makePackage(root)
  const result = install(root)

  const target = join(result.profileDir, 'node_modules', '@roost', 'approval-bridge')
  assert.equal(result.packageDir, target)
  assert.match(readFileSync(join(target, 'src', 'plugin.ts'), 'utf8'), /export function apply/)
  const emitted = readFileSync(join(target, 'src', 'plugin.js'), 'utf8')
  assert.match(emitted, /export function apply/)
  // 类型被擦掉、相对说明符改成 .js：这两条是 node_modules 能加载的前提。
  assert.doesNotMatch(emitted, /: unknown/)
  assert.match(emitted, /from '\.\/helper\.js'/)
  // 相对 .ts 说明符必须改写成 .js，否则 node_modules 里加载不了。
  assert.match(readFileSync(join(target, 'src', 'index.js'), 'utf8'), /from "\.\/plugin\.js"/)
  assert.equal(readFileSync(join(target, 'src', 'nested', 'note.txt'), 'utf8'), 'copied\n')
  const manifest = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'))
  assert.equal(manifest.main, './src/plugin.js')
  assert.deepEqual(manifest.exports, { '.': './src/plugin.js' })
  assert.equal(manifest.type, 'module')
})

test('patch 里有且只有一个 insert 条目，config 可被 JSON 解析', (t) => {
  const root = tempRoot(t)
  makePackage(root)
  const { profileDir } = install(root)
  const patch = readPatch(profileDir)

  assert.equal(patch.match(/- insert:/g)?.length, 1)
  assert.equal(patch.match(/id: "roost-approval-bridge"/g)?.length, 1)
  assert.match(patch, /name: "@roost\/approval-bridge"/)
  assert.deepEqual(configOf(patch), CONFIG)
})

test('幂等：同样的配置第二次运行不写文件（patched=false，内容不变）', (t) => {
  const root = tempRoot(t)
  makePackage(root)
  const first = install(root)
  const before = readPatch(first.profileDir)

  const second = install(root)
  assert.equal(second.profileDir, first.profileDir)
  assert.equal(second.patched, false)
  assert.equal(readPatch(first.profileDir), before)
  assert.equal(before.match(/roost-approval-bridge/g)?.length, 3) // start / id / end 三处
})

test('更新：token 变了就原地替换 config，不新增第二个条目', (t) => {
  const root = tempRoot(t)
  makePackage(root)
  const first = install(root)
  const second = install(root, { configJson: { ...CONFIG, runtimeToken: 'rt_rotated' } })

  assert.equal(second.patched, true)
  const patch = readPatch(first.profileDir)
  assert.equal(patch.match(/- insert:/g)?.length, 1)
  assert.equal(patch.match(/id: "roost-approval-bridge"/g)?.length, 1)
  assert.equal((configOf(patch) as Record<string, unknown>).runtimeToken, 'rt_rotated')
})

test('不破坏已有 patch：注释与别人的 insert 原样保留', (t) => {
  const root = tempRoot(t)
  makePackage(root)
  const dshHome = join(root, 'dsh')
  const profileDir = join(dshHome, 'profiles', 'sdk')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-sdk', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-sdk-app'] } } }))
  const existing = [
    '# keep this comment',
    '- id: agent-default-model',
    '  name: "@deepseek-ai/dsh-agent-default-model"',
    '  config:',
    '    provider: deepseek-account',
    '',
    '- insert:',
    '    - id: someone-else',
    '      name: "@deepseek-ai/dsh-mcp-client"',
    '      config: {"serverName":"team-kb"}',
    '',
  ].join('\n')
  writeFileSync(join(profileDir, 'cordis.patch.yml'), existing)

  const result = install(root)
  const patch = readPatch(result.profileDir)
  assert.ok(patch.startsWith(existing.trimEnd()))
  assert.match(patch, /# keep this comment/)
  assert.match(patch, /id: someone-else/)
  assert.equal(patch.match(/- insert:/g)?.length, 2)
})

test('模板 `[]`：替换成 insert 块，不留下第二个 YAML 根节点', (t) => {
  const root = tempRoot(t)
  makePackage(root)
  const dshHome = join(root, 'dsh')
  const profileDir = join(dshHome, 'profiles', 'sdk')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-sdk', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-sdk-app'] } } }))
  writeFileSync(join(profileDir, 'cordis.patch.yml'), '# Your patch layer\n[]\n')

  const result = install(root)
  const patch = readPatch(result.profileDir)
  assert.match(patch, /# Your patch layer/)
  assert.doesNotMatch(patch, /^\[\]$/m)
  assert.equal(patch.match(/- insert:/g)?.length, 1)
})

test('已存在自定义 profile：保留它自己的 bundles，不覆盖 package.json', (t) => {
  const root = tempRoot(t)
  makePackage(root)
  const dshHome = join(root, 'dsh')
  const profileDir = join(dshHome, 'profiles', 'sdk')
  mkdirSync(profileDir, { recursive: true })
  const custom = { name: 'my-profile', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify(custom))

  const result = install(root)
  assert.deepEqual(JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')), custom)
  assert.equal(result.patched, true)
})

test('手写同 id 条目：只改它的 config，同块里的兄弟条目保留', () => {
  const source = [
    '- insert:',
    '    - id: roost-approval-bridge',
    '      name: "@roost/approval-bridge"',
    '      config:',
    '        apiBase: http://old',
    '        runtimeToken: old',
    '    - id: sibling',
    '      name: "@deepseek-ai/dsh-mcp-client"',
    '      config: {"serverName":"kb"}',
    '',
  ].join('\n')
  const next = upsertPatch(source, {
    patchId: 'roost-approval-bridge',
    name: '@roost/approval-bridge',
    config: CONFIG,
  })
  assert.equal(next.match(/id: roost-approval-bridge/g)?.length, 1)
  assert.match(next, /id: sibling/)
  assert.match(next, /serverName/)
  assert.deepEqual(configOf(next), CONFIG)
  assert.doesNotMatch(next, /# >>> roost approval bridge/)
})

test('sentinel 只有开头没有结尾：拒绝改写（不猜边界，不吞后面的条目）', () => {
  const source = [
    '# >>> roost approval bridge: roost-approval-bridge (managed)',
    '- insert:',
    '    - id: roost-approval-bridge',
    '      name: "@roost/approval-bridge"',
    '',
    '- id: keep-me',
    '',
  ].join('\n')
  assert.throws(
    () => upsertPatch(source, { patchId: 'roost-approval-bridge', name: '@roost/approval-bridge', config: CONFIG }),
    /no end marker/,
  )
})

test('configJson 接受 JSON 字符串；数组/非法包名/非法 profile 被拒绝', (t) => {
  const root = tempRoot(t)
  makePackage(root)
  const result = install(root, { configJson: JSON.stringify(CONFIG) })
  assert.deepEqual(configOf(readPatch(result.profileDir)), CONFIG)

  assert.throws(() => install(root, { configJson: [1, 2, 3] }), /JSON object/)
  assert.throws(() => install(root, { profile: '../escape' }), /invalid profile name/)
  assert.throws(() => install(root, { name: 'not a package' }), /invalid package name/)
})

test('缺包目录 / 缺 plugin.ts 入口时明确报错（不做半安装）', (t) => {
  const root = tempRoot(t)
  const empty = join(root, 'empty')
  mkdirSync(empty, { recursive: true })
  assert.throws(() => install(root, { packageDir: empty }), /no package.json/)

  const noEntry = join(root, 'no-entry')
  mkdirSync(noEntry, { recursive: true })
  writeFileSync(join(noEntry, 'package.json'), JSON.stringify({ name: 'x' }))
  assert.throws(() => install(root, { packageDir: noEntry }), /no src\/plugin.ts entry/)
})
