# apps/web — 网页端（M4）

零依赖、零构建：`index.html` + `app.js` + `styles.css`，原生 ES module，没有 npm 包、没有打包器、没有 TypeScript 源码。

M4 在原来的配对页 / 房间页之上加了 Bot 与建群/房间设置，并把数据接到控制面的 M4 API。
纯逻辑（路由、谁回答、@ 解析、API 客户端）抽在 `lib/` 里，用 `node:test` 覆盖；视图在 `views/`。

## 路由（hash）

| 路由 | 视图 |
|---|---|
| `#/` | 配对（默认） |
| `#/bots` | Bot 列表 + 新建入口 |
| `#/bots/new` | 新建 Bot |
| `#/bots/:id` | Bot 设置（身份 / 人设 / 技能 / 工具 / 审批 / 记忆 / 模型 / 状态 / 删除） |
| `#/approvals` | 需要你：待审批的 Bot 建群请求（批准 / 拒绝） |
| `#/plugins` | 插件：市场 / 已安装（页内切换） |
| `#/plugins/:slug` | 插件详情：权限、README、预检、安装 |
| `#/rooms/new` | 建群（名称可空、公告、成员多选、host、谁回答三选一） |
| `#/rooms/:id` | 房间 |
| `#/rooms/:id/settings` | 房间设置（名称 / 公告 / 成员增删 / 谁回答 / 删除） |
| `#room` | 旧的房间预览地址，仍然可用（固定样例，不请求） |

未知地址渲染「找不到这个页面」，不会白屏。刷新任何 hash 地址都能重新渲染；受保护页面在
会话失效时回到配对页，配对成功后回到原地址。

## 怎么起

```bash
# 推荐：控制面同源伺服本目录（一个进程就是完整应用）
node --experimental-strip-types apps/api/src/main.ts
# → http://127.0.0.1:8787

# 或任意静态服务器（只能看配对页与 #room 预览；API 要另配 ?api=）
npx serve apps/web
python3 -m http.server 8000 --directory apps/web
```

**不要直接双击 `index.html`**：`file://` 下浏览器会按 CORS 拦掉 ES module。页面里有一小段普通脚本会在 1.2 秒后提示。

API 地址：默认同源；`?api=http://127.0.0.1:8787` 可指定（受 CORS 限制，见「已知缺口」）。

## 哪些是真的、哪些是假的

| 部分 | 状态 |
|---|---|
| 配对码（6 位、粘贴分段、错误就地显示） | **真**：`POST /api/pairing/claim` |
| Bot 列表 / 新建 / 设置 / 暂停 / 删除 | **真**：`GET/POST/PATCH/DELETE /api/bots` |
| 建群 / 房间设置 / 成员增删 / 谁回答 | **真**：`POST/PATCH /api/rooms`、`/members` |
| 房间消息 / 发送 / SSE | **真**：`GET/POST /api/rooms/:id/messages`、`/stream` |
| 「谁会回答」提示 | **真**：从 `room.responder` 推导（`lib/rooms.js`） |
| `@` 成员菜单 | **真**：方向键 + 回车插入；中文名前缀消歧（`lib/mentions.js`） |
| 轮次状态（谁在说 / 排队 / 失败 / 静默） | **真**（有数据才渲染）：`room.round.slots` + SSE `round`/`status`/`speaking`；接口暂未接轮次时整块隐藏 |
| 房间来源 | **真**：`room.createdByKind === 'bot'` 时在房间列表/房间头显示「由 Bot 创建」，title 带 `createdBy` |
| Bot 头像上传 | **真**：读成 dataURL、预览/移除，随 `PATCH /api/bots/:id` 发 `avatar.image`；前端卡 256KB，服务端 `avatar.image` 上限 512k 字符、JSON body 上限 1MiB |
| 需要你 / 审批 | **真**：`#/approvals` 读 `GET /api/approvals`，批准/拒绝走 `POST /api/approvals/:id`；接口 404/405/501/503 时显示「审批接口未就绪」 |
| 插件市场 / 已安装 | **真（目录层）**：`#/plugins` 读 `GET /api/marketplace/plugins`，详情/预检/安装与启停/升级/卸载走对应 API；接口 404/405/501/503 时显示「插件接口未就绪」。**本批没有沙箱 sync**：安装/升级后 state 停在 `installing`，界面只写「等待沙箱同步」，不写「已安装成功」 |
| 房间删除 | 按钮会真的发 `DELETE /api/rooms/:id`；契约与当前控制面都没有这个接口，所以会如实显示 404 错误 |
| 「需要你」抽屉（房间页） | **样例**。预览房间时显示；连上控制面后隐藏；真实审批在 `#/approvals` |
| 预览房间（`#room`）的消息、工具调用、审批卡 | **固定样例**，发送只追加本地气泡 |
| Bot 软删恢复 | **未上线**：`DELETE /api/bots/:id` 目前是硬删，没有恢复接口；列表里的「已删除」和设置页的「恢复」都是禁用态 + 说明 |

