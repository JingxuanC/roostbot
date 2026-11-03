# apps/runtime — 云上运行时镜像与控制

把 DSH 装进容器，并按 `docs/runtime-contract.md` 补齐七条契约。

## 组成

- `Dockerfile`：node 24 + DSH + 基线插件 + 沙箱工具（bubblewrap）
- `entrypoint.sh`：校验 runtime token → 生成/校验 profile → 启动 DSH → 处理 SIGTERM
- `sidecar/`：
  - `auth`：校验 runtime token
  - `activity`：`/healthz` `/activity`
  - `usage`：回合计量上报
  - `model-proxy`：BYO token 的唯一持有者（见 `docs/decisions/0003-tokens.md`）

## 待办

- [ ] 镜像里固定 DSH 版本，profile 预置
- [ ] `--base-path` 反代自测
- [ ] 优雅停机测试（长回合 + SIGTERM）
- [ ] 沙箱跑通（回合内 bash/MCP）
