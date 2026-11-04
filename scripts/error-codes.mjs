#!/usr/bin/env node
// 错误码清单：扫描 apps/api/src/** 的 `sendError(res, <status>, '<code>' ...)` 调用，
// 生成 docs/error-codes.md；`--check` 只校验不写盘（CI 用）。
//
// 只统计**字面量**调用。转发型调用（`sendError(res, parsed.status, parsed.code, ...)`）
// 复用上游/鉴权层的 code，不在本表里重复列出；同一条 code 因上下文不同返回多个状态时，
// 状态列会全部列出（前端应按 code 分支，不要只按 404/400 猜）。
//
// 用法：
//   node scripts/error-codes.mjs           # 重新生成 docs/error-codes.md
//   node scripts/error-codes.mjs --check   # 校验文档是否与代码一致（不一致 exit 1）

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const API_DIR = join(ROOT, 'apps', 'api', 'src')
const DOC_PATH = join(ROOT, 'docs', 'error-codes.md')
const CHECK = process.argv.includes('--check')

/** `sendError(res, 400, 'code', ...)`，允许换行与空白。 */
const CALL_RE = /sendError\(\s*res\s*,\s*(\d{3})\s*,\s*'([^']+)'/g
/** 稳定 code 的形状：小写、点分命名空间，例如 `memory.not_found`。 */
const CODE_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/

/** apps/api/src 下的全部 .ts（递归；按相对路径排序保证输出稳定）。 */
function listSources(dir = API_DIR) {
  const out = []
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...listSources(path))
    else if (name.endsWith('.ts')) out.push(path)
  }
  return out
}

/** 从 server.ts 的 ERROR_TEXT 里取中文文案；改了实现就退化成空表，不影响生成。 */
function readErrorText() {
  const text = {}
  let source = ''
  try {
    source = readFileSync(join(API_DIR, 'server.ts'), 'utf8')
  } catch {
    return text
  }
  const block = /const ERROR_TEXT: Record<string, string> = \{([\s\S]*?)\n\}/.exec(source)
  if (block === null) return text
  for (const line of block[1].split('\n')) {
    const match = /^\s*'?([A-Za-z][A-Za-z0-9_.]*)'?\s*:\s*'([^']*)'/.exec(line)
    if (match !== null) text[match[1]] = match[2]
  }
  return text
}

function statusesLabel(statuses) {
  return [...statuses].sort((a, b) => a - b).join(' / ')
}

function cell(value) {
  return value.replaceAll('|', '\\|')
}

const errorText = readErrorText()
const modules = []
const index = new Map()
const problems = []
let callCount = 0

for (const file of listSources()) {
  const rel = relative(join(ROOT, 'apps', 'api', 'src'), file).split('\\').join('/')
  const source = readFileSync(file, 'utf8')
  const codes = new Map()
  let calls = 0
  for (const match of source.matchAll(CALL_RE)) {
    const status = Number.parseInt(match[1], 10)
    const code = match[2]
    calls += 1
    callCount += 1
    if (!Number.isInteger(status) || status < 400 || status > 599) {
      problems.push(`${rel}: HTTP 状态 ${match[1]} 不在 400–599`)
    }
    if (!CODE_RE.test(code)) {
      problems.push(`${rel}: code '${code}' 不符合稳定命名（小写点分，如 memory.not_found）`)
    }
    const entry = codes.get(code) ?? { statuses: new Set(), count: 0 }
    entry.statuses.add(status)
    entry.count += 1
    codes.set(code, entry)
    const seen = index.get(code) ?? { statuses: new Set(), modules: new Set() }
    seen.statuses.add(status)
    seen.modules.add(rel)
    index.set(code, seen)
  }
  if (calls > 0) modules.push({ rel, calls, codes })
}

/** 生成文档（纯函数：同一份代码永远得到同一份文本）。 */
function render() {
  const lines = []
  lines.push('# 错误码')
  lines.push('')
  lines.push('> 本文件由 `node scripts/error-codes.mjs` 生成，**不要手改**。')
  lines.push('> 改完 `apps/api/src/**` 的 `sendError` 调用后重跑；CI 用')
  lines.push('> `node scripts/error-codes.mjs --check` 校验是否过期。')
  lines.push('')
  lines.push('## 约定')
  lines.push('')
  lines.push('- `error.code` 是**稳定契约**：英文、小写点分；前端按 code 分支，不要匹配中文文案。')
  lines.push('- **只增不改不删**。重命名等于破坏兼容；废弃的 code 先保留，等下一个大版本再删。')
  lines.push('- `error.message` 面向人：`sendError` 在 `ERROR_TEXT` 有词条时拼成')
  lines.push('  `中文文案（调用点细节）`，没有词条时原样返回调用点给的 message。')
  lines.push('- HTTP 状态表达类别。同一个 code 在极少数上下文里可能返回不同状态，下表列出全部。')
  lines.push('- 只统计字面量调用；转发型调用（`parsed.code` / `auth.code` / `body.code`）复用上游')
  lines.push('  或鉴权层的 code，不重复列出。`sendError` 定义本身不计入。')
  lines.push('')
  lines.push('## 总览')
  lines.push('')
  lines.push(`- 调用点：**${callCount}** 个`)
  lines.push(`- 唯一 code：**${index.size}** 个`)
  lines.push(`- 覆盖模块：**${modules.length}** 个文件`)
  const withText = [...index.keys()].filter((code) => errorText[code] !== undefined).length
  lines.push(`- 有中文文案（\`ERROR_TEXT\`）：**${withText}** 个；其余回退调用点 message`)
  lines.push('')
  lines.push('## 按模块')
  for (const mod of modules) {
    lines.push('')
    lines.push(`### \`${mod.rel}\`（${mod.calls} 个调用点）`)
    lines.push('')
    lines.push('| code | HTTP | 中文文案 | 次数 |')
    lines.push('| --- | --- | --- | ---: |')
    for (const code of [...mod.codes.keys()].sort()) {
      const entry = mod.codes.get(code)
      lines.push(
        `| \`${code}\` | ${statusesLabel(entry.statuses)} | ${cell(errorText[code] ?? '—')} | ${entry.count} |`
      )
    }
  }
  lines.push('')
  lines.push('## code 索引')
  lines.push('')
  lines.push('| code | HTTP 状态 | 出现模块 |')
  lines.push('| --- | --- | --- |')
  for (const code of [...index.keys()].sort()) {
    const entry = index.get(code)
    const where = [...entry.modules].sort().map((rel) => `\`${rel}\``).join('<br>')
    lines.push(`| \`${code}\` | ${statusesLabel(entry.statuses)} | ${where} |`)
  }
  lines.push('')
  return lines.join('\n')
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`error-codes: ${problem}`)
  console.error(`error-codes: ${problems.length} 个问题，未生成文档`)
  process.exit(1)
}

const document = render()

if (CHECK) {
  let current = ''
  try {
    current = readFileSync(DOC_PATH, 'utf8')
  } catch {
    console.error('error-codes: docs/error-codes.md 不存在；运行 node scripts/error-codes.mjs 生成')
    process.exit(1)
  }
  if (current !== document) {
    console.error('error-codes: docs/error-codes.md 已过期；运行 node scripts/error-codes.mjs 重新生成')
    process.exit(1)
  }
  console.log(`error-codes: ok（${callCount} 调用点 / ${index.size} code）`)
  process.exit(0)
}

writeFileSync(DOC_PATH, document)
console.log(`error-codes: 已写入 docs/error-codes.md（${callCount} 调用点 / ${index.size} code）`)
