# @roost/bot-manifest

一个 Bot 就是一份声明：它是谁、能用什么、记得什么。运行时按 manifest 装载，不把配置写死在团队文件里。

- `bot.schema.json` — v1 规范
- `example.bot.json` — 一个真实形状的样例
- `src/` — TypeScript 类型与纯校验，对应 `docs/design/bots.md`

## 设计要点

1. **版本化**：manifest 可打包、可分发、可回滚，像插件一样
2. **能力是白名单**：`tools.allow` / `tools.deny`，没写就是不能用
3. **审批是清单**：危险动作要列出来，运行时才允许发起审批
4. **记忆带作用域**：`team` / `room` / `member`，读取规则见 `docs/architecture.md`
5. **调度带 checks**：先跑纯代码检查，值得才起模型
6. **面板可声明**：`panels[]` 的形状与控制面从插件 manifest 读到的面板一致

## 用法

```ts
import {
  validateManifest,
  APPROVAL_KINDS,
  MODEL_TIERS,
  MEMORY_SCOPES,
  type BotManifest,
} from '@roost/bot-manifest'

const result = validateManifest(raw)
if (!result.ok) {
  console.error(result.errors) // ['$.id: expected /^[a-z][a-z0-9-]{1,40}$/', ...]
} else {
  const manifest: BotManifest = result.manifest
}
```

```ts
// 面板声明的结构
panels: [
  { name: 'portfolio', title: '持仓', slot: 'main', path: '/portfolio' },
]
```

### 校验规则

| 字段 | 规则 |
|---|---|
| `schema` | 必填，必须是 `roostbot.bot/v1` |
| `id` | 必填，`/^[a-z][a-z0-9-]{1,40}$/` |
| `name` | 必填，1–40 字符 |
| `role` | 必填，1–20 字符（JSON schema v1 的约定） |
| `description` | 可选，≤400 字符 |
| `instructions` | 必填，非空字符串 |
| `color` | 可选，`/^[a-z]+$/` |
| `model.tier` | `fast` / `standard` / `deep` |
| `tools.allow` / `tools.deny` | 非空字符串数组 |
| `skills` | 字符串数组，最多 60 项 |
| `panels[]` | `name` 必填（≤128）；`title` ≤200、`slot` ≤64、`path` ≤512 |
| `approvals[]` | `write_outside_workspace` / `network_egress` / `spend` / `install_plugin` / `read_secret` |
| `memory.scopes[]` | `team` / `room` / `member`；`retentionDays` 1–3650 |
| `schedule` | `cron` / `timezone` 非空；`checks` 是非空字符串数组 |

未知字段直接报错，和 `additionalProperties: false` 一致。

## 校验 CLI

```bash
# 文件
node --experimental-strip-types packages/bot-manifest/src/cli.ts bot.json

# 标准输入
cat bot.json | node --experimental-strip-types packages/bot-manifest/src/cli.ts

# 或 npm script
pnpm --filter @roost/bot-manifest validate bot.json
```

合法时输出 `ok: bot <id>` 并以 0 退出；非法时逐条输出 `$.field: ...` 错误并以 1 退出。
