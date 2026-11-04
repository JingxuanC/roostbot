# 部署：单机控制面、反代与备份

> 状态：实现补充（M6-6.7 / D2）。配套：`deploy/` 下的单元、反代、环境文件与备份脚本；
> `observability.md`（指标）、`slo.md`（SLO）、`compliance.md`（保留与删除）。
>
> 当前部署形态是**单机单进程**：控制面、网页、SQLite、附件卷都在一台机器上。
> 没有 HA、没有多副本、没有跨区域；不要按集群方式部署。

## 1. 拓扑

```
浏览器 / 手机
   │ HTTPS（同源）
   ▼
nginx / Caddy / 云负载均衡（TLS 终止）
   │
   ├── 443   → 127.0.0.1:8787   控制面主进程（apps/api）
   │                                ├─ /              apps/web 静态页 + API + SSE
   │                                ├─ SQLite         ROOST_DB
   │                                ├─ 附件卷         ROOST_ATTACHMENTS_DIR
   │                                └─ 调度 tick      ROOST_SCHEDULER=1
   │
   └── 8443  → 127.0.0.1:4098   DSH 反代（同 host 的第二个监听，独立 origin）
                                    └─ /w/<workspaceId>/dsh/* → 127.0.0.1:4099

OpenShell 沙箱（每个 workspace 一个，固定名 user-<8hex>）
   └─ room-agent
        ├─ dsh --profile sdk（长活 JSON-RPC，stdio）
        └─ dsh web 127.0.0.1:4099（插件面板，只在沙箱内监听）
```

**一条硬边界**：同一个 `ROOST_DB` 只能有一个控制面进程写。SQLite 是单写者；内存限流桶、
指标计数、DSH cookie 签名也都按进程隔离。多实例会得到不一致的限流、指标和会话行为。

## 2. 组件与端口

| 组件 | 默认 | 说明 |
|---|---|---|
| 控制面主端口 | `PORT=8787` | `/`、`/api/*`、`/healthz`、`/metrics`、SSE |
| DSH 反代端口 | `ROOST_DSH_PROXY_PORT=4098` | 只服务 `/w/:workspaceId/dsh/*`；`0` 关闭 |
| DSH 公网端口 | `ROOST_DSH_PROXY_PUBLIC_PORT=8443` | `/api/config` 推导 `dshBase` 时使用的对外端口；未配置用实际反代端口 |
| DSH 公开 origin | `ROOST_DSH_PUBLIC_ORIGIN` | 完整 `http(s)://host[:port]`，配置后直接作为 `dshBase`，优先于自动推导 |
| 公网 Origin 白名单 | `ROOST_ALLOWED_ORIGINS` | 逗号分隔精确 origin；留空=仅回环与同源。不接受 `*` / `null` |
| 沙箱内 dsh web | `DSH_WEB_PORT=4099` | 反代目标固定 `127.0.0.1:4099` |
| SQLite | `ROOST_DB=/var/lib/roost/roost.db` | 文件库自动开 WAL；`memory` 仅演示 |
| 附件卷 | `ROOST_ATTACHMENTS_DIR=/var/lib/roost/attachments` | 内容寻址，目录 0700 / 文件 0600 |
| 调度 | `ROOST_SCHEDULER=1` | 10s tick；需要 SQLite |
| 沙箱管理 | `ROOST_SANDBOX=openshell` | 只有这个值启用；否则 `/start` 返回 `runtime.not_configured` |

完整变量、默认值与敏感项见 [`deploy/env.example`](../../deploy/env.example)。

## 3. 进程管理

### 3.1 systemd（Linux）

单元文件：[`deploy/systemd/roost-api.service`](../../deploy/systemd/roost-api.service)。

