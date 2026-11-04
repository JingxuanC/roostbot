#!/usr/bin/env node
// 事件信封校验 CLI：读文件或标准输入，非法时逐条打印错误并以 1 退出。
//
//   node --experimental-strip-types src/cli.ts event.json
//   cat event.json | node --experimental-strip-types src/cli.ts
//   node --experimental-strip-types src/cli.ts - < event.json

import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

import { validateEvent } from './index.ts'

const USAGE = `用法：event-schema [file|-]

从文件或标准输入读取一条事件 JSON 并校验。
  file   事件文件路径
  -      读取标准输入（默认）

退出码：0 = 合法；1 = 非法 / 读取失败 / JSON 解析失败。`

export function main(argv: string[] = process.argv.slice(2)): number {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE)
    return 0
  }

  const source = argv.find((arg) => arg !== '-')
  let text: string
  try {
    text = source === undefined ? readFileSync(0, 'utf8') : readFileSync(source, 'utf8')
  } catch (error) {
    process.stderr.write(`error: cannot read ${source ?? 'stdin'}: ${messageOf(error)}\n`)
    return 1
  }

  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    process.stderr.write(`error: invalid JSON: ${messageOf(error)}\n`)
    return 1
  }

  const result = validateEvent(value)
  if (!result.ok) {
    process.stderr.write(`invalid: ${source ?? 'stdin'}\n`)
    for (const error of result.errors) process.stderr.write(`  - ${error}\n`)
    return 1
  }

  process.stdout.write(`ok: event ${result.event.kind} seq=${result.event.seq}\n`)
  return 0
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isMain(): boolean {
  const entry = process.argv[1]
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href
}

if (isMain()) process.exit(main())
