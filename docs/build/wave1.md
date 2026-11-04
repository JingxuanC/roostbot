# Wave 1 契约（auth / 插件安装 / 面板 / 前端）

> 与 `docs/build/m4-contract.md` 同源。**子 agent 只写自己 scope 的新文件 + 测试**；
> `server.ts` / `port.ts` / `store/index.ts` 的接线由 Lead 做。测试必须全绿。

## A. 账号登录（5.3.1 / 5.3.2 / 5.3.6）

迁移 `0019_auth.sql`：

```sql
ALTER TABLE accounts ADD COLUMN email_verified_at INTEGER;
ALTER TABLE accounts ADD COLUMN password_updated_at INTEGER;
CREATE TABLE auth_tokens (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL, kind TEXT NOT NULL,
  token_hash TEXT NOT NULL, payload_json TEXT,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER
);
CREATE UNIQUE INDEX idx_auth_tokens_hash ON auth_tokens(token_hash);
```

`packages/store/src/accounts-auth.ts`：
`hashPassword(password)` / `verifyPassword(password, stored)`（**scrypt**：零依赖下没有 Argon2id，README 注明偏差；
格式 `scrypt$N$r$p$saltB64$hashB64`）、`createAccountWithPassword`、`findAccountByEmail`、
`findAccountById`、`markEmailVerified`、`setPassword`、`upsertOidcAccount`、
`createAuthToken({accountId,kind,ttlMs,payload})`、`consumeAuthToken({token,kind,now})`（单次）。

API（`apps/api/src/auth-login-routes.ts`，导出 handler）：

```
POST /api/auth/register            {email,password} → 201 {accountId}；同时发验证 token（mailer 注入，默认写日志）
POST /api/auth/verify-email        {token} → 200 {}（单次）
POST /api/auth/verify-email/resend {email} → 202 {}
POST /api/auth/login               {email,password} → 200 {accountId, csrfToken} + Set-Cookie
POST /api/auth/logout              → 204（清 cookie + revoke 当前会话）
GET  /api/auth/me                  → 200 {accountId,email}
POST /api/auth/password/reset-request {email} → 202 {}（账号不存在也 202）
POST /api/auth/password/reset      {token,password} → 200 {}
POST /api/auth/oidc/start          {provider} → 200 {authorizeUrl}
GET  /api/auth/oidc/callback       ?code&state → 302 回 / + Set-Cookie
```

- Cookie：`roost_session=<token>; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`（Secure 在 `ROOST_SECURE_COOKIES=1` 时加）
- CSRF：`roost_csrf`（非 HttpOnly，同源可读）+ 写请求头 `x-csrf-token`；**Bearer 认证跳过 CSRF**（兼容现有客户端）
- OIDC：env `ROOST_OIDC_<PROVIDER>_CLIENT_ID/_SECRET/_AUTHORIZE_URL/_TOKEN_URL/_USERINFO_URL`；state 存 auth_tokens(kind='oidc_state')；PKCE S256；不引入依赖，用 `fetch`/`crypto`
- 登录失败统一 401 `auth.invalid_credentials`；限流由现有 rate-limit 层处理

## B. 插件安装流水线（5.1.3 / 5.1.5 / 5.1.7 / 5.1.8 / 5.1.9 / 5.1.10）

迁移 `0020_marketplace_jobs.sql`：
```sql
ALTER TABLE plugin_installs ADD COLUMN tools_json TEXT;      -- 5.1.7 工具来源
CREATE TABLE plugin_install_jobs (
  id TEXT PRIMARY KEY, install_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
  slug TEXT NOT NULL, version TEXT NOT NULL, state TEXT NOT NULL,
  lock_json TEXT, snapshot_json TEXT, permissions_json TEXT,
  error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
```
state：`preflight | awaiting-approval | installing | installed | failed | rolling-back | rolled-back | disabled`

`packages/plugins/src/install.ts`（纯函数）：
- `buildProfileLock({dshVersion, baseBundles, plugins})` → `{packageJson, patchRows, lockfile, hash}`（lockfile 为 `pnpm-lock.yaml` 的占位摘要；不执行 pnpm）
- `renderInstallPatch({slug, plugins})` → 我们的 `cordis.patch.yml` 追加行（只允许 `insert`，id 前缀 `roost-plugin-`）
- `preflightInstall({plugin, version, dshVersion, allowlist, minReleaseAgeMs, now})` → `{ok, problems:[], permissions, tier}`
- `disabledOnFailure(lock, snapshot)` 语义常量 + `nextJobState(state, event)` 状态机

