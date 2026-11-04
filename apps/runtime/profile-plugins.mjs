// 把一个本地 Cordis 插件装进 DSH profile（审批桥的沙箱分发，TODO 5.4.3）。
//
// DSH 的 profile 是 `$DSH_HOME/profiles/<name>/`：
//   package.json          — dsh.profile.bundles 决定 bundle 层
//   cordis.patch.yml      — 用户 patch 层（top-level YAML 数组；insert / override）
//   cordis.yml            — 空根配置（DSH 每次启动都会重写，这里只保证它存在）
//   node_modules/…        — profile 私有包
//
// 本模块只做三件事，全部幂等：
//   1. profile 目录不存在时，按 DSH 的 shipped template 初始化（sdk / web / headless …）；
//   2. 把本地插件包复制到 profile 的 node_modules，并把入口改指到 src/plugin.ts；
//   3. 在 cordis.patch.yml 里维护**一个** insert 块（带 sentinel 注释），
//      重复安装不会叠加，已有无关条目保留。
//
// 不跑 dsh，不读网络，不依赖 YAML 库：配置用 JSON 流式映射写进 YAML
// （JSON 是 YAML 的子集），更新靠行级定位而不是整体重排。

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { dirname, join } from 'node:path'

/** DSH 的 shipped profile 模板（与 `@deepseek-ai/dsh-app-boot` 的 PROFILE_TEMPLATES 对齐）。 */
export const PROFILE_TEMPLATES = Object.freeze({
  acp: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-acp-app'],
  web: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
  headless: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'],
  sdk: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-sdk-app'],
  'sdk-minimal': ['@deepseek-ai/dsh-sdk-minimal'],
})

/** 自定义（非 shipped）profile 的基线：DSH `DEFAULT_PROFILE_BUNDLES` 同值。 */
const DEFAULT_BUNDLES = ['@deepseek-ai/dsh-base']

const PROFILE_NAME_SAFE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const PACKAGE_NAME_SAFE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/
const PATCH_ID_SAFE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** 本模块写入的 sentinel 注释；用它定位「自己那一块」，避免动别人的 patch。 */
const MARKER_PREFIX = '# >>> roost approval bridge'

/**
 * 安装/更新一个 profile 插件。
 *
 * @param {object} options
 * @param {string} options.dshHome   `$DSH_HOME`（沙箱里是 `/workspace/.dsh`）。
 * @param {string} [options.profile] profile 名，默认 `sdk`。
 * @param {string} options.packageDir 本地插件包目录（含 package.json + src/plugin.ts）。
 * @param {string} [options.name]    包名 / patch 里的 `name`，默认 `@roost/approval-bridge`。
 * @param {string} [options.patchId] patch 条目 id，默认 `roost-approval-bridge`。
 * @param {object|string} [options.configJson] 插件 config；对象或 JSON 字符串。
 * @returns {{profileDir: string, patched: boolean, packageDir: string}}
 */
export function installProfilePlugin(options) {
  if (options === null || typeof options !== 'object') {
    throw new TypeError('installProfilePlugin needs an options object')
  }
  const dshHome = readText(options.dshHome, 'dshHome')
  const profile = readText(options.profile ?? 'sdk', 'profile')
  if (!PROFILE_NAME_SAFE.test(profile)) {
    throw new TypeError(`invalid profile name ${JSON.stringify(profile)}`)
  }
  const packageDir = readText(options.packageDir, 'packageDir')
  if (!existsSync(join(packageDir, 'package.json'))) {
    throw new Error(`plugin package not found: ${packageDir} (no package.json)`)
  }
  if (!existsSync(join(packageDir, 'src', 'plugin.ts'))) {
    throw new Error(`plugin package ${packageDir} has no src/plugin.ts entry`)
  }
  const name = readText(options.name ?? '@roost/approval-bridge', 'name')
  if (!PACKAGE_NAME_SAFE.test(name)) {
    throw new TypeError(`invalid package name ${JSON.stringify(name)}`)
  }
  const patchId = readText(options.patchId ?? 'roost-approval-bridge', 'patchId')
  if (!PATCH_ID_SAFE.test(patchId)) {
    throw new TypeError(`invalid patch id ${JSON.stringify(patchId)}`)
  }
  const config = readConfig(options.configJson)

  const profileDir = join(dshHome, 'profiles', profile)
  ensureProfile(profileDir, profile)

  const target = join(profileDir, 'node_modules', ...name.split('/'))
  mkdirSync(dirname(target), { recursive: true })
  rmSync(target, { recursive: true, force: true })
  cpSync(packageDir, target, { recursive: true, dereference: true })
  buildRuntimeEntry(target)

  const patchPath = join(profileDir, 'cordis.patch.yml')
  const before = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : ''
  const after = upsertPatch(before, { patchId, name, config })
  writeFileSync(patchPath, after)

  return { profileDir, patched: after !== before, packageDir: target }
}

// ---- profile 目录 ------------------------------------------------------------

