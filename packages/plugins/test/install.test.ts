// 安装纯逻辑：profile 锁输入、patch 行、预检、状态机（docs/build/wave1.md §B）。

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  INSTALL_PATCH_ID_PREFIX,
  JOB_EVENTS,
  JOB_STATES,
  buildProfileLock,
  compareVersions,
  disabledOnFailure,
  isJobEvent,
  isJobState,
  nextJobState,
  normalizePermissions,
  preflightInstall,
  renderInstallPatch,
  renderPluginPatchRow,
  satisfiesRange,
} from '../src/install.ts'
import {
  buildProfileLock as buildLockDocument,
  verifyProfileLock,
} from '../src/profile-lock.ts'
import { sha512Integrity } from '../src/trust.ts'

const NOW = Date.UTC(2026, 10, 4, 12, 0, 0)
const DAY = 24 * 60 * 60 * 1000
const INTEGRITY = 'sha512-1.2.0-placeholder'

function plugin(overrides: Record<string, unknown> = {}) {
  return {
    slug: 'market-center',
    publisherId: 'pub_roost',
    permissions: { tools: 12, network: ['api.tushare.pro'], credentials: ['tushare'], diskBytes: 320_000_000 },
    ...overrides,
  }
}

function version(overrides: Record<string, unknown> = {}) {
  return {
    version: '1.2.0',
    integrity: INTEGRITY,
    engines: '^0.2.1-alpha.2',
    manifest: { engines: '^0.2.1-alpha.2', routes: ['/api/market-center'] },
    permissions: { tools: 12, network: ['api.tushare.pro'], credentials: ['tushare'], diskBytes: 320_000_000 },
    publishedAt: NOW - 2 * DAY,
    ...overrides,
  }
}

function preflight(overrides: Record<string, unknown> = {}) {
  return preflightInstall({
    plugin: plugin(),
    version: version(),
    dshVersion: '0.2.1-rc.5',
    allowlist: 'market-center',
    minReleaseAgeMs: DAY,
    now: NOW,
    ...overrides,
  } as Parameters<typeof preflightInstall>[0])
}

// ---- semver ------------------------------------------------------------------

test('版本区间：^ / ~ / >= / 精确 / 分支 / prerelease', () => {
  assert.equal(satisfiesRange('0.2.1-rc.5', '^0.2.1-alpha.2'), true)
  assert.equal(satisfiesRange('0.3.0', '^0.2.1-alpha.2'), false)
  assert.equal(satisfiesRange('1.2.9', '^1.2.3'), true)
  assert.equal(satisfiesRange('2.0.0', '^1.2.3'), false)
  assert.equal(satisfiesRange('0.2.5', '~0.2.3'), true)
  assert.equal(satisfiesRange('0.3.0', '~0.2.3'), false)
  assert.equal(satisfiesRange('1.2.3', '>=1.0.0'), true)
  assert.equal(satisfiesRange('1.2.3', '>=1.0.0 <2.0.0'), true)
  assert.equal(satisfiesRange('2.0.1', '>=1.0.0 <2.0.0'), false)
  assert.equal(satisfiesRange('1.2.3', '1.2.3'), true)
  assert.equal(satisfiesRange('1.2.4', '1.2.3'), false)
  assert.equal(satisfiesRange('1.2.4', '1.2.3 || 1.2.4'), true)
  assert.equal(satisfiesRange('1.2.4', '*'), true)
  // 空区间 = 未声明约束
  assert.equal(satisfiesRange('1.2.4', ''), true)
  // 不可解析的版本不满足
  assert.equal(satisfiesRange('not-a-version', '^1.0.0'), false)
  assert.equal(satisfiesRange('1.2.3', 'not-a-range'), false)
  // prerelease < 同版本正式版；范围不含 prerelease 时正式版仍然满足
  assert.equal(compareVersions('1.0.0-rc.1', '1.0.0'), -1)
  assert.equal(compareVersions('1.0.0', '1.0.0-rc.1'), 1)
  assert.equal(compareVersions('1.0.0-alpha.2', '1.0.0-alpha.10'), -1)
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0)
  assert.equal(compareVersions('x', '1.0.0'), null)
})

// ---- 预检 --------------------------------------------------------------------

test('预检通过：A/B 级、白名单、integrity、发布够久', () => {
  const result = preflight()
  assert.equal(result.ok, true)
  assert.deepEqual(result.problems.filter((problem) => problem.severity === 'blocking'), [])
  assert.equal(result.tier, 'B')
  assert.deepEqual(result.permissions.network, ['api.tushare.pro'])
  assert.equal(result.permissions.diskBytes, 320_000_000)
})

