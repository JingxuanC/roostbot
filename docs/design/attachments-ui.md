# 消息附件与产物渲染

> 状态：实现补充（M6-6.2 / D5）。配套：`artifacts.md`（产物模型）、`storage.md`（内容存储）、
> `ui.md`（界面原则）。
>
> 一句话：**附件永远只是消息里的一个受控引用；渲染层拿不到真实路径，也永远不把 HTML/SVG 注入聊天 DOM。**

## 1. 数据流

```
Bot / 工具
  └─ POST /api/internal/artifacts（runtime token，raw body ≤50MB）
       ├─ LocalVolumeStore.put（内容寻址）
       ├─ 图片：剥 JPEG EXIF、读宽高、尽力生成缩略图
       ├─ artifacts 行 + message_attachments（可选 x-message-seq）
       └─ artifact.published 事件

房间消息
  └─ attachments[] = { artifactId, kind, name, size, mime, url }
       └─ url = /api/messages/<seq>/files/<artifactId>

浏览器渲染
  └─ api.getBlob(url)（带 Bearer）
       ├─ 成功：生成 blob URL，按 kind 渲染
       └─ 失败：卡片内错误 + 重试；401 触发重新配对
```

消息级路由的校验顺序（任何一步失败都返回 404，不泄漏存在性）：

1. 消息存在，且是房间里的 `chat.message`；
2. 调用者是该房间所属 workspace 的成员；
3. 该消息确实引用这个 `artifactId`；
4. 产物存在，blob 可读且 sha256 匹配。

## 2. 渲染矩阵

| kind | 判定 | 渲染 | 交互 |
|---|---|---|---|
| `image` | `kind=image` 且 ≤8MB、mime 是图片 | 缩略图懒加载（IntersectionObserver） | 点击灯箱、重试、下载 |
| `pdf` | `kind=pdf` | 卡片：名称/大小/类型 | 下载、在新标签打开（blob URL） |
| `html` / `page` | `kind=html/page`，或 mime 是 HTML/XHTML/SVG | 卡片 + “网页在沙箱中打开，不注入聊天” | 打开沙箱弹层（iframe）、下载 |
| `table` | `kind=table` | 卡片 + “预览前 20 行”按钮 | 点击读取并解析；下载 |
| `code` | `kind=code` | 代码块（plain `<pre><code>`） | 超过 20 行折叠、复制、下载 |
| 未知 | 其它 kind | 下载卡片 | 下载 |
| 大图 | `kind=image` 但 >8MB | 不内联，退回下载卡片 | 下载 |

补充规则：

- **SVG 按 HTML 处理**：可能含 `<script>`，只进沙箱 iframe，绝不 `img` 内联。
- **表格只预览纯文本分隔符格式**：CSV 用逗号，TSV/TXT 用制表符；XLSX 等二进制直接下载。
- **代码只读文本类**：`text/*`、JSON/XML/JS/SQL/YAML、常见源码扩展名；二进制退回下载。
- **文件名与内容只走 `textContent`**，不拼 HTML 字符串。

## 3. 交互细节

| 场景 | 行为 |
|---|---|
| 图片加载 | 先显示“图片加载中…”，进入视口才请求；失败显示原因 + 重试 + 下载 |
| 图片查看 | 弹层灯箱，点击遮罩/Esc/关闭按钮退出；切房间时统一释放 blob URL |
| PDF | 不在聊天内嵌 PDF；下载或新标签打开。v0 **没有首页缩略图** |
| HTML/页面 | 卡片不内嵌；点击后才创建 `sandbox="allow-scripts"` 的 iframe，`referrerpolicy="no-referrer"` |
| 表格预览 | 点击后最多读 20MB；解析失败/空文件给明确提示；显示“共 N 行，预览前 M 行” |
| 代码 | 自动加载并按 20 行折叠；“展开全部/收起”；复制走 `navigator.clipboard`，失败提示 |
| 下载 | 先带 Bearer 取 blob，再 `?raw=1` 触发下载；文件名做路径字符清理、超长截断 |
| 鉴权失败 | 不整屏报错；卡片内提示并触发重新配对 |
| 切房间/重建列表 | `resetAttachmentUrls()` 递增 generation、释放所有 blob URL、关闭弹层；过期异步结果丢弃 |