## 会话 token 与刷新

token 仍然**只在内存变量里**（`app.js` 的 `sessionToken`）：不写 `localStorage` / `sessionStorage`、
不进 URL、不渲染（对齐 `docs/design/auth.md` §7；正式做法应是 HttpOnly cookie）。

所以刷新页面会丢 token：受保护页面收到 401 时，前端把当前 hash 记到 `pendingRoute`，回到配对页并
显示说明；重新配对成功后自动回到刚才的地址。这是有意的诚实行为，不是白屏 bug。

## 文件

```
index.html          三个视图的静态骨架（配对 / 房间 / 路由页外壳）
app.js              入口：状态、路由、房间页、SSE、输入区、@ 菜单
styles.css          设计 token + 组件样式（深色一套）
lib/glyph.js        程序化图标（packages/identity/src/glyph.ts 的等价重写，无 DOM）
lib/dom.js          el / avatar / botAvatar / $（所有用户输入只进 textContent / value）
lib/avatar.js       readAvatarFile / isAvatarDataUrl / avatarLabel（类型 + 256KB 校验）
lib/approvals.js    approvalSummary / approvalActions / canDecide / 时间与状态文案
lib/api-client.js   createApiClient / ApiError；错误读 {ok:false,error:{code,message}}
lib/routing.js      routeMatch(hash)
lib/rooms.js        whoAnswersLabel(room)、roomOriginLabel、slot 状态、轮次条目
lib/mentions.js     parseMentionQuery / insertMention / memberNameConflict
lib/plugins.js      tier 文案、权限摘要、install state、更新可用、安全资源 URL
lib/ui.js           表单与加载/空/错误态组件
views/bots.js       Bot 列表、新建、设置（含头像上传）
views/rooms.js      建群、房间设置
views/approvals.js  需要你：待审批列表 + 批准/拒绝
views/plugins.js    插件页：市场 tab（搜索/分类/级别）+ 已安装 tab 切换
views/plugin-detail.js  插件详情：权限、README、预检、二次确认安装
views/plugin-installed.js 已安装列表：启停/升级/卸载
views/plugin-kit.js 插件图标/截图/权限清单与降级态
test/*.test.ts      node:test（DOM 无关）
```

`app.js` 仍然只被 `index.html` 以一个 `<script type="module">` 引入；其余都是它 import 的模块。

## 纯逻辑与测试

```bash
export PATH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin:$PATH"
node --experimental-strip-types --test apps/web/test/*.test.ts
node --check apps/web/app.js
```

覆盖点：

- `routeMatch`：配对 / 房间 / 建群 / 设置 / Bot / 审批 / 旧 `#room` / 解码 / 未知路径。
- `whoAnswersLabel`：`member:<bot>`、`everyone`、`mentions`、`auto`、没有成员、旧 `replyMode`。
- `roomOriginLabel` / `roomOriginTitle`：只有 `createdByKind === 'bot'` 有徽章，title 带 `createdBy`。
- `parseMentionQuery`：`@` 候选、前缀匹配、`@数据官` 不匹配 `@数据官2`、邮箱不触发、大小写。
- `memberNameConflict`：完全同名（去空白/忽略大小写）才算冲突，前缀不算。
- `readAvatarFile` / `isAvatarDataUrl`：类型白名单、256KB 边界、假 File/真 File、坏值不改 state。
- `approvalSummary` / `approvalActions` / `canDecide`：建群摘要、成员去重、终态不可操作、decision 值与 API 对齐。
- `pluginTierBadgeText` / `pluginPermissionItems` / `pluginInstallStateLabel` / `pluginUpdateAvailable`：
  插件 tier、权限摘要、install state 与更新判断；`safeAssetUrl` 只放行 http(s) 与同源路径。
