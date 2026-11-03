# @roost/messaging

Bot 之间的消息信封：框、投递模式、回执策略，以及让消息留在预算内的上限。

设计见 [`docs/design/messaging.md`](../../docs/design/messaging.md)。

## 一句话

发消息不是消息总线，而是**往对方上下文注入一条 user 角色的消息 + 一个发送者框**。
状态（谁委托了谁、做到哪一步）属于 assignment，不属于消息。

## 契约

```ts
MessageEnvelope = { id, idem, from, to, role, assignment?, mode?, reply?, audience?,
                    body, attachments?, deadline?, at }

role   = request|reply|report|room|question|resume|stopped|notice   → 决定注入的框
mode   = now(steer) | queue
reply  = resume | poll | none
```

## 三条硬规则

1. **发送者框进正文第一块**，不是元数据——否则模型会把队友指令当用户意图
2. **`assignment` 为空 = 纯消息**，不产生回执义务（`expectsReply`）
3. **单条 ≤ 64KB，超过就写文件给引用**：消息是指针，不是搬运工

## 不在这个包里

- 投递执行（steer/queue）在 home runtime
- assignment 状态机在 `docs/design/agent-collaboration.md`（待写）
- 房间多播的投影在事件层

## 待办

- [ ] 幂等仓储：`idem` → 原 messageId
- [ ] 大小检查与附件降级（超过 `INLINE_HEAD_CHARS` 转附件）
- [ ] 框的本地化（中文界面下的框文案）

## 折叠

两种折叠，作用范围不同：

| 开关 | 管什么 | 作用范围 |
|---|---|---|
| 折叠 Bot 之间的对话 | 房间里 Bot ⇄ Bot 的传话（`handoff`） | **房间默认**，存在房间记录里，跨端一致 |
| 总是展开 Bot 私聊 | A → B 的私聊标签行 | 设备偏好 |

规则：**结论永不折叠**（一条链的最后一句必须可见）；连续折叠行合并成一行计数；折叠只影响渲染，不影响模型上下文。

```ts
shouldCollapseRoomLine(line, { collapseBotToBot: true })
classifyRoomLine(line)   // human | answer | handoff | final
```
