# 部署 Roost 控制面

单机部署：控制面 + 同源网页 + SQLite + 本地附件卷。没有多副本/HA。
设计细节见 [`docs/design/deployment.md`](../docs/design/deployment.md)。

## 1. 文件

| 文件 | 用途 |
|---|---|
| `env.example` | 全部环境变量、默认值、敏感项 |
| `systemd/roost-api.service` | Linux 单实例单元，`Restart=always`，日志进 journald |
| `launchd/com.roost.api.plist` | macOS LaunchDaemon |
| `nginx.conf` | 同源反代、TLS、SSE、独立 DSH origin |
| `backup.sh` | 用 `sqlite3 .backup` 备份数据库 + 附件 tar |
| `restore.sh` | 校验并恢复到空目标，拒绝覆盖 |

## 2. 前置

- Node **≥ 22.18**（`node:sqlite` + 类型擦除）；本机实测 v24.13.0。
- `sqlite3` CLI（备份/恢复用；实测 3.43.2）。
- 可选：OpenShell CLI/gateway + Docker ≥ 28（只有启用沙箱时才需要）。
- 仓库零依赖，不需要 `npm install`。

```sh
git clone https://github.com/JingxuanC/roostbot /opt/roost
cd /opt/roost
node --version
```

## 3. Linux（systemd）

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
journalctl -u roost-api -f
```

`/etc/roost/api.env` 至少要改：

```sh
ROOST_SIGNING_SECRET=<32 字节以上随机值>
ROOST_RUNTIME_TOKEN=<随机值，启用沙箱时必填>
ROOST_DB=/var/lib/roost/roost.db
ROOST_ATTACHMENTS_DIR=/var/lib/roost/attachments
```

`ROOST_SANDBOX=openshell` 时才需要 `ROOST_CP_HOST` / `ROOST_CP_PORT` / `ROOST_SANDBOX_IMAGE`。
不启用沙箱就删掉这一行，`/start` 会明确返回 `runtime.not_configured`。

## 4. macOS（launchd）

下面的 `roost` 用户需要先创建，或把 `-o roost` / plist 里的 `UserName` 改成实际服务账号。

```sh
sudo install -d -o roost -g staff -m 0700 /usr/local/var/roost
sudo install -d -o root -g staff -m 0750 /usr/local/etc/roost
sudo install -m 0640 -o root -g staff deploy/env.example /usr/local/etc/roost/api.env
sudoedit /usr/local/etc/roost/api.env
sudo install -d -o roost -g staff -m 0750 /usr/local/var/log/roost
sudo cp deploy/launchd/com.roost.api.plist /Library/LaunchDaemons/com.roost.api.plist
sudo launchctl bootstrap system /Library/LaunchDaemons/com.roost.api.plist
sudo launchctl kickstart -k system/com.roost.api
curl -fsS http://127.0.0.1:8787/healthz
tail -f /usr/local/var/log/roost/roost-api.log
```

macOS 上把环境文件里的数据路径改成：

```sh
ROOST_DB=/usr/local/var/roost/roost.db
ROOST_ATTACHMENTS_DIR=/usr/local/var/roost/attachments
```

plist 里的 node 路径是 `/usr/bin/env node`；如果 Node 不在 launchd 的 PATH 里，改成绝对路径。
launchd 不轮转日志文件，需要外部 newsyslog/logrotate。

## 5. 反代与 TLS

```sh
sudo cp deploy/nginx.conf /etc/nginx/conf.d/roost.conf
sudo nginx -t
sudo systemctl reload nginx
```

要点：

- `/` → `127.0.0.1:8787`，不要加任何 CORS 头。
- SSE 必须 `proxy_buffering off` + `X-Accel-Buffering: no`。
- 访问日志只记 `$uri`，避免 `?access_token=` 落盘。
- `/w/` 必须在**另一个端口或域名**上，才是独立 origin；只改上游端口没用。
- `/metrics` 无鉴权，示例配置只允许回环/内网。

**当前限制**：控制面写操作只接受回环 Origin（`403 forbidden_origin`），
`/api/config` 也固定返回 `http://<Host>:<ROOST_DSH_PROXY_PORT>`。公网域名 + TLS 的完整可用性
需要后续实现公开 Origin 白名单与 DSH base URL；不要把 Origin 改写成回环地址来绕过 CSRF。

