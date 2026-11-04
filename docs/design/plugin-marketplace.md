# 插件市场：完整适配 DSH 插件

> 状态：最终方案（2026-11-04）。承接 `plugins.md`（预检/锁/信任）与 `sandboxing.md` §15（用户沙箱）。
> 目标：**用户能装 DSH 生态里任意插件**，而我们知道每个插件在云端跑到哪一层、缺什么。

## 1. 先把"装"拆成三个问题

| 问题 | 答案位置 |
|---|---|
| 插件怎么被 DSH 加载 | profile（`package.json` + `dsh.profile.bundles` + `cordis.patch.yml`） |
| 装到哪个 profile | 用户沙箱里的 `/workspace/.dsh/profiles/sdk` |
| 谁来管版本与安全 | 控制面的 lockfile + 预检 + 市场元数据 |

## 2. DSH 插件的真实加载机制（源码核对）

一个 profile 目录就是一个 **pnpm 项目**：

```
/workspace/.dsh/profiles/sdk/
  package.json        # 插件依赖 + dsh.profile.bundles（有序 bundle 列表）
  cordis.patch.yml    # 用户覆盖层
  node_modules/
  pnpm-lock.yaml      # ← 天然的可复现锁
```

- 组合顺序：**`dsh.profile.bundles` 顺序的 bundle patch → `cordis.patch.yml` 用户层 → `--patch` 覆盖**
- 安装命令：`dsh plugin --profile sdk add <pkg>`（就是在 profile 里跑 pnpm）
- 所以我们的"插件锁" = `package.json` + `pnpm-lock.yaml` + 我们的 patch 行 + integrity
- 不同 profile 不共享（桌面装的插件 ≠ 沙箱里的 sdk profile）

## 3. 兼容性分级：什么叫"完整适配"

云端的插件分四级，市场必须对用户标出来：

| 级 | 插件形态 | 云端能否直接用 | 我们要补什么 |
|---|---|---|---|
| **A** | 纯 host 半：工具 / MCP / 技能 / 服务 | ✅ 装进 profile 即可，工具出现在会话 | 预检版本与冲突 |
| **B** | 需要资源：出网、凭据、磁盘/二进制、数据卷 | ✅ 但要声明 | 插件 manifest 声明 → 生成沙箱策略 / 镜像预装 / provider |
| **C** | 有 client 半：面板、widget、slot UI | ⚠️ 需要 UI 表面 | 沙箱内跑 `dsh web` + 控制面反代 + 我们的界面嵌入 |
| **D** | 桌面专有：本地文件、原生模块、系统集成、GUI 凭据库 | ❌ 云端不支持 | 市场标"仅桌面"，引导本机用 |

**B 级需要的声明**（写进插件 manifest，市场展示）：

```yaml
permissions:
  network: [api.tushare.pro, *.eastmoney.com]   # → 生成 tcp/rest 规则
  credentials: [tushare]                        # → 走 provider，不进 env
  disk: 320MB
  binaries: [python3]                           # → 镜像预装或拒绝
  data_mounts: [bars, news]                     # → 只读数据面
```

**C 级：已定方案（ADR 0004）——沙箱里跑 `dsh web`，控制面反代，iframe 嵌面板**

```
用户沙箱（已有，每用户一个）
  ├─ room-agent → dsh --profile sdk     房间对话（现有链路）
  └─ dsh web  127.0.0.1:4099            只给插件面板
        ↑ 反代 /w/<workspace>/dsh/*（设备会话鉴权、base path 剥离）
        ↓
我们的页面：房间照旧；插件面板用一个 iframe 打开
```

**产品界面仍然是我们自己的**（房间/Bot/设置/市场）；DSH Web 只在需要渲染插件面板时出现。