```sh
sudo useradd --system --home /var/lib/roost --shell /usr/sbin/nologin roost
sudo chown -R root:roost /opt/roost
sudo chmod -R g+rX /opt/roost
sudo install -d -o roost -g roost -m 0700 /var/lib/roost
sudo install -d -o root -g roost -m 0750 /etc/roost
sudo install -m 0640 -o root -g roost deploy/env.example /etc/roost/api.env
sudoedit /etc/roost/api.env
sudo install -m 0644 deploy/systemd/roost-api.service /etc/systemd/system/roost-api.service
sudo systemctl daemon-reload
sudo systemctl enable --now roost-api
curl -fsS http://127.0.0.1:8787/healthz
```

- `Restart=always`、`RestartSec=2`、`StartLimitIntervalSec=0`：崩溃后一直重试，不进入失败锁定。
- `StateDirectory=roost` 创建 `/var/lib/roost`；`UMask=0077` 让数据库与附件默认不可被其他用户读。
- 日志走 journald（`journalctl -u roost-api -f`）。轮转由 journald 负责，容量策略见
  `/etc/systemd/journald.conf` 的 `SystemMaxUse` / `MaxRetentionSec`。
- `ExecStart` 使用 `/usr/bin/env node`。如果 Node 不在 systemd 的 PATH 里，改成绝对路径。

### 3.2 launchd（macOS）

plist：[`deploy/launchd/com.roost.api.plist`](../../deploy/launchd/com.roost.api.plist)。

```sh
sudo install -d -o roost -g staff -m 0700 /usr/local/var/roost
sudo install -d -o root -g staff -m 0750 /usr/local/etc/roost
sudo install -m 0640 -o root -g staff deploy/env.example /usr/local/etc/roost/api.env
sudoedit /usr/local/etc/roost/api.env
sudo install -d -o roost -g staff -m 0750 /usr/local/var/log/roost
sudo cp deploy/launchd/com.roost.api.plist /Library/LaunchDaemons/com.roost.api.plist
sudo launchctl bootstrap system /Library/LaunchDaemons/com.roost.api.plist
sudo launchctl kickstart -k system/com.roost.api
sudo launchctl print system/com.roost.api
```

- `roost` 用户需要先创建，或统一改成实际服务账号。
- macOS 上把 `ROOST_DB` / `ROOST_ATTACHMENTS_DIR` 改到 `/usr/local/var/roost/` 下。
- plist 通过 `/bin/bash -c 'set -a; . /usr/local/etc/roost/api.env; exec node …'` 读取环境文件；
  环境文件必须是 `KEY=value` 形式（不要写 `export`）。
- `KeepAlive=true` + `ThrottleInterval=10` 等价于 systemd 的 always restart。
- 日志写到 `/usr/local/var/log/roost/roost-api.log`。launchd 不轮转这个文件；需要外部
  newsyslog/logrotate（或改用统一日志）。仓库没有内置 macOS 轮转配置。

## 4. 反代与 TLS

示例：[`deploy/nginx.conf`](../../deploy/nginx.conf)。

| 要求 | 做法 |
|---|---|
| 同源 | 网页由控制面同源伺服；反代只做转发，**不要加 CORS 头** |
| SSE | `proxy_buffering off`、`proxy_cache off`、`proxy_read_timeout 3600s`、`X-Accel-Buffering: no` |
| 上传 | `client_max_body_size` ≥ 产物上限 50 MB |
| 访问日志 | 只记 `$uri`，不记 query；SSE 的 `?access_token=` 不能进日志 |
| TLS | 在反代终止；控制面仍只监听回环 |
| DSH 独立 origin | 必须让浏览器看到**不同端口或不同 host**；只把 `/w/` 指到 4098 不会改变浏览器 origin |

### 4.1 公网 Origin 与 CSRF

控制面写操作（非 GET/HEAD）接受三类 Origin：

1. **回环 Origin**：本机页面（`http://127.0.0.1:*` / `localhost` / `[::1]`）。
2. **同源**：Origin 的 `scheme://host[:port]` 与请求的 `X-Forwarded-Proto`（缺省 http）+
   `Host`（或 `X-Forwarded-Host`）完全一致。比较前统一小写并省略默认端口（443/80）。
