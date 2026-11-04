# Wave 3 契约（审批桥 / 短 token / 缩略图 / 设计 tokens）

> 与 wave1/2 同源。子 agent 只写自己 scope 的新文件 + 测试；共享接线（server.ts/main.ts/store index）由 Lead 做。

## A. DSH 工具审批桥（5.4.3）
- 目标：DSH 内的工具执行需要人批时，桥到控制面 `approvals`（kind='tool_call'），用户批准后放行；拒绝则失败。
- 先读 DSH 源码：`@deepseek-ai/dsh-user-approval`、`@deepseek-ai/dsh-permission-presets`、`@deepseek-ai/dsh-sdk-jsonrpc-server`；找到 approval request 事件/服务 API。
- 交付：`packages/approvals-bridge/`（新包）：
  - `src/contract.ts`：`ApprovalRequest {id, workspaceId, botId, tool, argsSummary, consequence, requestedAt}`、`BridgeDecision`
  - `src/bridge.ts`：`createApprovalBridge({ request, wait, timeoutMs })` 纯逻辑状态机（pending→approved/rejected/timeout，幂等）
  - `src/dsh.ts`：若能接 DSH 服务则导出适配器（`installApprovalBridge(ctx, bridge)`），否则导出 `describeDshApprovalSurface()` 说明缺口（不虚构 API）
  - README 写清可用/不可用路径
- 测试 ≥10：状态机、超时、幂等、拒绝、多个并发请求。

## B. 每 workspace 短 token（E6）
- 迁移 `0021_runtime_tokens.sql`：`runtime_tokens(id, workspace_id, token_hash, issued_at, expires_at, revoked_at)`
- `packages/store/src/runtime-tokens.ts`：`issueRuntimeToken`（返回明文一次）、`verifyRuntimeToken`（按 hash 查、过期/吊销返回 null）、`revokeRuntimeTokens(workspaceId)`、`revokeRuntimeToken(id)`
- `apps/api/src/runtime-token.ts`：`authorizeRuntimeRequest({ store, globalToken, legacyFallback }, req)` → `{ok:true, workspaceId?}`：
  - 先查 `x-runtime-token`；命中每 workspace token → 返回其 workspaceId；否则等于 `globalToken` → 返回 workspaceId=null（兼容旧部署）
- 测试 ≥12：签发/校验/过期/吊销/单 workspace 隔离、global fallback、header 缺失。
- 不改 server.ts；Lead 接线。

## C. 缩略图与 EXIF 上传接线（6.2.5）
- `apps/api/src/attachments-routes.ts`（只改上传路径）：图片上传先 `prepareImage`（EXIF 剥离），再 `renderThumbnail`（图片；PDF 仅当 `pdftoppm` 可用），缩略图存到内容存储并写 `artifacts`/`attachments` 关联（跟随现有 schema）
- 失败降级：缩略图不可用不影响原图上传；记录 `thumb:null`
- 测试 ≥8：EXIF 剥离、缩略图生成/降级、原图不变、PDF 无工具时不报错。

## D. 设计 tokens 与组件化（E9）
- `packages/tokens/`（新包）：`src/index.ts` 导出 token 树（颜色/字号/间距/圆角/阴影） + `cssVariables()` 生成 CSS 变量文本；测试快照/一致性
- `apps/web/styles.css`：改为引用生成的变量（保留现有类名与视觉），不允许视觉回归（用现有 web 测试 + node:check）
- 抽 2–3 个重复组件到 `apps/web/lib/components.js`（按钮/卡片/字段），至少一处页面改用；测试
- 不改 API/runtime。

## 验收
```
node --experimental-strip-types --test packages/*/test/*.test.ts apps/*/test/*.test.ts
sh scripts/verify.sh
```

## 实现进度（2026-11-04）

| 块 | 状态 | 证据 |
|---|---|---|
| A 审批桥 | 🟡 包完成 | 55 测试；`approval/request` waterfall 可用（16 条源码事实）；还差沙箱 profile 插件分发与端到端 |
| B 短 runtime token | ✅ 接线 | 迁移 0021、store verifier、`runtime-auth.ts` 覆盖 14 个内部入口 + workspace 过滤；沙箱启动签发/吊销 |
| C 缩略图/EXIF | ✅ 接线 | `attachments-thumbnails.ts` + 两个上传端点，14 测试；真实 sips 640x480→320x240、EXIF −78B |
| D tokens/组件 | ✅ | 56 tokens / 47 CSS 变量、3 组件，241 web/tokens 测试 |
| 全量 | ✅ | 1208 tests + verify.sh |
