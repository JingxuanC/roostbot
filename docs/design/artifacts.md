# 产物：Bot 做出来的图片、PDF、报告怎么到用户手里

> 状态：方案（2026-11-03）。配套：`storage.md`（内容存储）、`messaging.md`（消息）、`ui.md`（渲染）、`events.md`（事实源）。

## 1. 一句话

**产物不是"文件系统里的一个路径"，而是一个内容寻址的不可变对象 + 一条消息里的引用。** 渲染层永远拿不到真实路径，只能拿到受控 URL。

这是 OpenMausBot 与 DSH 的共同做法：消息里的 `attachments[]` 只放**白名单 URL**，文件通过**消息级路由**打开，且校验"这条消息确实有权分享这个文件"。

## 2. 六种产物

| 种类 | 例子 | 默认渲染 |
|---|---|---|
| `image` | 截图、K 线图、头像 | 内联缩略图，点击放大 |
| `pdf` | 报告 PDF | 卡片 + 首页预览 + 下载 |
| `html` | 研究报告、仪表盘 | 卡片 + "在新标签打开"（沙箱 iframe） |
| `table` | CSV / XLSX | 卡片 + 前 20 行预览 + 下载 |
| `code` | 脚本、diff | 代码块（高亮 + 复制），长文件折叠 |
| `page` | Bot 生成的交互页（不是下载物） | 侧栏或主区的沙箱页面 |

## 3. 生命周期

```
① 产生   工具写文件到 /workspace/artifacts/<name>
② 登记   runtime 读文件 → 算 sha256 → ContentStore.put（内容寻址）
           → 生成缩略图（图片/PDF 首页）→ 写 artifact.published 事件
③ 引用   回合结束时，消息里带 attachments[]（受控 URL + kind + name + size）
④ 服务   浏览器请求 /api/messages/:mid/files/:aid
           → 校验：消息存在 + 该消息确实引用这个 aid + audience 可见
           → 流式返回（支持 Range）、private no-store
⑤ 渲染   前端按 kind 走渲染矩阵（§6）
⑥ 保留   引用计数 + 保留期；GC 见 storage.md
```

**关键**：②③ 之间是**内容寻址**，同一张图被两个回合引用只存一份；④ 的授权是**消息级**的，不是路径级。

## 4. 登记时的整理

| 项 | 规则 |
|---|---|
| 大文件 | 单文件 ≤ 50MB（`storage.md`），超了工具层就拒绝，不是渲染层报错 |
| 图片 | 生成缩略图（长边 640）；**剥 EXIF**（GPS/设备信息） |
| PDF | 生成首页 PNG 作为预览；不在浏览器里直接信任 PDF |
| HTML | **不许**直接同源打开：必须沙箱 iframe（`sandbox="allow-scripts"`、独立 origin、CSP） |
| CSV/XLSX | 解析前 20 行做预览；解析失败退回"下载"卡片 |
| SVG | 视为脚本（可含 `<script>`），按 HTML 处理：沙箱渲染或转 PNG |
| 文件名 | 只用于展示，落盘用内容 id；用户看到的名称做去重（`report (1).pdf`） |

## 5. 服务与授权

```
GET /api/messages/:mid/files/:aid            → 受控内容
GET /api/messages/:mid/files/:aid?raw=1      → 强制下载（Content-Disposition）
```

校验顺序（任何一步失败都 403/404，不泄漏存在性）：

1. 消息存在，且属于调用者可见的 workspace/房间
2. 该消息的 `attachments[]` 里确有 `aid`
3. 该消息的 `audience` 允许调用者（team / room / member）
4. 文件在 store 里且 sha256 匹配

**不做**：不做"任意 id 猜 URL"就给的下载（`/files/:aid` 裸路由）——那等于把存储变成公开桶。

## 6. 前端渲染矩阵

| kind | 渲染 | 交互 |
|---|---|---|
| `image` | 缩略图（长边 320），点击灯箱 | 保存、复制、在新标签打开 |
| `pdf` | 卡片：文件名 + 大小 + 首页缩略图 | 下载、在新标签打开（沙箱） |
| `html` | 卡片：标题 + 一行摘要 + "打开" | **新标签**（sandbox iframe，独立源），不内嵌到聊天流 |
| `table` | 卡片：前 20 行表格 + 行数 | 下载、展开查看 |
| `code` | 代码块（语法高亮延迟加载） | 复制、折叠超过 20 行 |
| `page` | 右侧面板/主区 iframe | 版本切换（`rev` / `history`） |

**渲染安全**：

- Markdown 一律经 sanitizer（禁 `script`、`on*`、`javascript:`、`data:` 除图片白名单）
- HTML 产物**永不**注入聊天 DOM；只在 iframe 里
- 图片走 `blob`/受控 URL，不用 `file://`
- 外链加 `rel="noopener noreferrer"`，不自动打开

## 7. 对话渲染的其它考虑（不止产物）

