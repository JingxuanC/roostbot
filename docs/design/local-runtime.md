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

## 已验证的本地 E2E

本机用 **DSH 0.2.1-rc.5**（不是 App 自带的 rc.3）+ 本地 fake model upstream 跑通：

```text
浏览器/HTTP → 本地控制面 → local room-agent → 本机 dsh rc.5
  → /v1/messages → 控制面模型代理 → fake upstream
  → chat.message → SSE
```

结果：

```text
REPLY { "seq": 7, "actor": { "kind": "bot" }, "text": "本地收到" }
```

注意：

- App 自带的 DSH 是 rc.3，和 room-agent 的 SDK 事件协议不完全一致，会
  `advanced ... missed`；本地 E2E 要显式指向 rc.5。
- `POST /api/pairing/code` 创建的测试账号没有注册赠送额度；需要先
  `grantTokenCredit`（或通过正常注册流程创建账号），否则模型代理返回
  `free token balance is exhausted`。
- macOS 上 App 的 Node 带 hardened runtime；rc.5 的原生 addon 需要匹配签名的
  Node，本地可用 ad-hoc 签名的 Node 副本跑（仅开发）。
