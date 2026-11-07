# 本地进程 Runtime

> 状态：开发用（2026-11-07）。用于在没有 Docker / OpenShell 的机器上跑通
> 控制面 → room-agent → DSH 的真实链路。不是安全边界。

## 启动

准备一个本地 DSH 可执行文件（macOS 安装包内也能找到）：

```bash
DSH_BIN="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
```

启动控制面：

```bash
PORT=8799 \
ROOST_DB=/tmp/roost-local.db \
ROOST_RUNTIME_TOKEN=local-dev-token \
ROOST_SANDBOX=local \
ROOST_DSH_BIN="$DSH_BIN" \
ROOST_LOCAL_WORKSPACE_DIR=/tmp/roost-workspaces \
node --experimental-strip-types apps/api/src/main.ts
```

然后正常登录/创建 workspace/Bot；`POST /api/workspaces/:id/start` 会在本机启动：

```text
node apps/runtime/room-agent.mjs
  └─ dsh --profile sdk
```

每个 workspace 一个子进程，workdir 在 `ROOST_LOCAL_WORKSPACE_DIR` 下。

## 与 OpenShell 的差异

| 项 | 本地 | OpenShell |
|---|---|---|
| 隔离 | 无（继承当前用户权限） | 容器/策略隔离 |
| 启动 | 秒级 | 沙箱创建/镜像拉取 |
| 凭据 | 控制面 token；模型 key 走控制面代理 | 同左 |
| 多用户 | 仅开发/单机 | 生产 |
| 停止 | 子进程 SIGTERM | sandbox stop |

## 限制

- `ROOST_DB=memory` 时没有 SQLite 校验 runtime token，只能用全局
  `ROOST_RUNTIME_TOKEN`；不提供房间事件。
- 真实聊天需要工作区模型凭据或平台模型 key；否则 DSH 在模型请求时失败。
- 外部 Runtime（Grok Build/Claude/Codex）需要本机安装对应 CLI，并设置
  `ROOST_GROK_BIN` / `ROOST_CLAUDE_BIN` / `ROOST_CODEX_BIN`。
- 不要把这个模式暴露到公网。
