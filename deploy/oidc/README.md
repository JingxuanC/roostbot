# 用开源 OIDC 提供方做登录 / 注册

Roost 不自己再实现一套 OAuth 服务；它作为 **OIDC Relying Party**，把注册、登录、找回密码、
多因素交给成熟的开源身份提供方（IdP）。账号在 IdP 完成注册后，第一次登录 Roost 会自动创建
对应的本地账号（`sub` 稳定绑定；邮箱必须被 IdP 标记为已验证）。

## 支持的 IdP（任意标准 OIDC 都可以）

| IdP | 开源协议 | 说明 |
|---|---|---|
| **Keycloak** | Apache-2.0 | 本文提供 docker compose + realm 导入，最完整的参考实现 |
| **Logto** | MPL-2.0 | 现代登录 UI，OIDC；需要 Postgres |
| **Casdoor** | Apache-2.0 | 中文后台、社交登录/OIDC；需要数据库 |
| **Authentik** | MIT/GPL | Python，OIDC/SAML；需要 Postgres/Redis |
| **Zitadel** | Apache-2.0 | Go，OIDC；自带组织/多租户 |
| **Ory** | Apache-2.0 | Hydra/Kratos，模块化，偏基础设施 |

> 没有公开 OAuth/OIDC 的提供方（例如 DeepSeek 目前只有 API Key）不能直接做「账号登录」；
> 那种情况只能把 API Key 作为模型凭据，而不是身份。

## 快速验证：Keycloak

```bash
cd deploy/oidc/keycloak
docker compose up -d
# 管理台 http://localhost:8080  admin / admin
# 邮件箱 http://localhost:8025（注册验证邮件）
# 演示用户 demo@roostbot.local / demo（已预验证）
```

Realm `roostbot` 已开启注册（`registrationAllowed`），客户端 `roostbot` 的回调是
`http://localhost:8787/api/auth/oidc/callback`，并强制 PKCE S256。

启动 Roost 时配置：

```bash
ROOST_OIDC_KEYCLOAK_CLIENT_ID=roostbot
ROOST_OIDC_KEYCLOAK_SECRET=dev-roostbot-secret
ROOST_OIDC_KEYCLOAK_AUTHORIZE_URL=http://localhost:8080/realms/roostbot/protocol/openid-connect/auth
ROOST_OIDC_KEYCLOAK_TOKEN_URL=http://localhost:8080/realms/roostbot/protocol/openid-connect/token
ROOST_OIDC_KEYCLOAK_USERINFO_URL=http://localhost:8080/realms/roostbot/protocol/openid-connect/userinfo
ROOST_OIDC_KEYCLOAK_SCOPE=openid email profile
ROOST_OIDC_REDIRECT_URI=http://localhost:8787/api/auth/oidc/callback
```

打开 `http://localhost:8787/#/login`，登录页会出现 **Keycloak** 按钮；点击后：

- 已有 Keycloak 账号 → 登录
- 没有 → 在 Keycloak 页面注册
- 注册后打开 `http://localhost:8025`，点验证邮件里的链接完成邮箱验证
- 回到 Roost → 自动创建本地账号并进入工作区

## 其他 IdP 的环境变量

Provider id 就是 `ROOST_OIDC_<ID>_*` 里的 `<ID>`（小写），登录页按钮显示对应 label。
任意 id 都可用；内置展示名：`keycloak` `logto` `casdoor` `authentik` `zitadel` `ory`
`google` `github` `feishu`。

### Logto

```bash
ROOST_OIDC_LOGTO_CLIENT_ID=...
ROOST_OIDC_LOGTO_SECRET=...
ROOST_OIDC_LOGTO_AUTHORIZE_URL=https://<tenant>.logto.app/oidc/auth
ROOST_OIDC_LOGTO_TOKEN_URL=https://<tenant>.logto.app/oidc/token
ROOST_OIDC_LOGTO_USERINFO_URL=https://<tenant>.logto.app/oidc/me
ROOST_OIDC_REDIRECT_URI=https://roost.example.com/api/auth/oidc/callback
```

### Casdoor

```bash
ROOST_OIDC_CASDOOR_CLIENT_ID=...
ROOST_OIDC_CASDOOR_SECRET=...
ROOST_OIDC_CASDOOR_AUTHORIZE_URL=https://<casdoor-host>/login/oauth/authorize
ROOST_OIDC_CASDOOR_TOKEN_URL=https://<casdoor-host>/api/login/oauth/access_token
ROOST_OIDC_CASDOOR_USERINFO_URL=https://<casdoor-host>/api/userinfo
```

### Authentik

```bash
ROOST_OIDC_AUTHENTIK_CLIENT_ID=...
ROOST_OIDC_AUTHENTIK_SECRET=...
ROOST_OIDC_AUTHENTIK_AUTHORIZE_URL=https://<authentik-host>/application/o/authorize/
ROOST_OIDC_AUTHENTIK_TOKEN_URL=https://<authentik-host>/application/o/token/
ROOST_OIDC_AUTHENTIK_USERINFO_URL=https://<authentik-host>/application/o/userinfo/
```

生产必须 HTTPS；回调地址要和 IdP 客户端里的 Redirect URI 完全一致。

## 账号与工作区

- 首次 OIDC 登录：按 `sub` 找账号；没有就创建 `accounts` 行（`password_hash = NULL`）。
- 同一邮箱已有**密码账号**：拒绝并提示先用密码登录（不自动合并；安全优先）。
- 不自动合并同一邮箱的不同 OIDC `sub`。
- 新账号第一次进入时，前端会按 `我的工作区` 自动创建一个 workspace。
- Roost 的 `退出` 只清 Roost 会话，不会登出 IdP；这是 OIDC 单点登录的常规行为。

## 安全清单

- [ ] IdP 客户端开启 PKCE（S256）；Roost 已强制发送 `code_challenge`。
- [ ] 回调 URI 精确匹配，不允许通配。
- [ ] IdP 要求邮箱验证；Roost 拒绝 `email_verified=false`。
- [ ] 生产 HTTPS，`ROOST_SECURE_COOKIES=1`，`ROOST_ALLOWED_ORIGINS` 写好。
- [ ] 不要把 IdP 的 client secret 提交到仓库；`deploy/oidc/keycloak/realm-roostbot.json` 里的 secret 仅用于本地开发。

## 已知限制

- 还没有「已有密码账号绑定 OIDC」的界面/接口；当前是拒绝并提示使用原登录方式。后续可加绑定流程。
- 没有 RP-initiated logout；退出 Roost 不会退出 IdP。
- 没有 OIDC discovery 自动拉取 issuer；请按上面的显式 URL 配置（IdP 控制台一般会给出）。