| 消息类型 | 渲染要点 |
|---|---|
| 流式文本 | 增量渲染要**幂等**：同一段重放不能重复；Markdown 未闭合时不乱跳（按块提交） |
| 工具调用 | 折叠成一行：`工具名 · 耗时 · 状态`；展开看入参/结果（结果超长只显示头部 + 路径） |
| 工具错误 | 红字一行 + 展开原因，不整屏报错 |
| 审批卡 | 按钮固定宽度、危险动作红色、批准后留"已允许（一次）"历史行 |
| 提问卡 | 选项按钮 + "自己输入"；回答后卡片变灰留痕 |
| 系统提示 | 居中细字（如"宿主重启，从断点继续"） |
| 长对话 | 虚拟列表；跳到某条消息不重建整页 |
| 图片加载失败 | 占位 + 重试 + "只在本地"提示（本地节点离线时） |

**不做的**：

- 不做"假进度条"（流式就是流式，不确定就显示"仍在运行"）
- 不在聊天里内嵌 HTML 产物（安全 + 性能）
- 不自动滚动到新消息（除非用户已在底部）
- 不把大表格铺满屏幕（先折叠）

## 8. 数据模型

```sql
CREATE TABLE artifacts (
  id            TEXT PRIMARY KEY,        -- 内容寻址（sha256 前缀）
  workspace_id  TEXT NOT NULL,
  kind          TEXT NOT NULL,           -- image|pdf|html|table|code|page
  mime          TEXT NOT NULL,
  name          TEXT NOT NULL,           -- 展示名
  size          INTEGER NOT NULL,
  width         INTEGER,
  height        INTEGER,
  thumb_id      TEXT,                    -- 缩略图对象 id
  produced_by   TEXT NOT NULL,           -- bot id
  run_id        TEXT,
  created_at    INTEGER NOT NULL
);

CREATE TABLE message_attachments (
  message_id    TEXT NOT NULL,
  artifact_id   TEXT NOT NULL,
  position      INTEGER NOT NULL,
  PRIMARY KEY (message_id, artifact_id)
);
```

事件（对齐 `events.md`）：

```jsonc
// artifact.published
{ "artifact": "art_…", "kind": "pdf", "name": "盘后复盘.pdf", "size": 812345, "thumb": "art_…" }
// chat.message 的 attachments[]
{ "artifactId": "art_…", "kind": "pdf", "name": "盘后复盘.pdf", "size": 812345 }
```

## 9. 保留

| 项 | 策略 |
|---|---|
| 未引用对象 | 7 天后 GC（`storage.md`） |
| 已引用 | 随消息保留；消息删除 → 引用减一 |
| 页面产物 | 保留最近 N 个版本（默认 10），旧版本可回看不可编辑 |
| 导出 | 整个 workspace 可导出（消息 + 产物 + 事件），ZIP |

## 10. 分期

### v0
- 只支持 `image` 与 `pdf`；消息级路由 + 缩略图
- **验收**：Bot 生成一张图，聊天里显示缩略图，点击能看原图；换个账号/无权限设备打不开同一 URL

### v1
- `html`（沙箱 iframe）、`table`、`code`；缩略图与 EXIF 处理；下载
- **验收**：HTML 报告只能在新标签打开；CSV 预览前 20 行；长代码折叠

### v2
- `page`（可交互产物，版本切换）、导出 ZIP、按租户保留策略
- **验收**：页面产物 rev 切换；导出包含事件与全部产物

## 11. 待决问题

1. **PDF 预览**：服务端生成首页图（稳、多一次 CPU）还是客户端 pdf.js（省服务端、体积大）？倾向：服务端首页图 + 客户端点击再加载。
2. **`page` 的隔离**：独立 origin（推荐）还是一个子域？独立 origin 需要额外的证书与域名规划。
3. **产物能否直接给外部人看**（分享链接）？倾向：v2 之前不做，避免把内部报告变成公开 URL。
4. **长图/长表格的渲染上限**：超过多少像素/行就只给下载？倾向：图片长边 > 8000px、表格 > 500 行只给下载。

## 12. 实现状态（2026-11-04，v0 切片）

- **登记**：`POST /api/internal/artifacts`（runtime token + raw body，≤50MB）→ `LocalVolumeStore.put` → 图片剥 EXIF / 读宽高 / 尽力缩略 → 写 `artifacts` 行 → 有 `x-message-seq` 时写 `message_attachments` → 写 `artifact.published` 事件。
- **消息级路由**：`GET /api/messages/:seq/files/:artifactId`，校验「消息存在且是 chat.message + 调用者是房间所在 workspace 成员 + 消息确实引用该产物」，失败一律 404；支持 Range（206 / Content-Range）与 `?raw=1` 下载；响应 `Cache-Control: private, no-store` + `X-Content-Type-Options: nosniff`。
- **签名读取**：`GET /api/attachments/:id?token=`，HMAC + 过期校验，支持 Range。
- **缩略图降级**：有 `sips`（macOS）或 `convert` 时生成 ≤640 长边 JPEG；都缺失或执行失败时 `thumbId = null`，不报错。**PDF 首页缩略图 v0 未实现**（需要 PDF 渲染器，留待后续，当前返回 `null`）。
- **与文档的偏差**：`message_attachments` 用 `message_seq`（events.seq）而不是 `message_id`；问题 3「产物能否直接给外部人看」仍按 v2 之前不做处理，签名 URL 只签发 5 分钟。
