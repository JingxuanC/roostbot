# Routine：隔离跑模型，结果回到原房间

定时任务的钟在控制面，默认时区 `Asia/Shanghai`。模型不在控制面里直接打到供应商，而是由沙箱里的 room-agent 开一个**新的** DSH 会话来跑。这个会话和房间聊天不是同一个：prompt 只有 routine 自己的那句话，没有房间历史。工具和沙箱权限跟这个 Bot 平时说话用的是同一套，因为走的是同一个 `dsh --profile sdk`。供应商的密钥留在控制面（workspace 的 BYO key，或平台免费额度），沙箱只拿 runtime token。

## 配置

1. 控制面配好模型。有自己的 key 时：

```http
PUT /api/workspaces/:id/model
{"provider":"deepseek","baseUrl":"https://api.deepseek.com","model":"deepseek-chat","apiKey":"sk-…"}
```

没配 BYO、也没配平台 key 时，这一轮会在房间里留下一条「失败：还没有配置模型密钥」，并且不会重试。

2. 建 routine。不写 `timezone` 就是 `Asia/Shanghai`。

```http
POST /api/workspaces/:id/routines
{"botId":"…","roomId":"…","name":"盘前","cron":"0 8 * * 1-5","prompt":"只报告异动，没有就别说"}
```

3. 沙箱里启动 room-agent，环境至少要有：

- `ROOST_API` 控制面地址
- `ROOST_RUNTIME_TOKEN` 这个 workspace 的 runtime token
- `ROOST_BOT_ID` 要执行的 Bot
- `ROOST_WORKSPACE_ID`
- `ROOST_DSH_BIN` 指向 `dsh`（测试里用 `apps/runtime/test/fake-dsh.mjs`，不会打到真实模型）

到点后控制面写 `schedule.routine.fired`。room-agent 从 `GET /api/internal/events` 看到它，用 session id `routine-<runId>-<attempt>` 跑模型，再 `POST /api/internal/routine-runs/:id/result`。

## 写回房间

成功时是一条普通的 bot `chat.message`，幂等键 `routine-run:<runId>`。载荷里的 `routine` 有 `routineId`、`runId`、`scheduledFor`（UTC 时刻）和 `timezone`（默认 `Asia/Shanghai`）。事件流会把它推给已经打开的房间。

空文本是静默，房间里不出现气泡。

失败（缺密钥、模型错误、超时）在房间里写一条看得见的「失败：…」，`routine.error` 为 true。模型错误和超时最多试 3 次；缺密钥不重试。重试不会再发第二条，因为交卷用的是同一个 run id。

本地试一次：起控制面，配好模型（或把 `ROOST_DSH_BIN` 指到 fake-dsh），建好 routine，调用 `POST /api/routines/:id/run`。有 runner 时控制面当场跑完；没配 runner 时 run 停在 `queued`，等 room-agent 交卷。
