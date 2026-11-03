# runtime sidecar

补齐 `docs/runtime-contract.md` 中 DSH 尚未提供的部分，不改内核。

```bash
UPSTREAM=http://127.0.0.1:65471 \
PORT=19400 \
BASE_PATH=/w/ws_test \
RUNTIME_TOKEN=rt_test_123 \
DSH_DATA_DIR="$HOME/.dsh/alpha-desk" \
node apps/runtime/sidecar/proxy.mjs
```

| 路由 | 作用 | 认证 |
|---|---|---|
| `GET <base>/healthz` | 探活（上游返回 <500 即算活） | 无（liveness 必须可匿名） |
| `GET <base>/activity` | `busy` / `turns` / `lastActivity` | 无（控制面内部使用） |
| `* <base>/**` | 剥掉 base 转发给 DSH | runtime token 或 DSH cookie；`/api/*` 用 `Authorization: Bearer <RUNTIME_TOKEN>`，页面导航可凭 cookie |

sidecar 只把 runtime token 当作**自己的**入站凭据，转发前会删掉该 header，DSH 看不到它。
`PORT=0` 时由系统分配端口，启动日志会打印真实端口。

实测结果与已知缺口见 `docs/spikes/0001-runtime-contract.md`。

## 已知限制

- `activity` 只统计 ds-bot 的回合（`~/.dsh/alpha-desk/bot/inflight.json`），纯 DSH 会话不计入
- 流式响应（SSE）按字节透传，未做背压处理
- 没有 TLS：云上由控制面/反代终止 TLS