/**
 * 保证 profile 能直接启动：package.json 有 bundles，patch 文件存在，根配置存在。
 * 不存在时按 shipped template 初始化——空 bundles 会让 `dsh --profile sdk`
 * 一个插件都不挂，SDK 端连 initialize 都回不来。
 */
function ensureProfile(profileDir, profile) {
  mkdirSync(profileDir, { recursive: true })
  const manifestPath = join(profileDir, 'package.json')
  if (!existsSync(manifestPath)) {
    const bundles = PROFILE_TEMPLATES[profile] ?? DEFAULT_BUNDLES
    const manifest = {
      name: `dsh-profile-${profile}`,
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: [...bundles] } },
    }
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  }
  // DSH 启动时会重写 cordis.yml（空根配置）；预先放一个，让 profile 在
  // 离线检查/工具里也是完整形状。
  const rootPath = join(profileDir, 'cordis.yml')
  if (!existsSync(rootPath)) writeFileSync(rootPath, '[]\n')
  const patchPath = join(profileDir, 'cordis.patch.yml')
  if (!existsSync(patchPath)) writeFileSync(patchPath, '[]\n')
}

/**
 * 把复制进来的可擦除 TS 变成同一目录下的 `.js`，并把入口指过去。
 *
 * 为什么必须在安装时做：Node 的 type stripping **拒绝 node_modules 下的 .ts**
 * （ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING）。插件的宿主是 `import('@roost/approval-bridge')`，
 * 所以包一进 profile/node_modules，源码 `.ts` 就再也加载不了。这里用
 * `node:module` 的 `stripTypeScriptTypes`（Node ≥22.13，零依赖）生成 JS 兄弟文件，
 * 再把相对 import 的 `.ts` 后缀改成 `.js`。
 */
function buildRuntimeEntry(target) {
  const entry = join(target, 'src', 'plugin.ts')
  if (!existsSync(entry)) throw new Error(`plugin package ${target} has no src/plugin.ts entry`)
  // 只擦 src：测试/工具里的 TS 不参与宿主加载，没必要也不该在安装时被求值。
  stripTsTree(join(target, 'src'))

  const manifestPath = join(target, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.type = 'module'
  manifest.main = './src/plugin.js'
  manifest.exports = { '.': './src/plugin.js' }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
}

/** 递归把 `.ts` 擦成 `.js`；保留原 `.ts` 不删（方便对照/调试，Node 不会加载它）。 */
function stripTsTree(dir) {
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    if (item.name === 'node_modules') continue
    const path = join(dir, item.name)
    if (item.isDirectory()) {
      stripTsTree(path)
      continue
    }
    if (!item.name.endsWith('.ts')) continue
    const stripped = stripTypeScriptTypes(readFileSync(path, 'utf8'), { mode: 'strip' })
    writeFileSync(path.slice(0, -'.ts'.length) + '.js', rewriteRelativeTypeSpecifiers(stripped))
  }
}

/** `from './x.ts'` / `import './x.ts'` / `import('./x.ts')` → `.js`。 */
function rewriteRelativeTypeSpecifiers(code) {
  return code
    .replace(/(\bfrom\s*['"])([^'"]+)\.ts(['"])/g, '$1$2.js$3')
    .replace(/(\bimport\s*['"])([^'"]+)\.ts(['"])/g, '$1$2.js$3')
    .replace(/(\bimport\s*\(\s*['"])([^'"]+)\.ts(['"]\s*\))/g, '$1$2.js$3')
}

// ---- cordis.patch.yml --------------------------------------------------------

/** 生成受管理的 insert 块（含 sentinel；config 用 JSON 流式映射，合法 YAML）。 */
function renderBlock({ patchId, name, config }) {
  const json = JSON.stringify(config)
  return [
    `${MARKER_PREFIX}: ${patchId} (managed by apps/runtime/profile-plugins.mjs; do not edit)`,
    '- insert:',
    `    - id: ${JSON.stringify(patchId)}`,
    `      name: ${JSON.stringify(name)}`,
    `      config: ${json}`,
    `# <<< roost approval bridge: ${patchId}`,
  ].join('\n')
}

/**
 * 把受管理块插进 patch 文件，或就地更新它。
 *
 * 顺序：
 *   1. sentinel 块存在 → 整块替换（幂等 + 配置更新）；
 *   2. 同 id/name 的手写条目存在 → 只改它的 config 行（不碰同块里的兄弟条目）；
 *   3. 文件只有 `[]`/注释 → 用新块替换 `[]`；
 *   4. 其他情况 → 追加到末尾。
 */