弹层可键盘关闭（Esc），打开时焦点在关闭按钮上；没有做完整的焦点陷阱（后续可补）。

## 4. 安全边界

| 风险 | 措施 |
|---|---|
| 猜 URL 拿文件 | 只有消息级路由，必须同时满足消息存在、成员、消息引用；失败统一 404 |
| 真实路径泄漏 | 浏览器永远拿不到文件系统路径；内容 id 是 sha256 前 32 hex |
| HTML/SVG 执行 | 永不注入聊天 DOM；只进 `sandbox="allow-scripts"`（**不带** `allow-same-origin`）的 iframe |
| 直接打开 HTML/SVG | 响应带 `Content-Security-Policy: sandbox; default-src none` + `nosniff` |
| 第三方 cookie | 上游/附件响应不把不受控 cookie 种到主源；iframe 不带 same-origin |
| 引用泄漏 | 外链 `target=_blank` 加 `rel="noopener noreferrer"` |
| 内存泄漏 | blob URL 统一登记，切房间/关弹层释放；下载/打开后定时释放 |
| 大文件 DoS | 产物 ≤50MB、用户上传（头像/附件）≤10MB、消息 ≤10 个附件；图片内联 ≤8MB；表格预览 ≤20MB |
| 元数据泄漏 | JPEG 上传/产物登记时剥 EXIF；PNG/GIF/WebP 元数据未处理 |
| 缓存 | 受控内容 `Cache-Control: private, no-store`；签名 URL 5 分钟过期 |

### 与 DSH 面板 iframe 的区别

| | 消息 HTML/SVG | DSH 插件面板 |
|---|---|---|
| 目的 | 展示不可信产物 | 运行第三方插件界面 |
| iframe | `sandbox="allow-scripts"`，**opaque origin** | 独立反代 origin + `allow-scripts allow-same-origin` |
| 原因 | 产物不需要同源，越隔离越好 | DSH Web 子资源需要 cookie/同源 |
| 注入聊天 | 否 | 否（在独立 tab/容器） |

不要因为面板需要 `allow-same-origin`，就给消息附件也加；两者的信任级别不同。

## 5. 限制与未实现

| 项 | 现状 |
|---|---|
| PDF 首页缩略图 | 未实现，卡片不显示预览图 |
| 语法高亮 | 未实现，代码是 plain `<pre><code>` |
| XLSX 内联预览 | 未实现，直接下载 |
| `page` 版本切换（`rev`/`history`） | 未实现 |
| 图片压缩/按需缩略图 | 缩略图只在登记时尽力生成（`sips`/`convert`）；PDF 不做 |
| 非 JPEG 元数据 | PNG/GIF/WebP 未剥离 |
| 单条消息撤回/删除 | 无 API；附件引用不会自动减一 |
| 外部分享链接 | 不做；签名 URL 只给已授权页面，5 分钟 |
| 完整可访问性 | 弹层 Esc/焦点已有；列表虚拟化、焦点陷阱未做 |

## 6. 验收要点

1. 同一张图被两条消息引用只存一份（内容寻址），两条消息都能打开。
2. 无权限账号/设备打开消息文件 URL 得到 404，而不是内容或“存在性”提示。
3. HTML/SVG 产物只能在沙箱 iframe 打开；聊天 DOM 里没有注入。
4. CSV 预览前 20 行；XLSX 走下载；超过 20 行的代码默认折叠。
5. 切房间后旧图片/弹层不残留，blob URL 被释放。
6. 大图 >8MB 不内联；产物 >50MB 在登记阶段就被拒绝。