## 6. 首次配对

控制面没有密码登录；首台设备用一次性配对码（5 分钟、单次）。从本机执行：

```sh
curl -sS -X POST http://127.0.0.1:8787/api/pairing/code \
  -H 'content-type: application/json' \
  -d '{"accountId":"acc_local"}'
```

响应里的 `code` 输入网页 `http://127.0.0.1:8787/` 的配对页即可。
远程访问用 SSH 隧道把 8787 映射到本机，浏览器仍看到回环 Origin。

## 7. 备份与恢复

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

行为：

- 数据库用 `sqlite3 .backup`，活动 WAL 库也一致；**不要 `cp` 活动库**。
- 备份目录包含 `roost.db`、`attachments.tar.gz`、`manifest.txt`、`counts.txt`、`SHA256SUMS`。
- 恢复先校验 `PRAGMA integrity_check`、SHA256、逐表行数；默认拒绝覆盖已有库或非空附件目录。
- 备份/恢复只覆盖控制面数据库与附件；**不含沙箱卷**。

### 7.1 实测：backup → 删库 → restore

以下命令在 macOS 上实际跑过（Node v24.13.0 / sqlite3 3.43.2）：

```sh
ROUNDTRIP=$(mktemp -d)
mkdir -p "$ROUNDTRIP/data/attachments/ac/me" "$ROUNDTRIP/backups"
printf 'attachment-one\n' > "$ROUNDTRIP/data/attachments/ac/me/blob"
printf '{"mime":"text/plain"}\n' > "$ROUNDTRIP/data/attachments/ac/me/meta.json"

export TEST_DB="$ROUNDTRIP/data/roost.db"
node --experimental-strip-types --input-type=module <<'EOF'
import { openStore, createWorkspace, appendEvent } from './packages/store/src/index.ts'
const store = openStore(process.env.TEST_DB)
createWorkspace(store, { id: 'ws_backup_test', tenantId: 'tenant_backup_test', name: 'backup-test', profileVersion: 'test' })
for (let i = 0; i < 3; i += 1) {
  appendEvent(store, {
    domain: 'test',
    kind: 'test.event',
    actor: { kind: 'system', id: 'backup-test' },
    subject: { kind: 'workspace', id: 'ws_backup_test' },
    idem: `backup-test-${i}`,
    payload: { i }
  })
}
store.close()
EOF

deploy/backup.sh "$ROUNDTRIP/data/roost.db" "$ROUNDTRIP/data/attachments" "$ROUNDTRIP/backups"
BACKUP_DIR=$(find "$ROUNDTRIP/backups" -maxdepth 1 -type d -name 'roost-backup-*' | head -1)

rm -f "$ROUNDTRIP/data/roost.db" "$ROUNDTRIP/data/roost.db-wal" "$ROUNDTRIP/data/roost.db-shm"
rm -rf "$ROUNDTRIP/data/attachments"

deploy/restore.sh "$BACKUP_DIR" "$ROUNDTRIP/data/roost.db" "$ROUNDTRIP/data/attachments"
sqlite3 "$ROUNDTRIP/data/roost.db" 'PRAGMA integrity_check; SELECT COUNT(*) FROM events; SELECT COUNT(*) FROM workspaces; SELECT COUNT(*) FROM schema_migrations;'
cat "$ROUNDTRIP/data/attachments/ac/me/blob"
```

结果：