| 项 | 决定 |
|---|---|
| 绑定 | `dsh web` 只绑 127.0.0.1，外部只能经控制面反代 |
| 鉴权 | 反代校验设备会话；iframe 用独立源 + `sandbox="allow-scripts"` |
| 生命周期 | 面板随沙箱 stop/start；打开面板才唤醒 |
| host 半 | 不依赖 DSH Web；面板缺失时工具/技能照常 |
| 面板清单 | 插件 manifest 的 `panels` 声明 + 启动冒烟核对实际注册数 |
| 高级选项 | 允许整页打开 DSH Web（调试/重度用户），不是默认 |

不选自绘（第三方插件永远用不了），不选整站切 DSH Web（等于放弃我们的产品）。见
`docs/decisions/0004-plugin-ui-surface.md`。

**D 级要诚实拒绝**：插件读本机文件、用原生模块、调系统通知/剪贴板，云上跑不了；市场里直接标明，不装。

## 4. 安装流程（唯一入口）

```
市场详情页 → 安装
  ① 预检：DSH 版本区间 / peer 依赖 / bundle patch 冲突（route、slot、id）
           / 磁盘 / 数据挂载 / 网络声明 / tier 判定
  ② 权限披露：它要什么（工具数、网络域、磁盘、面板、凭据）
  ③ 人批准（owner/admin；一次安装一次批准）
  ④ 控制面写锁：package.json + pnpm-lock.yaml + patch 行 + integrity
  ⑤ runtime sync：用户沙箱内 pnpm install --frozen-lockfile + 写 patch
  ⑥ 重启 DSH（沙箱 stop/start；会话 resume 不丢）
  ⑦ 冒烟：声明的工具数/面板数出现、无重复路由
  ⑧ 失败 → 回滚到快照（安装前自动打）
```

**两条纪律**
- 运行时安装禁 `postinstall`（`--ignore-scripts`）；需要构建脚本的插件标记为"仅镜像内"
- 安装前快照 profile；失败自动恢复（不靠人记）

## 5. 市场数据模型

```sql
CREATE TABLE plugin_publishers (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, verified INTEGER NOT NULL DEFAULT 0,
  registry TEXT NOT NULL,        -- npm | roost
  created_at INTEGER NOT NULL
);

CREATE TABLE plugin_market (
  slug TEXT PRIMARY KEY,          -- 例如 dsh-market-center
  title TEXT NOT NULL, publisher_id TEXT NOT NULL,
  category TEXT NOT NULL,         -- 数据 / 报告 / 交易 / 工具 / 技能
  tier TEXT NOT NULL,             -- A|B|C|D（预检后写入）
  summary TEXT NOT NULL, readme TEXT,
  latest TEXT NOT NULL, icon TEXT, screenshots TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE plugin_versions (
  slug TEXT NOT NULL, version TEXT NOT NULL, integrity TEXT NOT NULL,
  engines TEXT, manifest TEXT NOT NULL, permissions TEXT NOT NULL,
  published_at INTEGER NOT NULL, PRIMARY KEY (slug, version)
);

CREATE TABLE plugin_installs (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, slug TEXT NOT NULL,
  version TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
  lock TEXT NOT NULL,             -- package.json+lock 的摘要
  installed_by TEXT NOT NULL, installed_at INTEGER NOT NULL,
  preflight TEXT, UNIQUE (workspace_id, slug)
);
```

来源：**npm 公共 registry + 我们自己的私有 registry（已有 Verdaccio）**；marketplace 是"目录 + 策展 + 预检结果"的叠加，不是另一套包协议。

## 6. API

```
GET  /api/marketplace/plugins?q=&category=&tier=      列表（含兼容性/权限/大小）
GET  /api/marketplace/plugins/:slug                   详情（readme/截图/版本/权限）
GET  /api/marketplace/plugins/:slug/versions
POST /api/marketplace/plugins/:slug/preflight         预检（不落库）
POST /api/marketplace/plugins/:slug/install           {version}
PATCH /api/plugin-installs/:id                        {enabled|version}
DELETE /api/plugin-installs/:id                       卸载（可回滚）
GET  /api/plugin-installs                             已安装（含更新可用）
POST /api/internal/plugins/sync                       沙箱启动前拉锁（runtime token）
```

## 7. UI（市场页三屏）