3. **显式白名单**：`ROOST_ALLOWED_ORIGINS` 中逗号分隔的精确 origin 命中。不接受 `*` 与 `null`。

`Origin: null` 一律拒绝（`/w/.../dsh/*` 反代路径本就豁免控制面 Origin 校验）。没有 Origin 的
非浏览器客户端继续放行，CSRF 防护本身不变。

前提：反代必须覆盖 `Host`（`proxy_set_header Host $host`）并设置
`X-Forwarded-Proto $scheme`，必要时覆盖 `X-Forwarded-Host`。控制面只监听回环，不要把 8787
直接暴露公网——否则客户端能同时伪造 Origin 与这些头，同源判断就失效。

### 4.2 DSH 面板地址推导

`GET /api/config` 的 `dshBase` 按以下顺序确定：

1. `ROOST_DSH_PUBLIC_ORIGIN`：完整 `http(s)://host[:port]`，带路径/query 视为非法并忽略；
2. `X-Forwarded-Proto`（http/https，缺省 http）+ `Host` 主机名 + `ROOST_DSH_PROXY_PUBLIC_PORT`
   （未配置时用实际反代端口 `ROOST_DSH_PROXY_PORT`）；
3. 未启用反代端口且没有 `ROOST_DSH_PUBLIC_ORIGIN` 时返回 `null`。

`https + 443` / `http + 80` 会自动省略端口。示例：`X-Forwarded-Proto=https`、
`Host=roost.example.com`、`ROOST_DSH_PROXY_PUBLIC_PORT=8443` → `https://roost.example.com:8443`，
TLS 页面加载 iframe 不会触发混合内容拦截。

### 4.3 剩余限制

**DSH 反代目标假设同机**：控制面固定连 `127.0.0.1:4099`。`dsh web` 在 OpenShell 沙箱里，
宿主到沙箱的 4099 端口转发/代理不在本仓库实现内；只有二者网络命名空间可达时面板才工作。

### 4.4 可用的访问方式

- 本机：`http://127.0.0.1:8787/`。
- 远程：SSH 隧道（`ssh -L 8787:127.0.0.1:8787 host`）或 VPN；浏览器仍看到回环 Origin。
- 公网域名：按本节配置反代头与 `ROOST_ALLOWED_ORIGINS`（同源通常无需白名单）后，读写均可用。

## 5. 数据目录与权限

```
/opt/roost/                       代码（roost 可读）
/etc/roost/api.env                环境文件（root:roost 0640）
/var/lib/roost/                   StateDirectory（roost:roost 0700）
├── roost.db                      SQLite 主库
├── roost.db-wal / -shm           WAL / 共享内存（活动时存在）
└── attachments/ab/cd/<id>/       blob + meta.json（目录 0700，文件 0600）
```

- 备份必须同时覆盖数据库与 `attachments/`；只备份数据库会丢附件内容。
- `ROOST_SIGNING_SECRET` 变更会让所有已签发的附件 URL 与 DSH 会话 cookie 失效（可接受，但要预期）。
- 内存模式（`ROOST_DB=memory`）没有附件存储、没有调度、没有内部接口持久化，只用于演示。

## 6. 备份与恢复

脚本：[`deploy/backup.sh`](../../deploy/backup.sh)、[`deploy/restore.sh`](../../deploy/restore.sh)。

```sh
sudo install -d -o roost -g roost -m 0700 /var/backups/roost
sudo -u roost deploy/backup.sh \
  /var/lib/roost/roost.db \
  /var/lib/roost/attachments \
  /var/backups/roost

sudo -u roost deploy/restore.sh \
  /var/backups/roost/roost-backup-20261104T102834Z \
  /var/lib/roost/roost.db \
  /var/lib/roost/attachments
```

- 数据库用 `sqlite3 .backup` 取一致快照（活动 WAL 库也安全），**不要直接 `cp`** 活动库。
- 附件目录用 tar 打包；备份目录含 `manifest.txt`、`counts.txt`、`SHA256SUMS`。
- 恢复默认拒绝覆盖已有数据库或非空附件目录；先用新路径恢复，确认后再切换。
- 恢复会校验 `PRAGMA integrity_check`、SHA256、逐表行数与备份一致。
- 备份产物是整库 + 整个附件卷，不是按 workspace 导出。多租户导出尚未实现。

