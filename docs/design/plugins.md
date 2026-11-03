# 插件：同一套模型，但有三个平台层补丁

> 状态：方案（2026-11-03）。回答一个问题：**我们做的行情插件，装进 roostbot 是完全兼容 DSH 吗？**
> 配套：`sandboxing.md`（插件在进程内＝可信代码）、`workspace.md`（profile 与卷）、`connectors.md`（连接器不是插件）。

## 1. 一句话回答

**是同一套插件模型，兼容；但不是"透明兼容"。** 插件本身不用改，平台要在外面补三件事：**版本预检、无人值守安装、信任与授权**。

## 2. DSH 插件模型（我们已经在用的）

```
profile = package.json 的依赖 + cordis.yml（空树）+ cordis.patch.yml（覆盖层）
插件包 = 一个 npm 包，声明 dsh.bundle.patch 或直接是 bundle 的依赖
   ├─ host 半：lib/index.js（Cordis 服务、工具、HTTP 路由）
   └─ client 半：lib/client.js（CJS 注册到 __ModuleLoader__，占 slot）
安装 = 往 profile 的依赖里加一条，pnpm 装进 profile/node_modules
```

我们现有的量化族**全部是这套**：`dsh-market-center`、`quant-report-engine`（Python 引擎 + MCP 适配）、`quant-skills-langalpha`（35 个技能）、`dsh-market-watch`、`quant-team-ops`……

**所以：安装兼容性本身不是问题**——插件不改，照样装进 roostbot 的 workspace profile。

## 3. 三个"不完全兼容"的地方（平台必须补）

### ① 版本预检：不能"装完再炸"

我们踩过两次真实的坑：

| 事故 | 原因 |
|---|---|
| `dsh-uzi` 装进新 DSH 后启动报 `Cannot read properties of undefined (reading 'prefixes')` | 插件的 peer 依赖是旧版本 DSH API |
| 两个 bundle 都注册 `/api/trust-center` | 重复路由，第二个直接失败 |

所以安装前必须跑**预检**：

```
1. 读插件 package.json 的 engines.dsh / peerDependencies
2. 和当前 workspace 的 DSH 版本比对（区间求交）
3. 检查 bundle patch 的行 id 是否与已装插件冲突（重复路由/重复 id）
4. 检查磁盘（Python 引擎 + 模型文件可能几百 MB）
5. 检查数据依赖（需要 bars 数据集的插件要确认只读数据面已挂载）
6. 在临时 profile 里 dry-run 一次 mount（能装但挂不起来，也算失败）
```

**任何一项失败：禁止安装，并说明原因**——不是装完让用户看崩溃日志。

### ② 无人值守安装：不能有人点“是”

DSH 桌面端的 `plugin add` 是交互式的（确认、选版本）。云上容器里没有交互：

```
控制面生成 plugins.lock.json（名字+版本+完整性哈希）
   ↓
容器启动时：dsh plugin sync --lockfile
   ↓
失败 → 容器不进入 running（不是降级启动）
```

这就是 `runtime-contract.md` 第 6 条。我们已经在 spike 里验证过：`dsh plugin --profile X add <pkg>` 是**可非交互**的（`--dump-config` 可用于校验）。

### ③ 信任与授权：插件是可信代码

**插件在 host 进程内运行**（`sandboxing.md` §2），所以：

| 事实 | 后果 |
|---|---|
| 插件能读宿主服务、能注册路由、能调工具 | 一个恶意插件能拿到同进程的凭据与数据 |
| 没有插件级权限边界 | **安全边界只能是容器**（一个 workspace 一个容器） |
| 插件能改 PATH/git 配置（OpenMausBot 文档明说） | 装插件会改变整个 workspace 的行为 |

所以平台层必须有三道：

1. **签名与允许列表**：只允许我们发布的（或白名单的）插件；安装时校验签名
2. **按租户授权**：哪些插件属于哪个套餐/租户（免费版只给基础族）
3. **装前显示代价**：面板/工具数/磁盘/数据依赖（`ui.md` §3.8）

## 4. 三类插件，三种安装路径

| 类别 | 例子 | 安装方式 | 谁能改 |
|---|---|---|---|
| **基础族**（镜像预置） | ds-bot、配置层 | 镜像构建时打入 | 不能改，随镜像升级 |
| **可授权族**（市场） | 行情中心、报告引擎、技能包 | 控制面 lockfile → runtime sync | admin |
| **本地开发**（link） | 自己写的插件 | **云上禁止**（`link:` 不进云） | 仅本机 |

**明确禁止**：把 `link:` 依赖带进云端 profile（我们开发机上就这么干的，那是本机特权）。

## 5. 生命周期