- `createApiClient`：Bearer、JSON 正文、`{ok:false,error}` 中文 message、HTTP 500、网络失败、204。

## 与契约/设计的偏差（有意的）

1. **`notice` vs `bulletin`**：M4 契约的 API 字段是 `notice`，设计文档 `rooms.md` 用 `bulletin`。
   前端按契约发 `notice`，读的时候 `notice || bulletin` 兼容。
2. **房间删除**：任务要求设置页有删除，但 `m4-contract.md` §2 与 `rooms.md` §8 都没有
   `DELETE /api/rooms/:id`。按钮真的发请求，失败就把服务端 message 显示在原地，不假装成功。
3. **换 host**：契约的 `PATCH /api/rooms/:id` 没有 `hostBotId`，所以设置页只显示 host 徽章，不提供换 host。
   移除 host 是允许的（服务端会自动把另一个成员设为 host）。
4. **「需要你」抽屉仍是样例**：真实审批在 `#/approvals`；房间页的抽屉保留固定样例给预览用，
   实时房间里隐藏，不假装有待办。
5. **轮次状态**：控制面当前 `GET /api/rooms/:id` 的 `round` 还是 `null`，所以真实房间里这块通常不出现；
   一旦接口返回 `slots`（或 SSE 推 `round`/`status`/`speaking`），就会渲染，无需改前端。
6. **配对后没有房间**：不再自动建一个空房间（M4 要求 ≥2 个成员），而是去 `#/bots` 并说明「先建两个 Bot，再建群」。
7. **`auto` responder**：契约里有 `auto`，v1 界面只给 member / everyone / mentions 三选一；
   遇到已有的 `auto` 房间会显示提示，保存时必须显式选三种之一。
8. **`?api=` 跨源**：控制面仍不回 CORS 头，跨源预检会失败；页面会如实报「连不上 API」。
   同源伺服（默认）是当前唯一顺畅的用法。
9. **头像走 dataURL 而不是 multipart**：前端把 ≤256KB 图片读成 dataURL 存进 `avatar.image`；
   服务端为 `image` 放宽到 512k 字符、JSON body 提到 1MiB（`bots.md` 的 `/icon` multipart 接口未做）。
10. **软删恢复未上线**：`DELETE /api/bots/:id` 当前是硬删，没有「列出已删除 / 恢复」接口；
    Bot 列表的「已删除」筛选和设置页的「恢复」都是禁用态 + 文案，不假装能恢复。

## 无障碍与移动端

- 路由页有 `main` 地标；按钮/链接都是原生元素，键盘可达；焦点环沿用全局 `:focus-visible`。
- @ 菜单是 `role="listbox"` + `option`，输入框带 `aria-expanded` / `aria-activedescendant`；
  方向键循环、回车插入、Esc 关闭、Tab 离开；IME 组合输入时不吃回车。
- 房间页成员/轮次状态是 `role="status"`，只在有数据时出现。
- 窄屏（≤860px）沿用原媒体查询：左栏收起、房间头露出「审批」与「Bot」入口；路由页单列。
- 只做深色：`<meta name="color-scheme" content="dark">`。

## 仍然没有的

- 审批里的提问（question）交互与房间内联审批；真实审批目前只覆盖 Bot 建群。
- 轮次引擎完整接入后的历史轮次、停止当前成员、重发去重提示。
- Bot 头像生成 / 裁剪；上传已做（大小与类型在 `lib/avatar.js` 校验）；定时 routine；用量/连接器页。
- 插件沙箱 sync / 重启 / 冒烟 / 回滚（M5-5.1 第二批）；本批只写安装记录，state 停在 `installing`。
- Bot 软删恢复（需要迁移与服务端接口）；当前删除是硬删。
- 客户端状态持久化（刷新只保留 hash，不保留 token 与草稿）。
- 移动端底部 Tab（当前用页面顶部导航 + 房间头入口）。
