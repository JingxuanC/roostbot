# @roost/context

每一轮的上下文清单（Context Manifest）。

设计见 [`docs/design/loop-and-context.md`](../../docs/design/loop-and-context.md)。

## 为什么需要它

模型是无状态的：这一轮的行为完全由“我们喂了什么”决定。于是**成本、行为、可解释性都在这份清单里**：

- 哪一段在涨（system / skills / tool schemas / memory / conversation / tool results）
- 稳定段命中率（直接对应 prompt cache）
- 哪些段因为预算被丢弃（判断预算是否太紧）
- 这一轮是否发生压缩

## 契约

```ts
ContextManifest = { turnId, workspaceId, botId, model, window, budget,
                    segments[], dropped[], totals, compacted?, at }
```

每条 `segment` 带 `kind`、`source`、`tokens`、`stable`、`fingerprint`。
同一指纹 = 这段这轮没变，可用于解释 cache hit。

## 不在这个包里

- 装配逻辑（在 home runtime 的 prompt builder）
- 计量与存储（`packages/scheduler` 的 run、usage ledger）

## 待办

- [ ] manifest → usage 行的聚合（分段构成写进用量记录）
- [ ] 两次 manifest 的 diff（回答“为什么这轮贵了”）