```
安装 → 启用 → 升级 → 停用 → 卸载
```

| 动作 | 步骤 | 回滚 |
|---|---|---|
| 安装 | 预检 → 快照 profile → 写 lockfile → sync → 重启声明 → 冒烟 | 恢复快照 |
| 升级 | 预检新版本 → 快照 → 替换版本 → sync → 冒烟 | 恢复快照（含版本钉） |
| 停用 | 从 patch 里 disable（不卸载） | 重新 enable |
| 卸载 | 预检反向依赖 → 卸载 → sync | 恢复快照 |

**冒烟**（安装后必跑，30 秒内）：

1. `GET /healthz` 通过
2. 插件声明的面板数 = 实际注册数
3. 声明的工具在工具列表里出现
4. 没有重复路由/重复 id 警告

## 6. 版本与兼容矩阵

```yaml
# 插件包自带的兼容声明
dsh:
  engines: "^0.2.1-alpha.2"       # peer 依赖区间
  slots: [main, sidebar.panellist, shell.overlay]
  services: [sessions, layout, llm]
  panels: 7
  routes: ["/api/market-center"]
  data: ["bars", "news"]           # 需要的只读数据集
  disk: "320MB"                    # Python 引擎 + 依赖
```

控制面维护一张**兼容矩阵**：插件版本 × 产品版本 × 平台（云/本机）。升级产品版本前，先算哪些插件会不兼容——这是发布流程的一部分，不是运行时问题。

## 7. 数据模型

```sql
CREATE TABLE plugin_catalog (
  slug          TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  tier          TEXT NOT NULL,           -- base | paid | community
  latest        TEXT NOT NULL,
  manifest      TEXT NOT NULL            -- 兼容声明 JSON（§6）
);

CREATE TABLE plugin_versions (
  slug          TEXT NOT NULL,
  version       TEXT NOT NULL,
  integrity     TEXT NOT NULL,           -- sha512
  engines       TEXT NOT NULL,
  published_at  INTEGER NOT NULL,
  PRIMARY KEY (slug, version)
);

CREATE TABLE plugin_installs (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL,
  slug          TEXT NOT NULL,
  version       TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  installed_by  TEXT NOT NULL,
  installed_at  INTEGER NOT NULL,
  preflight     TEXT,                    -- 预检结果（含失败原因）
  UNIQUE (workspace_id, slug)
);
```

## 8. 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/plugins` | 已安装 + 可用更新 |
| GET | `/api/plugins/catalog` | 市场（按租户过滤） |
| POST | `/api/plugins/:slug/preflight` | 预检（不改状态） |
| POST | `/api/plugins/:slug/install` | 安装（admin） |
| POST | `/api/plugins/:slug/upgrade` | 升级 |
| POST | `/api/plugins/:slug/disable` | 停用 |
| DELETE | `/api/plugins/:slug` | 卸载 |

## 9. 行情插件族的特殊要求

它们不是普通插件，装之前要满足：

| 要求 | 说明 |
|---|---|
| 只读数据面 | bars/news 从共享卷挂载（`workspace.md` §6） |
| Python 运行时 | 报告引擎需要镜像里预置 Python + numpy/pandas |
| 磁盘 | 报告引擎 ~320MB；技能包很小 |
| 工具命名空间 | `mcp__data__*`、`report_engine.*`，与 `connectors.md` 的 `connector__*` 分开 |
| 无实盘 | 纸面交易插件只读/模拟，不接券商（沿用 alpha-desk 合规边界） |

## 10. 分期

### v0
- 镜像预置基础族（ds-bot + 配置层）；**只支持"装/不装"**，不开放市场
- **验收**：容器启动时按 lockfile 装好插件，`/healthz` 通过，面板数对得上

### v1
- 市场页 + 预检 + 安装/升级/回滚 + 兼容矩阵
- **验收**：故意装一个要求更高 DSH 版本的插件 → 被拒并说明原因；安装失败自动回滚

### v2
- 第三方插件与签名；按套餐分发的插件族
- **验收**：无签名插件装不上；停用插件后它的面板与工具立刻消失

## 11. 待决问题

1. **插件能不能按 Bot 授权**（不只是按 workspace）？倾向：v1 按 workspace，v2 再考虑。
2. **插件升级频率**：跟随镜像（月度）还是独立通道（随时）？独立通道风险高，倾向跟随镜像 + 安全补丁例外。
3. **插件里的 Python 服务**怎么管生命周期（report-engine 的 MCP 是子进程）？需要 `runtime-contract.md` 的 sidecar 统一管。
4. **本机开发插件**如何"带上去"（用户自己写的）？倾向：v2 提供 `roostbot plugin pack` 打包 + 私有上传。
