#!/usr/bin/env node
// 发布预演：读 package.json 的 version 与 CHANGELOG.md 的对应段落，打印要打的 tag 与发布说明。
//
// 默认 dry-run：只读、只打印。**不写文件、不 commit、不 tag、不 push**。
//
// 用法：
//   node scripts/release.mjs            # dry-run
//   node scripts/release.mjs --dry-run  # 同上
//   node scripts/release.mjs --check    # 只校验版本/CHANGELOG 一致（CI 可用；不一致 exit 1）

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PACKAGE_PATH = `${ROOT}package.json`
const CHANGELOG_PATH = `${ROOT}CHANGELOG.md`

const args = process.argv.slice(2)
const known = new Set(['--dry-run', '--check'])
const unknown = args.filter((arg) => !known.has(arg))
if (unknown.length > 0) {
  console.error(`release: 未知参数 ${unknown.join(' ')}（支持 --dry-run / --check）`)
  process.exit(2)
}
const CHECK = args.includes('--check')

const fail = (message) => {
  console.error(`release: ${message}`)
  process.exit(1)
}

const pkg = JSON.parse(readFileSync(PACKAGE_PATH, 'utf8'))
const version = pkg.version
if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
  fail(`package.json 的 version 不是 x.y.z：${String(version)}`)
}
const tag = `v${version}`

let changelog = ''
try {
  changelog = readFileSync(CHANGELOG_PATH, 'utf8')
} catch {
  fail('CHANGELOG.md 不存在')
}

// 找 `## [<version>] - YYYY-MM-DD`，取到下一个二级标题之前。
const lines = changelog.split('\n')
const HEADING = /^##\s+\[(\d+\.\d+\.\d+)\]\s+-\s+(\d{4}-\d{2}-\d{2})\s*$/
let start = -1
let date = ''
for (let i = 0; i < lines.length; i += 1) {
  const match = HEADING.exec(lines[i])
  if (match !== null && match[1] === version) {
    start = i
    date = match[2]
    break
  }
}
if (start === -1) {
  fail(`CHANGELOG.md 里没有 \`## [${version}] - YYYY-MM-DD\` 段落（package.json 是 ${version}）`)
}

let end = lines.length
for (let i = start + 1; i < lines.length; i += 1) {
  if (lines[i].startsWith('## ')) {
    end = i
    break
  }
}
const notes = lines.slice(start + 1, end).join('\n').trim()
if (notes === '') {
  fail(`CHANGELOG.md 的 [${version}] 段落是空的，写点发布说明再发`)
}

const unreleased = /^##\s+\[Unreleased\]\s*$/m.test(changelog)
if (CHECK) {
  console.log(`release: ok roostbot@${version} ← CHANGELOG ${date}（${notes.split('\n').length} 行）`)
  if (!unreleased) console.log('release: 没有 [Unreleased] 段（不影响校验；建议保留一个空段）')
  process.exit(0)
}

console.log('release: dry-run —— 只打印，不 tag、不 commit、不 push')
console.log(`  包:    ${pkg.name}@${version}`)
console.log(`  tag:   ${tag}`)
console.log(`  日期:  ${date}（来自 CHANGELOG.md）`)
console.log(`  说明:  ${notes.split('\n').length} 行`)
console.log('')
console.log('--- release notes ---')
console.log(notes)
console.log('--- release notes 结束 ---')
console.log('')
console.log('之后由人执行（脚本不会做）：')
console.log(`  git tag -a ${tag} -m "${pkg.name} ${version}"`)
console.log(`  git push origin ${tag}`)
console.log('  # 若用 GitHub Releases，把上面的 release notes 粘贴进去')
