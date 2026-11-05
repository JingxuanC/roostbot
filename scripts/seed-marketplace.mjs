#!/usr/bin/env node
// 为已有部署写入内置插件市场目录（不是 migration：空库仍应返回空市场）。
//
//   ROOST_DB=/var/lib/roost/roost.db node scripts/seed-marketplace.mjs
//
// 可重复执行；INSERT OR IGNORE 不覆盖已有同名插件。

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openStore } from '../packages/store/src/index.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dbPath = process.env['ROOST_DB'] ?? join(root, 'data', 'roost.db')
const sql = readFileSync(join(root, 'deploy', 'seed-marketplace.sql'), 'utf8')
const store = openStore(dbPath)
try {
  store.db.exec(sql)
  const market = store.db.prepare('SELECT COUNT(*) AS n FROM plugin_market').get()
  const versions = store.db.prepare('SELECT COUNT(*) AS n FROM plugin_versions').get()
  const publishers = store.db.prepare('SELECT COUNT(*) AS n FROM plugin_publishers').get()
  console.log(`marketplace seeded: publishers=${publishers.n} plugins=${market.n} versions=${versions.n}`)
} finally {
  store.close()
}