`packages/plugins/src/trust.ts`：
- `verifyIntegrity(expected, actual)`（sha512）
- `isAllowlisted({slug, publisherId, allowlist})`（`ROOST_PLUGIN_ALLOWLIST`，空=全部拒绝）
- `checkReleaseAge(publishedAt, minAgeMs, now)`
- `signatureState(versionMeta)` → `sigstore | npm-provenance | none`（none 时预检 warning，白名单内仍可装）

API（`apps/api/src/marketplace-install-routes.ts`，导出 handler）：
```
POST /api/marketplace/plugins/:slug/install {version}  → 202 {job, approval?} | 409 plugin.preflight
GET  /api/plugin-installs                              → {installs}
GET  /api/plugin-installs/:id                          → {install, job?}
POST /api/plugin-installs/:id/update {version}         → 202 {job}
POST /api/plugin-installs/:id/disable | /enable        → 200 {install}
POST /api/plugin-installs/:id/uninstall                → 202 {job}
POST /api/plugin-installs/:id/rollback                 → 202 {job}
POST /api/internal/plugin-installs/:id/synced          → runtime token；{ok,tools?,panels?,error?} → 状态 installed/failed
```
- 安装命令固定 `pnpm install --frozen-lockfile --ignore-scripts`（5.1.9）
- 安装前快照 = 旧 lock JSON + 旧 install 行；失败/回滚把旧 lock 写回 job.snapshot_json（5.1.10）

## C. 面板运行时（5.2.1 / 5.2.4 / 5.2.5）

- `apps/runtime/room-agent.mjs`：`ROOST_DSH_WEB=1`（沙箱默认开）时启动子进程 `dsh web --port 4099 --no-open`，轮询 `http://127.0.0.1:4099/` 直到 200，日志 `dsh web ready`；退出时 kill；失败只记日志、不拖垮 sdk 会话
- `packages/plugins/src/surface.ts` 增：`panelsFromManifest(manifest)`、`panelSmoke({webPort, fetchImpl})`（GET `/` 200 且 body 含 `<!doctype html`）
- `apps/api/src/panel-forward.ts`（新）：每个 workspace 一个本地转发端口映射
  `ensurePanelForward(workspaceId)` → 用 `openshell forward start <port> <sandbox> -d`（注入 runner 便于测试），
  返回 `{port, url}`；`stopPanelForward(workspaceId)`；`resolvePanelPort(workspaceId)`
- `apps/api/src/dsh-proxy-routes.ts`：把固定 `dshWebPort` 改成 `resolvePanelPort(workspaceId) ?? options.dshWebPort`；找不到 → 503 `dsh.not_running`
- 5.2.5：`panel-wake` = workspace runtime `ensure` + `ensurePanelForward`；面板随 workspace stop 一起停（runtime manager stop 时 stopPanelForward）

## D. 前端（对应 A/B/C）

- 登录/注册页：`#/login`、`#/register`、`#/verify-email`、`#/reset`；cookie 模式（`credentials:'include'`）+ `x-csrf-token`；保留 Bearer 回退
- OIDC 按钮（Google/GitHub，来自 `GET /api/auth/providers` 或 start 404 时隐藏）
- 市场安装：详情页"安装"→ 预检问题列表 → 权限披露 → 等审批 → 进度（installing/installed/failed）→ 失败可回滚；已安装页支持 更新/停用/卸载/回滚
- Bot 工具列表显示来源插件（`tools[].source`）
- 面板页：列 `panelsFromManifest` 的面板 → 打开面板前 `panel-wake`；503 时显示"面板未运行"而不是白屏
- 纯逻辑抽到 `apps/web/lib/*.js` 并写 node:test；不改现有配对/房间行为

## 验收

```
node --experimental-strip-types --test packages/*/test/*.test.ts apps/*/test/*.test.ts
sh scripts/verify.sh
```
