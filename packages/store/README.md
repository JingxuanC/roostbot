# @roost/store

workspace 卷的存储层：一份只追加的事件日志 + workspace/auth 核心表。**零依赖**，只用 `node:sqlite`。

事实源：`docs/design/events.md`（信封、日志）、`docs/design/workspace.md`（workspaces）、
`docs/design/auth.md`（devices / sessions / pairing_codes）。

## 用法

```ts
import { openStore, appendEvent, readEvents, latestSeq } from '@roost/store'

const store = openStore('/vol/workspace.db') // 建库 + 跑 migrations/*.sql
try {
  const event = appendEvent(store, {
    domain: 'chat',
    kind: 'chat.message',
    idem: 'msg_01H',
    actor: { kind: 'bot', id: 'risk' },
    audience: 'room:r_quant',
    payload: { role: 'bot', text: '…' },
  })
  console.log(event.seq, latestSeq(store))
  console.log(readEvents(store, { afterSeq: 0, domain: 'chat' }))
} finally {
  store.close()
}
```

| 导出 | 说明 |
|---|---|
| `openStore(path, options?)` | 打开/建库，按文件名升序执行 `migrations/*.sql`（已执行的记在 `schema_migrations`）；文件库开 WAL |
| `appendEvent(store, event)` | 填 `seq`、`at`、`v`；`idem` 重复则返回已有事件，不写第二条 |
| `readEvents(store, { afterSeq?, domain?, audience?, limit? })` | 按 `seq` 升序 |
| `latestSeq(store)` | 空库为 0 |
| `createPairingCode` / `claimPairingCode` | 6 位数字、单次、过期拒绝、尝试上限 5（可由 `maxAttempts` 覆盖） |
| `createWorkspace` / `listWorkspaces` | `profileVersion` 必填（`profile_ver NOT NULL`） |

错误一律抛 `StoreError`，按 `err.code` 分支（`STORE_ERROR_CODES`）；没有“失败但返回成功”的路径。

## 表

`events`、`workspaces`、`workspace_members`、`accounts`、`devices`、`sessions`、`pairing_codes`
（`0001_core.sql`）；`runtimes`、`capability_grants`、`invites`（`0002_control_plane.sql`）。

## 设计文档与实现不一致（实现按文档，差异记录在此）

1. **`client_sessions` 与 `sessions` 重复**：`workspace.md` §8 定义 `client_sessions`，
   `auth.md` §9 定义 `sessions`，字段几乎一样。只建 `sessions`（auth.md 是认证的事实源），
   `client_sessions` 视为被取代。
2. **配对码的“5 次/分钟”无法用 §9 的表实现**：速率限制需要时间窗起点，表里只有 `attempts` 计数。
   实现为**累计尝试上限 5**（每次 claim 都 +1，成功也算），不是每分钟重置的限流。
3. **`migrating` 状态**：`workspace.md` §7 的生命周期图没有它，但 §10 的失败模式和
   `packages/workspace` 的类型有。`workspaces.state` 的 CHECK 包含 `migrating`。
4. **`seq` 是全局还是每流**（`events.md` §11 问题 1）：实现为**每个库一条全局 seq**
   （一个 workspace 卷 = 一个库 = 一份日志），未做每流合并。
5. **事件 id 形状**：`events.md` §3 示例 `ev_01H...` 是 ULID。实现生成 ULID 形状的
   `ev_` + 26 位 Crockford base32（时间前缀 + 随机），但同一毫秒内不保证单调；排序只用 `seq`。
6. **`node --check` 的边界**：`packages/store/package.json` 的 `check` 按要求用
   `node --check src/index.ts`。它只在包内有 `"type": "module"` 时才能解析 `.ts`，
   且只解析入口文件、不跟进 import——真正的门是 `node --experimental-strip-types --test`。
7. **大 payload 不设上限**：`events.md` §5 要求 >8KB 走附件，但存储层没有强制（外置是 runtime 的职责），
   `payload_json` 只做 JSON 序列化。
8. **`pairing_codes.created_at` 是加出来的列**：`auth.md` §9 的 DDL 没有它，但
   `apps/api` 的 `PairingRecord.createdAt` 需要（`events.md` §9 允许只加字段）。值就是签发时的 `now`。
9. **配对码的锁没有时间窗**：`claimPairingCode` 没有 `lockMs` 参数。`auth.md` §3 的「锁 10 分钟」
   在 §9 里没有对应列，而码本身 5 分钟就过期；锁保持到同名码被重新签发为止。
   如果以后要按分钟级限流，需要新增列 + 新迁移，不能靠现有 `attempts` 推断。

## 与 `apps/api` 的 `StorePort` 的差异

`apps/api/src/port.ts` 定义了控制面要的端口，并注明「把 packages/store 的实现包一层适配器接进来」。
本包不是它的直接实现，接适配器时要知道：

| 端口 | 本包 | 适配方式 |
|---|---|---|
| `async` 方法 + 结果对象（`{ ok:false, reason }`） | 同步 + 抛 `StoreError` | 适配器 `try/catch` 把 `code` 映射成 `reason`（`PAIRING_CODE_EXPIRED`→`expired` 等） |
| `claimPairingCode` 返回 `pairing` 记录 | 返回 `PairingClaim`（含 `createdAt`/`attempts`） | 字段够用 |
| `maxAttempts` / `lockMs` | 支持 `maxAttempts`；忽略 `lockMs` | 端口注释本身允许「实现可忽略 lockMs」 |
| `createSession` / `findSessionByToken` | 只有 `devices` / `sessions` 表，没有 helper | 暂无，需要时补（表已就绪） |
| `createWorkspace` 自动加 owner 成员并返回 `role` | 只写 `workspaces`，不写成员 | 适配器补 `workspace_members`，或本包后续加 helper |
| `homeMode` 默认 `local`（v0 控制面） | 默认 `cloud`（`workspace.md` §3 的默认形态） | 适配器显式传 `homeMode` |

## 测试

```sh
node --experimental-strip-types --test packages/store/test/*.test.ts
```

每个用例在临时目录建真库，结束后关库并删目录。

## 会话（auth.md §9）

```ts
createSession(store, { id, accountId, deviceId, tokenHash, createdAt, expiresAt })
findSessionByTokenHash(store, hash)   // 只按 hash 查；不存明文
findSessionById(store, id)
touchSession(store, id, { lastSeenAt, expiresAt? })   // 有效期只能往后推
revokeSession(store, id, at)
```

`sessions` 表本身没有 `account_id`：账号经 `devices` 关联，创建时会校验设备属于该账号。
