# @roost/event-schema

所有 Bot 活动的唯一事实源。房间、计量、审计、多端同步都从这份日志派生。

- `event.schema.json` — 旧的扁平 v1 规范（`user.message` / `run.started` 等）
- `src/` — 新信封（`domain` + `domain.action`）的 TypeScript 类型、运行时常量与纯校验，对应 `docs/design/events.md` §3–§4

## 为什么事件优先

1. **多端一致**：客户端从 `seq` 续读，不靠轮询"最新状态"
2. **审计与计费免费**：不需要另建两套记录
3. **可回放**：出问题能按时间线复现
4. **记忆有原料**：causal-memory 从事件里抽"判断"，不存聊天全文

## 用法

```ts
import {
  validateEvent,
  EVENT_DOMAINS,
  EVENT_KINDS_BY_DOMAIN,
  LEGACY_KIND_MAP,
  type EventEnvelope,
} from '@roost/event-schema'

const result = validateEvent(raw)
if (!result.ok) {
  console.error(result.errors) // ['$.kind: unknown kind "chat.nope"', ...]
} else {
  const event: EventEnvelope = result.event // payload 缺省已归一为 {}
}
```

运行时常量：

```ts
EVENT_DOMAINS                    // 11 个 domain
EVENT_KINDS_BY_DOMAIN.assignment // assignment.* 的 6 个 kind
EVENT_KINDS                      // 扁平化后的 41 个 kind
LEGACY_KIND_MAP['user.message']  // 'chat.message'（只用于读旧日志）
```

## 校验 CLI

```bash
# 文件
node --experimental-strip-types packages/event-schema/src/cli.ts event.json

# 标准输入
cat event.json | node --experimental-strip-types packages/event-schema/src/cli.ts

# 或 npm script
pnpm --filter @roost/event-schema validate event.json
```

合法时输出 `ok: event <kind> seq=<n>` 并以 0 退出；非法时逐条输出 `$.field: ...` 错误并以 1 退出。

## 校验规则

- 必填：`id`、`seq`（整数 ≥1）、`at`（可解析的 date-time）、`domain`、`kind`、`v`（必须是 1）
- `kind` 必须在 `EVENT_KINDS_BY_DOMAIN[domain]` 里，即 `domain.action`
- `actor` / `subject` 必须是 `{kind,id}`；`audience` 只能是 `team` / `room:<id>` / `member:<id>`
- `parent` 是 ≥1 的整数；`idem` 非空；`trace` 是对象，`run` / `turn` / `assignment` 若出现必须是非空字符串
- `payload` 必须是对象，缺省归一为 `{}`；未知顶层字段直接报错
- 旧 kind（`event.schema.json`）不通过新信封校验；读旧日志时用 `LEGACY_KIND_MAP` 升级

## 硬规则

- 只追加，不修改
- `seq` 在房间内单调递增；跨房间不保证顺序
- `audience` 决定可见性，读写都要校验
- 密钥形状的字段一律脱敏后再落盘（与 bot-events 同一套规则）
