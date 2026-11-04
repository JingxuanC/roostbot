#!/usr/bin/env node
// 统计 TODO.md 的完成度：总项、已完成、按里程碑分组。
import { readFileSync } from 'node:fs'

const path = new URL('../TODO.md', import.meta.url)
const lines = readFileSync(path, 'utf8').split('\n')
let section = '未分组'
const groups = new Map()
let total = 0
let done = 0
for (const line of lines) {
  if (line.startsWith('## ')) section = line.slice(3).trim()
  const match = /^- \[( |x|~|!)\] /.exec(line)
  if (match === null) continue
  total += 1
  const isDone = match[1] === 'x'
  if (isDone) done += 1
  const entry = groups.get(section) ?? { total: 0, done: 0 }
  entry.total += 1
  if (isDone) entry.done += 1
  groups.set(section, entry)
}
console.log(`TODO 完成度：${done}/${total}（${total === 0 ? 0 : Math.round((done / total) * 100)}%）`)
for (const [name, entry] of groups) {
  if (entry.total === 0) continue
  console.log(`  ${name.padEnd(28)} ${String(entry.done).padStart(3)}/${String(entry.total).padEnd(3)}`)
}
