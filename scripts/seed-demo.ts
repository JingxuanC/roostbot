// 种一个 workspace + 房间 + 几条消息，用于本地验收网页。
// 用法：node --experimental-strip-types scripts/seed-demo.ts /tmp/roost.db

import { openStore, createWorkspace, createRoom, sendMessage } from '../packages/store/src/index.ts'

const path = process.argv[2]
const store = openStore(path)
const now = Date.now()
const existing = store.db.prepare("SELECT id FROM workspaces LIMIT 1").get()
let workspaceId
if (existing === undefined) {
  const ws = createWorkspace(store, { tenantId: 'acc_live', name: '我的工作区', profileVersion: 'dev', createdAt: now })
  store.db.prepare('INSERT OR IGNORE INTO workspace_members (workspace_id, user_id, role, invited_by, created_at) VALUES (?, ?, ?, NULL, ?)').run(ws.id, 'acc_live', 'owner', now)
  workspaceId = ws.id
} else {
  workspaceId = existing.id
}
const room = createRoom(store, { workspaceId, name: '量化研究组', createdAt: now })
const messages = [
  ['user', 'acc_live', '盘前看一下有什么异动'],
  ['bot', 'selector', '我先拉一遍涨跌幅和成交额异常。'],
  ['bot', 'risk-officer', '等选股师的候选，先看数据完整性。'],
  ['bot', 'selector', '结论：3 只异动，2 只流动性不足。'],
]
for (const [kind, id, text] of messages) {
  sendMessage(store, { roomId: room.id, text, actor: { kind, id }, at: now })
}
console.log(JSON.stringify({ workspaceId, roomId: room.id, messages: messages.length }))
store.close()