test('预检：版本不存在 → blocking version-missing', () => {
  const result = preflight({ version: null })
  assert.equal(result.ok, false)
  assert.ok(result.problems.some((problem) => problem.code === 'version-missing' && problem.severity === 'blocking'))
})

test('预检：slug 缺失 → blocking slug-missing', () => {
  const result = preflight({ plugin: { publisherId: 'pub_roost' } })
  assert.equal(result.ok, false)
  assert.ok(result.problems.some((problem) => problem.code === 'slug-missing'))
})

test('预检：engines 不符 → blocking engines；manifest.engines 优先于 version.engines', () => {
  const result = preflight({ version: version({ manifest: { engines: '^9.0.0' }, engines: '^0.2.1-alpha.2' }) })
  assert.equal(result.ok, false)
  const problem = result.problems.find((entry) => entry.code === 'engines')
  assert.ok(problem !== undefined)
  assert.match(problem.detail, /\^9\.0\.0/)
  assert.match(problem.detail, /0\.2\.1-rc\.5/)
})

test('预检：不在白名单 / 空白名单 → blocking allowlist', () => {
  assert.equal(preflight({ allowlist: 'other-plugin' }).ok, false)
  assert.ok(preflight({ allowlist: 'other-plugin' }).problems.some((problem) => problem.code === 'allowlist'))
  assert.ok(preflight({ allowlist: '' }).problems.some((problem) => problem.code === 'allowlist'))
  assert.ok(preflight({ allowlist: undefined }).problems.some((problem) => problem.code === 'allowlist'))
  // 发布者 id 也可以作为白名单条目
  assert.equal(preflight({ allowlist: 'pub_roost' }).ok, true)
})

test('预检：release 太新 → blocking release-age', () => {
  const fresh = preflight({ version: version({ publishedAt: NOW - 60_000 }) })
  assert.equal(fresh.ok, false)
  assert.ok(fresh.problems.some((problem) => problem.code === 'release-age'))
  // 门槛为 0 时不看发布时间
  assert.equal(preflight({ version: version({ publishedAt: NOW }), minReleaseAgeMs: 0 }).ok, true)
  // 发布时间读不出来且设了门槛 → 拒绝
  assert.ok(
    preflight({ version: version({ publishedAt: null }), minReleaseAgeMs: DAY }).problems.some(
      (problem) => problem.code === 'release-age',
    ),
  )
})

test('预检：缺失 integrity → blocking；非 sha512 → warning', () => {
  const missing = preflight({ version: version({ integrity: '' }) })
  assert.equal(missing.ok, false)
  assert.ok(missing.problems.some((problem) => problem.code === 'integrity' && problem.severity === 'blocking'))

  const odd = preflight({ version: version({ integrity: 'md5-abc' }) })
  assert.equal(odd.ok, true)
  assert.ok(odd.problems.some((problem) => problem.code === 'integrity-format' && problem.severity === 'warning'))
})

test('预检：D 级拒绝、C 级只提示面板容器、缺签名只提示', () => {
  const desktop = preflight({ version: version({ permissions: { desktopOnly: true } }) })
  assert.equal(desktop.ok, false)
  assert.equal(desktop.tier, 'D')
  assert.ok(desktop.problems.some((problem) => problem.code === 'tier' && problem.severity === 'blocking'))

  const client = preflight({
    version: version({ permissions: { clientHalf: true, panels: 2, tools: 3 } }),
  })
  assert.equal(client.ok, true)
  assert.equal(client.tier, 'C')
  assert.ok(client.problems.some((problem) => problem.code === 'tier' && problem.severity === 'warning'))
  assert.equal(client.permissions.panels, 2)

  assert.ok(preflight().problems.some((problem) => problem.code === 'signature' && problem.severity === 'warning'))
  const signed = preflight({ version: version({ signature: { provenance: { predicateType: 'x' } } }) })
  assert.equal(signed.problems.some((problem) => problem.code === 'signature'), false)
})

test('预检：permissions 归一化拒绝坏值、保留已知键', () => {
  const caps = normalizePermissions({
    tools: 3,
    panels: -1,
    network: ['a', 42, ''],
    credentials: ['tushare'],
    binaries: ['python3'],
    data_mounts: ['bars'],
    clientHalf: true,
    desktopOnly: 'yes',
  })
  assert.deepEqual(caps, {
    tools: 3,
    network: ['a'],
    credentials: ['tushare'],
    binaries: ['python3'],
    dataMounts: ['bars'],
    clientHalf: true,
  })
  assert.deepEqual(normalizePermissions(null), {})
})