export function upsertPatch(source, entry) {
  const text = source ?? ''
  const block = renderBlock(entry)
  const lines = text.split('\n')

  const start = lines.findIndex((line) => line.startsWith(`${MARKER_PREFIX}: ${entry.patchId} `) || line.trim() === `${MARKER_PREFIX}: ${entry.patchId}`)
  if (start >= 0) {
    const end = lines.findIndex((line, index) => index > start && line.startsWith('# <<< roost approval bridge:'))
    if (end < 0) {
      throw new Error(`cordis.patch.yml has a start marker for ${entry.patchId} but no end marker`)
    }
    const next = [...lines.slice(0, start), ...block.split('\n'), ...lines.slice(end + 1)]
    return normalizeText(next.join('\n'))
  }

  const unmanaged = findUnmanagedEntry(lines, entry)
  if (unmanaged !== null) {
    return normalizeText(updateConfigLine(lines, unmanaged, entry.config).join('\n'))
  }

  const meaningful = lines.filter((line) => line.trim() !== '' && !line.trim().startsWith('#'))
  if (meaningful.length === 0) {
    return normalizeText(block)
  }
  if (meaningful.length === 1 && meaningful[0].trim() === '[]') {
    const index = lines.findIndex((line) => line.trim() === '[]')
    const next = [...lines.slice(0, index), ...block.split('\n'), ...lines.slice(index + 1)]
    return normalizeText(stripSeparatingBlanks(next).join('\n'))
  }
  return normalizeText(`${text.replace(/\s+$/, '')}\n${block}`)
}

/**
 * 找一条同 id/name、但不由 sentinel 管理的手写 insert 条目。
 * 只认 `- id:` 行，并要求同一列表项里出现我们的 name。
 */
function findUnmanagedEntry(lines, entry) {
  for (let index = 0; index < lines.length; index += 1) {
    const match = new RegExp(`^(\\s*)-\\s+id:\\s*["']?(${escapeRegExp(entry.patchId)})["']?\\s*(?:#.*)?$`).exec(lines[index])
    if (match === null || match[2] !== entry.patchId) continue
    const keyIndent = match[1].length + 2
    let end = index + 1
    while (end < lines.length) {
      const line = lines[end]
      if (line.trim() === '') {
        end += 1
        continue
      }
      const indent = line.length - line.trimStart().length
      if (indent < keyIndent) break
      end += 1
    }
    const body = lines.slice(index, end).join('\n')
    if (!body.includes(`name: ${JSON.stringify(entry.name)}`) && !body.includes(`name: '${entry.name}'`) && !body.includes(`name: ${entry.name}`)) {
      continue
    }
    let configIndex = -1
    for (let cursor = index + 1; cursor < end; cursor += 1) {
      if (/^\s*config:\s*(.*)$/.test(lines[cursor])) {
        configIndex = cursor
        break
      }
    }
    return { start: index, end, configIndex, keyIndent }
  }
  return null
}

/** 把一个条目里的 config 换成一行 JSON；没有 config 就补在条目末尾。 */
function updateConfigLine(lines, entry, config) {
  const json = JSON.stringify(config)
  if (entry.configIndex >= 0) {
    const indent = lines[entry.configIndex].length - lines[entry.configIndex].trimStart().length
    const rest = lines[entry.configIndex].slice(indent + 'config:'.length).trim()
    if (rest !== '' && rest.startsWith('{')) {
      return [
        ...lines.slice(0, entry.configIndex),
        `${' '.repeat(indent)}config: ${json}`,
        ...lines.slice(entry.configIndex + 1),
      ]
    }
    // 块式 config：删掉它下面更深的行，再写成一行。
    let end = entry.configIndex + 1
    while (end < lines.length) {
      const line = lines[end]
      if (line.trim() === '') {
        end += 1
        continue
      }
      const indent = line.length - line.trimStart().length
      if (indent <= indentOf(lines[entry.configIndex])) break
      end += 1
    }
    return [
      ...lines.slice(0, entry.configIndex),
      `${' '.repeat(indentOf(lines[entry.configIndex]))}config: ${json}`,
      ...lines.slice(end),
    ]
  }
  const insertAt = entry.end
  return [...lines.slice(0, insertAt), `${' '.repeat(entry.keyIndent)}config: ${json}`, ...lines.slice(insertAt)]
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function indentOf(line) {
  return line.length - line.trimStart().length
}

function stripSeparatingBlanks(lines) {
  const next = [...lines]
  while (next.length > 0 && next[0].trim() === '') next.shift()
  while (next.length > 0 && next[next.length - 1].trim() === '') next.pop()
  return next
}

function normalizeText(text) {
  return `${text.replace(/\s+$/, '')}\n`
}

// ---- 参数校验 ----------------------------------------------------------------

function readText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`installProfilePlugin options.${field} is required (non-empty string)`)
  }
  return value.trim()
}

function readConfig(value) {
  if (value === undefined || value === null) return {}
  const parsed = typeof value === 'string' ? JSON.parse(value) : value
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError('installProfilePlugin options.configJson must be a JSON object')
  }
  // 提前序列化一次：BigInt / 循环引用这类不可写进 YAML 的值在这里就报错，
  // 不要等到 DSH 启动读 profile 时才炸。
  JSON.stringify(parsed)
  return parsed
}