实测记录（2026-11-04，macOS，Node v24.13.0 / sqlite3 3.43.2）：

| 步骤 | 结果 |
|---|---|
| 临时库写入 1 个 workspace + 3 条事件 + 1 个附件文件 | 建库成功 |
| `backup.sh` | `events=3 workspaces=1 migrations=16` |
| 删除库与附件目录后 `restore.sh` | `integrity_check=ok`，`events=3`，`workspaces=1`，`schema_migrations=16`，39 张表 |
| 附件文件内容 | 与备份前一致 |
| 活动 WAL 库（进程仍持有时）备份 | 快照含未 checkpoint 的 1 条事件 |
| 恢复到已存在数据库 / 非空附件目录 | 按预期拒绝 |

## 7. 升级与回滚

迁移是**只向前**的：`openStore()` 启动时按文件名升序执行 `migrations/*.sql`，没有 down 迁移。
因此升级前必须备份；回滚代码不一定能回滚 schema。

### 升级

```sh
sudo -u roost deploy/backup.sh /var/lib/roost/roost.db /var/lib/roost/attachments /var/backups/roost
sudo systemctl stop roost-api
sudo git -C /opt/roost fetch --tags
sudo git -C /opt/roost checkout <new-tag>
sudo -u roost node --version
sudo systemctl start roost-api
curl -fsS http://127.0.0.1:8787/healthz
journalctl -u roost-api -n 50 --no-pager
```

验收顺序：**备份 → 停服 → 换代码 → 启动（自动迁移）→ `/healthz` → 关键接口冒烟**。

### 回滚

```sh
sudo systemctl stop roost-api
sudo mv /var/lib/roost/roost.db /var/lib/roost/roost.db.failed-$(date -u +%Y%m%dT%H%M%SZ)
sudo mv /var/lib/roost/attachments /var/lib/roost/attachments.failed-$(date -u +%Y%m%dT%H%M%SZ)
sudo -u roost deploy/restore.sh <backup-dir> /var/lib/roost/roost.db /var/lib/roost/attachments
sudo git -C /opt/roost checkout <previous-tag>
sudo systemctl start roost-api
curl -fsS http://127.0.0.1:8787/healthz
```

`restore.sh` 不允许覆盖非空目标，所以先把失败库/附件目录改名保留，便于事后取证。
如果新版本没有执行新迁移，也可以只回滚代码、不回滚数据库；是否回滚数据看迁移是否兼容。

## 8. 多环境（dev / staging / prod）

每个环境必须独立：数据库、附件目录、端口、签名密钥、runtime token、日志、备份目录。
不要共用 `ROOST_DB`，也不要把 staging 指向生产附件卷。

| 项 | dev | staging | prod |
|---|---|---|---|
| 代码目录 | 仓库工作区 | `/opt/roost-staging` | `/opt/roost` |
| 环境文件 | shell export | `/etc/roost/staging.env` | `/etc/roost/api.env` |
| `PORT` | 8788 | 8789 | 8787 |
| `ROOST_DSH_PROXY_PORT` | 4198 | 4199 | 4098 |
| `ROOST_DB` | `./data/dev/roost.db` 或 `memory` | `/var/lib/roost-staging/roost.db` | `/var/lib/roost/roost.db` |
| 附件 | `./data/dev/attachments` | `/var/lib/roost-staging/attachments` | `/var/lib/roost/attachments` |
| 调度 | 关 | 按需 | 开 |
| 沙箱 | 不开 | 独立 OpenShell gateway | 生产 gateway |
| 备份 | 无 | 每日 | 每日 + 异地 |

同一台机器跑 staging 与 prod 时：