// ---- profile 锁输入 -----------------------------------------------------------

const PLUGINS = [
  { slug: 'market-center', version: '1.2.0', integrity: 'sha512-market' },
  { slug: 'report-engine', version: '0.9.0', integrity: 'sha512-report' },
]

test('buildProfileLock：同输入同 hash（与调用时间无关）；插件顺序不影响结果', () => {
  const a = buildProfileLock({ dshVersion: '0.2.1-rc.5', baseBundles: [], plugins: PLUGINS })
  const b = buildProfileLock({ dshVersion: '0.2.1-rc.5', baseBundles: [], plugins: [...PLUGINS].reverse() })
  assert.equal(a.hash, b.hash)
  assert.deepEqual(a.patchRows, b.patchRows)
  assert.equal(a.packageJson, b.packageJson)
  assert.equal(a.lockfile, b.lockfile)
  assert.match(a.hash, /^[0-9a-f]{64}$/)
})

test('buildProfileLock：package.json 带依赖与 engines.dsh；lockfile 是占位摘要', () => {
  const inputs = buildProfileLock({
    dshVersion: '0.2.1-rc.5',
    baseBundles: ['@deepseek-ai/dsh-base'],
    plugins: PLUGINS,
  })
  const pkg = JSON.parse(inputs.packageJson) as Record<string, any>
  assert.equal(pkg.name, 'roostbot-workspace-profile')
  assert.equal(pkg.engines.dsh, '0.2.1-rc.5')
  assert.deepEqual(pkg.dsh.profile.bundles, ['@deepseek-ai/dsh-base'])
  assert.deepEqual(pkg.dependencies, { 'market-center': '1.2.0', 'report-engine': '0.9.0' })

  assert.match(inputs.lockfile, /lockfileVersion: '9\.0'/)
  assert.match(inputs.lockfile, /ignoreScripts: true/)
  assert.match(inputs.lockfile, /market-center@1\.2\.0/)
  assert.match(inputs.lockfile, /integrity: sha512-market/)
  // 没有任何时间戳：同一组插件永远同一份锁
  assert.equal(inputs.lockfile.includes(String(NOW)), false)

  // 改一个版本锁就变
  const bumped = buildProfileLock({
    dshVersion: '0.2.1-rc.5',
    baseBundles: ['@deepseek-ai/dsh-base'],
    plugins: [{ ...PLUGINS[0]!, version: '1.3.0' }, PLUGINS[1]!],
  })
  assert.notEqual(bumped.hash, inputs.hash)
})

test('buildProfileLock：空插件列表也稳定；坏输入抛 TypeError', () => {
  const first = buildProfileLock({ dshVersion: '0.2.1-rc.5', plugins: [] })
  const second = buildProfileLock({ dshVersion: '0.2.1-rc.5', plugins: [] })
  assert.equal(first.hash, second.hash)
  assert.deepEqual(first.patchRows, [])
  assert.deepEqual(JSON.parse(first.packageJson).dependencies, {})

  assert.throws(() => buildProfileLock({ dshVersion: '', plugins: [] }), TypeError)
  assert.throws(() => buildProfileLock({ dshVersion: '1.0.0', plugins: [{ slug: 'Bad Slug', version: '1.0.0' }] }), TypeError)
  assert.throws(() => buildProfileLock({ dshVersion: '1.0.0', plugins: [{ slug: 'ok', version: '1.0.0\nname: evil' }] }), TypeError)
})

test('patch 行：只允许 insert，id 前缀 roost-plugin-，可被锁文档接收', () => {
  const row = renderPluginPatchRow({ slug: 'market-center', version: '1.2.0' })
  assert.equal(row, '- insert:\n    - id: roost-plugin-market-center\n      name: market-center')
  assert.ok(row.startsWith('- insert:'))
  assert.equal(row.includes('override'), false)
  assert.equal(row.includes('id: roost-plugin-'), true)
  assert.equal(INSTALL_PATCH_ID_PREFIX, 'roost-plugin-')

  const rendered = renderInstallPatch({ slug: 'report-engine', plugins: PLUGINS })
  assert.match(rendered, /roost-plugin-market-center/)
  assert.match(rendered, /roost-plugin-report-engine/)

  // 单插件、不在 plugins 里：补一条占位，仍然只 insert
  const single = renderInstallPatch({ slug: 'fresh-plugin' })
  assert.equal(single, '- insert:\n    - id: roost-plugin-fresh-plugin\n      name: fresh-plugin')

  assert.throws(() => renderInstallPatch({ slug: 'ok', extra: true } as any), TypeError)

  // patch 行可以直接喂给 profile-lock 的锁文档，且 integrity 自洽
  const inputs = buildProfileLock({ dshVersion: '0.2.1-rc.5', plugins: PLUGINS })
  const doc = buildLockDocument({
    source: 'marketplace',
    packageJson: inputs.packageJson,
    patch: inputs.patchRows.join('\n'),
    lockfile: inputs.lockfile,
    generatedAt: NOW,
  })
  assert.equal(verifyProfileLock(doc), true)
  assert.equal(doc.source, 'marketplace')
})

