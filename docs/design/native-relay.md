# Native Relay PoC

> 状态：PoC 已实现（2026-11-08）。外部 Agent 在用户自己的电脑上运行，
> Roost 不启动外部 Agent 进程，也不保存它的模型 key。

## 流程

```text
用户已有 Claude/Codex/Grok 会话
  → 创建 room slot + native binding（用户 Bearer）
  → 外部进程轮询 /api/native/assignments
  → 外部 Agent 生成回复
  → POST /api/native/advance（用户 Bearer）
  → control plane 写入房间消息并推进 Round
```

## 创建 binding

```bash
# 1. 创建 slot（owner/admin）
curl -sS -X POST "$ROOST_API/api/rooms/$ROOM/slots" \
  -H "authorization: Bearer $USER_TOKEN" -H 'content-type: application/json' \
  -d "{\"botId\":\"$BOT\",\"runtimeKind\":\"dsh\",\"status\":\"open\"}"

# 2. 绑定为 native
curl -sS -X POST "$ROOST_API/api/rooms/$ROOM/slots/$SLOT/bindings" \
  -H "authorization: Bearer $USER_TOKEN" -H 'content-type: application/json' \
  -d '{"kind":"native","runtimeKind":"dsh","externalId":"claude-desktop-1","state":"active"}'
```

## 轮询

```bash
ROOST_API=http://127.0.0.1:8787 \
ROOST_USER_TOKEN=... ROOST_ROOM_ID=rm_... ROOST_BOT_ID=bot_... \
node apps/runtime/native-relay.mjs --once
```

返回：

```json
{
  "round": { "id": "rnd_...", "state": "running" },
  "assignments": [{ "roundId": "rnd_...", "slotIndex": 0, "botId": "bot_...", "prompt": "..." }]
}
```

## 回传

```bash
curl -sS -X POST "$ROOST_API/api/native/advance" \
  -H "authorization: Bearer $USER_TOKEN" -H 'content-type: application/json' \
  -d '{"roomId":"rm_...","roundId":"rnd_...","botId":"bot_...","slotIndex":0,
       "result":{"kind":"posted","text":"回答内容"}}'
```

## 安全边界

```text
用户 Bearer，不是 runtime token
只能操作自己 workspace 的 room/bot
必须有 active native binding
slotIndex 必须属于该 bot
不保存外部 session 的模型凭据
```

## 限制

```text
PoC 是轮询 + HTTP，不是 WebSocket/hook
外部进程崩溃后 assignments 会留在 running round
没有 native session resume/心跳
```