- systemd 用不同 unit 名或 `EnvironmentFile`，不要复制同一个 unit 直接覆盖。
- `ROOST_SANDBOX=openshell` 的沙箱名由 workspace id 生成（`user-<8hex>`）；两个环境共用
  一个 OpenShell gateway 会撞名，必须分 gateway 或分主机。
- staging 从 prod 备份恢复前要评估数据脱敏；仓库没有脱敏工具。

## 9. 回环与公网边界

| 面 | 当前行为 | 建议 |
|---|---|---|
| 控制面监听 | 默认 `127.0.0.1:8787` | 只让反代/SSH 隧道访问 |
| 写操作 Origin | 回环、同源（Origin 与 X-Forwarded-Proto+Host 一致）、显式白名单；无 Origin 放行，`null` 拒绝 | 反代必须覆盖 Host 与 X-Forwarded-Proto；白名单只写精确 origin |
| `/api/config` | 按 PUBLIC_ORIGIN 或 X-Forwarded-Proto+Host+公网端口推导 `dshBase` | 只监听回环，Host 由反代控制 |
| 内部接口 | `ROOST_RUNTIME_TOKEN` 未配置=关闭（404） | 生产必填；不要与用户 token 混用 |
| `/metrics` | 无鉴权 | 只允许监控网段，或直接抓 8787 |
| `/healthz` | 无鉴权；SQLite 模式执行 `SELECT 1`，失败返回 503 | 可作存活+基本可用性探针；不替代完整业务检查 |
| SSE | 支持 `?access_token=` | 反代访问日志去掉 query；不要把 URL 贴到工单 |
| DSH 反代 | 独立端口，Bearer 或 15 分钟 HttpOnly cookie | 必须与主站不同 origin；不要并入主站路径 |
| 沙箱 | 凭据由 OpenShell provider 注入，runtime token 走 env | 不要写进镜像层或卷 |

## 10. 故障与降级

| 现象 | 可能原因 | 处理 |
|---|---|---|
| 启动即退出 | `PORT` 非法、数据库不可写、`ROOST_DSH_PROXY_PORT` 与主端口相同/被占用 | 看 journald；`ss -ltnp` 查端口 |
| `/healthz` 503 `db:error` | SQLite 磁盘满/权限/损坏 | 查日志里的具体错误与 `PRAGMA integrity_check` |
| 写入 403 `forbidden_origin` | 反代没覆盖 Host / 没设置 X-Forwarded-Proto，或 Origin 不在回环/同源/白名单 | 检查 `proxy_set_header Host $host`、`X-Forwarded-Proto $scheme`；必要时加 `ROOST_ALLOWED_ORIGINS`；不要改写 Origin |
| SSE 延迟/成批到达 | 反代缓冲 | 确认 `proxy_buffering off` 与 `X-Accel-Buffering: no` |
| DSH 面板 502 `dsh.unavailable` | `dsh web` 未起或 4099 不可达 | 查沙箱进程与端口转发 |
| 面板空白/混合内容 | `/api/config` 仍返回 http，页面是 https | 确认反代传 `X-Forwarded-Proto https`，或显式配置 `ROOST_DSH_PUBLIC_ORIGIN` / `ROOST_DSH_PROXY_PUBLIC_PORT` |
| 限流突然失效 | 控制面重启（内存令牌桶清空） | 预期行为；不要把限流当持久配额 |
| 备份失败 `database is locked` | 长时间写事务 | 重试；`.backup` 会自己重试，不要改为 cp |

## 11. 相关文件

| 文件 | 用途 |
|---|---|
| `deploy/env.example` | 全部环境变量、默认值、敏感项 |
| `deploy/systemd/roost-api.service` | Linux 单实例单元 |
| `deploy/launchd/com.roost.api.plist` | macOS LaunchDaemon |
| `deploy/nginx.conf` | 同源反代、SSE、独立 DSH origin |
| `deploy/backup.sh` / `deploy/restore.sh` | 在线 SQLite 备份 + 附件卷恢复 |
| `deploy/README.md` | 从零部署与实测命令 |