```
[插件市场] 已安装 / 市场 / 来源
  搜索……
  ┌──────────────┐ ┌──────────────┐
  │ 🧩 行情中心   │ │ 📊 报告引擎   │
  │ 发布者: Roost │ │ 发布者: Roost │
  │ A 级 · 12 工具│ │ B 级 · 320MB │
  │ [安装]        │ │ [安装]        │
  └──────────────┘ └──────────────┘
```

详情页元素：

- 兼容性徽章（A/B/C/D + DSH 版本区间）
- **权限清单**（网络域、凭据、磁盘、面板）——装前必须看到
- README 渲染、截图、变更日志
- 安装按钮（admin 才可点）

已安装页：版本、更新、停用、回滚、依赖树、"它提供了哪些工具/面板"。

Bot 设置里的工具列表要标**来源**（`mcp__data__* ← 行情中心`），用户才知道是谁给的。

## 8. 安全与信任

| 层 | 做法 |
|---|---|
| 运行隔离 | 插件在**用户沙箱内进程内**运行；沙箱是边界，用户之间互不可见 |
| 发布者 | v1 白名单（我们自己 + 已验证发布者）；v2 开放第三方 + 自动扫描 |
| 供应链 | pnpm lock + integrity + `minimumReleaseAge` + 禁运行时 postinstall |
| 权限 | 网络由 manifest 生成策略；凭据走 provider；环境变量禁密钥 |
| 审计 | 安装/升级/卸载/调用都进事件；插件网络与文件访问有沙箱审计 |
| 回滚 | 安装前快照；一键回滚版本或停用 |

## 9. 与 room-agent / 沙箱的集成

```
沙箱启动 → room-agent → `dsh --profile sdk`
                            ↑ profile 在 /workspace/.dsh/profiles/sdk（卷内，持久）
安装/升级：控制面写锁 → 沙箱内 sync → stop/start（会话 resume）→ 新 profile 生效
```

- 插件状态数据也在 `$DSH_HOME`（卷内），升级保留
- 每用户插件集不同：**镜像只带 base，用户层按 lock 生成**
- 装完要重启 DSH：用沙箱 stop/start（我们已经验证会话能 resume）

## 10. 分期

**v1**
- 市场列表/详情/安装/卸载（A/B 级，白名单）
- 预检 + 权限披露 + 安装快照回滚
- `plugins` 表 + lock 生成 + 沙箱 sync

**v1.5**
- C 级：沙箱内 `dsh web` + 反代 + 面板嵌入
- 更新通道 + 依赖树 + Bot 工具来源标注

**v2**
- 开放第三方发布（签名 + 扫描 + 评分）、付费插件、组织私有市场

## 11. 待决

1. **C 级方案**：嵌入 DSH Web（推荐）还是自绘面板？
2. **默认信任**：v1 白名单（推荐）还是允许任意 npm 包（风险高）？
3. **postinstall**：一律禁（推荐）还是允许但隔离构建？
4. **更新策略**：跟镜像（稳）还是独立通道（快）？
5. **市场来源**：npm 公共为主，还是私有 registry 为主（我们自己的插件）？

## 12. 实现状态

- **2026-11-04（M4，TODO 4.3.4）**：`POST /api/internal/plugins/sync` 已落地（runtime token 鉴权，
  未配置 = 404）。锁文档 = package.json + patch 行 + lockfile（可空）+ sha256 integrity +
  内容寻址 id + generatedAt；**锁数据源目前是镜像基线 profile 目录**（apps/runtime/profile/），
  插件市场落地后换成从 plugins 表生成，锁形状不变。启动链路已接：`openShellRuntimeManager.ensure`
  在建沙箱前经 sync 接口拉锁，拉不到即失败（不假装启动成功），锁 id 注入沙箱 env
  （`ROOST_PROFILE_LOCK_ID`）。未做：沙箱内 `dsh plugin sync --lockfile` 应用锁、锁落盘到
  workspace 卷（等真实插件安装才有内容可装）。锁的纯构造在 `packages/plugins/src/profile-lock.ts`。
