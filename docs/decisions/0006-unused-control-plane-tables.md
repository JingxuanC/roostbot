# 0006 — `runtimes` / `capability_grants` / `invites` 三张空表：保留，不为了勾 TODO 删表

- 状态：已定（0.1.0 保留；每张表写了删除条件）
- 日期：2026-11-04
- 相关：migration `0002_control_plane.sql`、migration `0006_workspace_runtime.sql`、
  ADR 0005、TODO E4

## 背景

`0002_control_plane.sql` 按 `docs/design/workspace.md` §8 与 `docs/design/auth.md` §9
建了三张表。TODO E4 的原文是「用起来 `runtimes` / `capability_grants` / `invites` 表（或删除）」。
先查事实，再决定，不为了勾清单而删表。

## 事实（2026-11-04，`git grep` 全仓）

| 表 | 代码消费者 | 唯一出现位置 | 结论 |
|---|---|---|---|
| `runtimes` | **无**（无 SELECT/INSERT/UPDATE；无 store 方法） | migration 0002；`packages/store/test/migrations.test.ts` 的表名断言；`packages/store/src/workspace-runtime.ts` 的注释；ADR 0005 | 未使用 |
| `capability_grants` | **无** | migration 0002；`docs/design/workspace.md` §8；migrations 测试断言 | 未使用 |
| `invites` | **无** | migration 0002；`docs/design/auth.md` §9；migrations 测试断言；`members-routes.ts` / `members.ts` 的注释（"邀请留到 5.3.1"） | 未使用 |

关键澄清：

- TODO 4.3.2「`runtimes` 表落库」实际落在 **`workspace_runtime`**（migration 0006），
  `packages/store/src/workspace-runtime.ts` 开头明确写了"不挤进 0002 的 runtimes"。
  也就是说，工作区运行时状态已经有表，`runtimes` 不是它。
- `capability_grants` 依赖"本地能力节点"（`workspace.md` 的 local-node），该功能尚未开工，
  所以没有写入方；现在删表不会让代码变简单，只会让设计文档与 schema 对不上。
- `invites` 依赖"按邮箱邀请 + 角色"，而 5.3.3 的成员管理只覆盖已有账号
  （`POST /api/workspaces/:id/invites` 未实现）。表结构本身是 `auth.md` §9 的事实源。

## 决定

**0.1.0 不删这三张表，也不为了"用起来"而写假消费者。** 理由：

1. **迁移是追加式的**：`migrations/` 按文件名顺序执行且已进入发布物；删表必须新增
   `00xx_drop_reserved_control_plane.sql`，同时改 `packages/store/test/migrations.test.ts`
   的期望表名、`packages/store/README.md` 与设计文档。为一个零成本的空表做这条链路，
   收益为负。
2. **三张空表的运行成本≈0**：SQLite 里没有行就没有页；索引也是空的。真正的成本是
   "读者以为它在用"——用本 ADR 和代码注释解决，而不是 drop。
3. **它们各自有明确的未来消费者**（见下），删了再建要再写一次迁移。

### 每张表的保留理由与删除条件

| 表 | 保留理由 | 删除条件（满足即删，新增 drop 迁移） |
|---|---|---|
| `runtimes` | ADR 0005 的 per-workspace runtime token provider 计划用它存 `token_hash` / `started_at` / `last_seen_at`；`last_seen_at` 兼作心跳 | 0.2.0 前 provider 未落地，**或** provider 最终选择 `workspace_runtime` 扩列（而不是 `runtimes`），则删除 |
| `capability_grants` | 本地能力节点（local-node）的授权与审计载体；`workspace.md` §8 已定义形状 | 本地能力节点在 0.3.0 前未开工，或改用其他授权机制（如 DSH profile 内的 grant），则删除 |
| `invites` | 邮箱邀请 + 角色是账号体系的自然下一步；`auth.md` §9 的表结构与 API 已设计 | 0.2.0 前仍未实现邀请 API，且决定只支持"已有账号由 owner 直接加成员"，则删除 |

删除时必须是**一次提交**：drop 迁移 + `migrations.test.ts` 期望表名 + `packages/store/README.md`
+ 相关设计文档 + 本 ADR 的状态改为"已删除"。

## 不做什么

- 不为了让 `runtimes` "有数据"而在 `workspace_runtime` 旁边再写一份（双写必然漂移）。
- 不把 `capability_grants` 接到现有审批表上凑数：审批（`approvals`）是"人批准一次动作"，
  grant 是"节点长期能力范围"，语义不同，合并会混淆审计。
- 不在 0.1.0 写"预留表"的迁移测试之外的使用示例。

## 后果

- TODO E4 的准确状态是「**已核查：三表无消费者；保留，删除条件见 ADR 0006**」，
  不是「已完成使用」。清单可以勾，但要在变更日志里写清是"核查 + 决策"而不是"接入了功能"。
- 如果 0.2.0 的 token provider 用了 `runtimes`，E4 的 `runtimes` 一项自动转正；
  另外两张表继续按上表复核。