// ---- 状态机 ------------------------------------------------------------------

test('状态机：契约里的每条合法迁移都能走通', () => {
  assert.equal(nextJobState('preflight', 'request-approval'), 'awaiting-approval')
  assert.equal(nextJobState('preflight', 'preflight-ok'), 'awaiting-approval')
  assert.equal(nextJobState('awaiting-approval', 'approve'), 'installing')
  assert.equal(nextJobState('awaiting-approval', 'reject'), 'failed')
  assert.equal(nextJobState('installing', 'sync-ok'), 'installed')
  assert.equal(nextJobState('installing', 'sync-fail'), 'failed')
  assert.equal(nextJobState('installed', 'rollback'), 'rolling-back')
  assert.equal(nextJobState('failed', 'rollback'), 'rolling-back')
  assert.equal(nextJobState('rolling-back', 'rollback-ok'), 'rolled-back')
  assert.equal(nextJobState('rolling-back', 'rollback-fail'), 'failed')
  assert.equal(nextJobState('installed', 'disable'), 'disabled')
  assert.equal(nextJobState('disabled', 'enable'), 'installed')
  assert.equal(nextJobState('installed', 'update'), 'installing')
})

test('状态机：非法迁移返回 null；重复投递是自环', () => {
  assert.equal(nextJobState('preflight', 'sync-ok'), null)
  assert.equal(nextJobState('awaiting-approval', 'sync-ok'), null)
  assert.equal(nextJobState('installed', 'approve'), null)
  assert.equal(nextJobState('rolled-back', 'rollback'), null)
  assert.equal(nextJobState('rolled-back', 'enable'), null)
  assert.equal(nextJobState('failed', 'approve'), null)
  assert.equal(nextJobState('disabled', 'sync-ok'), null)

  // 幂等：重复 sync / rollback-ok / disable / enable 不报错
  assert.equal(nextJobState('installed', 'sync-ok'), 'installed')
  assert.equal(nextJobState('failed', 'sync-fail'), 'failed')
  assert.equal(nextJobState('rolled-back', 'rollback-ok'), 'rolled-back')
  assert.equal(nextJobState('disabled', 'disable'), 'disabled')
  assert.equal(nextJobState('installed', 'enable'), 'installed')

  // 未知状态/事件
  assert.equal(nextJobState('bogus' as any, 'approve'), null)
  assert.equal(nextJobState('installed', 'bogus' as any), null)
  assert.equal(isJobState('installing'), true)
  assert.equal(isJobState('waiting'), false)
  assert.equal(isJobEvent('rollback-ok'), true)
  assert.equal(isJobEvent('rollbacked'), false)
  assert.equal(JOB_STATES.length, 8)
  assert.equal(JOB_EVENTS.length, 13)
})

test('disabledOnFailure：有快照回滚到旧锁，没快照保持当前锁', () => {
  const withSnapshot = disabledOnFailure('current-lock', 'old-lock')
  assert.deepEqual(withSnapshot, { enabled: false, state: 'failed', rollback: true, lock: 'old-lock' })
  const fresh = disabledOnFailure('current-lock', null)
  assert.deepEqual(fresh, { enabled: false, state: 'failed', rollback: false, lock: 'current-lock' })
  assert.deepEqual(disabledOnFailure(null, null), { enabled: false, state: 'failed', rollback: false, lock: null })
})

test('预检对已签名插件给出 sigstore 状态（不额外报警）', () => {
  const signed = preflight({ version: version({ signature: { sigstore: true } }) })
  assert.equal(signed.problems.some((problem) => problem.code === 'signature'), false)
  // sha512Integrity 只是被这个文件用来构造合法 integrity，这里顺手校验配方可用
  assert.match(sha512Integrity('x'), /^sha512-/)
})