| 检查 | 结果 |
|---|---|
| backup 摘要 | `events=3 workspaces=1 attachments=0 migrations=16` |
| restore | 成功，`tables=39` |
| `PRAGMA integrity_check` | `ok` |
| `events` / `workspaces` / `schema_migrations` | `3` / `1` / `16` |
| 附件文件 | `attachment-one`，与备份前一致 |
| 活动 WAL 库（进程仍持有时）备份 | 快照含未 checkpoint 的 1 条事件 |
| 恢复到已存在数据库 | `refusing to overwrite existing database` |
| 恢复到非空附件目录 | `refusing to overwrite non-empty attachments directory` |

### 7.2 静态检查

```sh
bash -n deploy/backup.sh
bash -n deploy/restore.sh
plutil -lint deploy/launchd/com.roost.api.plist
```

实测均通过。`nginx -t` 与 `systemd-analyze verify` 需要目标系统安装对应工具；
开发机（macOS）没有 nginx/systemd，未执行这两项。

## 8. 升级与回滚

升级：

```sh
sudo -u roost deploy/backup.sh /var/lib/roost/roost.db /var/lib/roost/attachments /var/backups/roost
sudo systemctl stop roost-api
sudo git -C /opt/roost fetch --tags
sudo git -C /opt/roost checkout <new-tag>
sudo systemctl start roost-api
curl -fsS http://127.0.0.1:8787/healthz
journalctl -u roost-api -n 50 --no-pager
```

迁移在 `openStore()` 启动时自动执行，只向前、没有 down 迁移。回滚：

```sh
sudo systemctl stop roost-api
sudo mv /var/lib/roost/roost.db /var/lib/roost/roost.db.failed-$(date -u +%Y%m%dT%H%M%SZ)
sudo mv /var/lib/roost/attachments /var/lib/roost/attachments.failed-$(date -u +%Y%m%dT%H%M%SZ)
sudo -u roost deploy/restore.sh <backup-dir> /var/lib/roost/roost.db /var/lib/roost/attachments
sudo git -C /opt/roost checkout <previous-tag>
sudo systemctl start roost-api
curl -fsS http://127.0.0.1:8787/healthz
```

## 9. 多环境

每个环境独立数据库、附件目录、端口、签名密钥、runtime token、备份目录。示例：

| 项 | dev | staging | prod |
|---|---|---|---|
| `PORT` | 8788 | 8789 | 8787 |
| `ROOST_DSH_PROXY_PORT` | 4198 | 4199 | 4098 |
| `ROOST_DB` | `./data/dev/roost.db` 或 `memory` | `/var/lib/roost-staging/roost.db` | `/var/lib/roost/roost.db` |
| 附件 | `./data/dev/attachments` | `/var/lib/roost-staging/attachments` | `/var/lib/roost/attachments` |
| 沙箱 | 不开 | 独立 OpenShell gateway | 生产 gateway |

同一台机器上 staging 与 prod 共用 OpenShell gateway 会撞沙箱名（`user-<8hex>`），必须分 gateway
或分主机。staging 从 prod 备份恢复前要先脱敏；仓库没有脱敏工具。

## 10. 排障

| 现象 | 检查 |
|---|---|
| 启动即退出 | `PORT` 是否合法；`ROOST_DSH_PROXY_PORT` 是否与主端口冲突；数据库是否可写 |
| `/healthz` 200 但接口 500 | `/healthz` 不查数据库；看 journald 与 `PRAGMA integrity_check` |
| 写入 403 `forbidden_origin` | 浏览器从非回环 Origin 发 POST；走 SSH 隧道或等 Origin 白名单 |
| SSE 延迟/成批 | 反代缓冲没关；检查 `proxy_buffering off` 与 `X-Accel-Buffering` |
| DSH 面板 502 | 沙箱内 `dsh web` 未起，或宿主到 `127.0.0.1:4099` 不可达 |
| 面板空白/混合内容 | TLS 下 `/api/config` 返回 http；当前未闭环 |
| 备份 `database is locked` | 长时间写事务；重试，不要改成 `cp` |
