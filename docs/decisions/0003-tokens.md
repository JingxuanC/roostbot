# 0003 — 三种 token 严格分开

- 状态：已定
- 日期：2026-11-03

| token | 签发者 | 持有者 | 有效期 | 用途 |
|---|---|---|---|---|
| 会话 token | 控制面 | 浏览器 / 桌面 / 手机 | 30 天，可续至 180 天 | 访问控制面 |
| runtime token | 控制面 | 某个 workspace 容器 | 分钟级（随容器） | 访问该容器的 DSH |
| provider token | 用户自填 | 密钥服务 → 模型代理 | 用户可撤销 | 调模型 / 数据源 |

## 硬规则

1. provider token **不进** `$DSH_HOME`、不进会话文件、不进提示词、不进日志
2. 容器崩溃重启后 runtime token 必须重新签发
3. 删除账号 = 删会话 + 删密钥 + 删卷
4. 所有日志脱敏规则与 bot-events 共用同一份（token/key/secret/cookie/password/authorization）
