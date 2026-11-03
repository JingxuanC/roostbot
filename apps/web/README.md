# apps/web — 网页端第一版 UI 切片

> **这是第一版 UI 切片，不是最终设计。** 视觉按 `docs/design/ui.md` §6 的 token 实现，
> 但信息架构、状态、投递方式等只覆盖了配对与房间两页；消息、审批、发送全部是固定样例。
> 它是用来"看和摸"的，不是能用的产品。

零依赖、无需构建：三个文件（`index.html` / `app.js` / `styles.css`），普通 ES module，没有 npm 包、没有打包器、没有 TypeScript。

## 怎么起

```bash
# 任选一个静态服务器，根目录指向 apps/web
npx serve apps/web                       # → http://localhost:3000
python3 -m http.server 8000 --directory apps/web   # → http://localhost:8000
```

打开 `http://localhost:8000/` 是配对页；`http://localhost:8000/#room` 直接进房间（假数据）。
页面上的「预览房间（假数据，不配对）」按钮等价于后者。

API 地址：

- 默认**同源**（`fetch('/api/pairing/claim')`），适合由控制面自己伺服这个目录；
- 或加查询参数：`http://localhost:8000/?api=http://127.0.0.1:8787`。

**不要直接双击 `index.html`**：`file://` 下浏览器会按 CORS 拦掉 ES module（`app.js` 不执行）。
页面里有一小段普通脚本会在 1.2 秒后提示这件事。必须用静态服务器。

## 哪些是真的、哪些是假的

| 部分 | 状态 |
|---|---|
| 配对码输入（6 位、自动聚焦、粘贴自动分段、错误就地显示） | **真**：会 `POST /api/pairing/claim`，服务端的 `message` 原样显示 |
| 会话 token | **只在内存变量里**，不写 `localStorage` / `sessionStorage`、不进 URL、不渲染；刷新即丢（`auth.md` §7：正式做法是 HttpOnly cookie） |
| 房间名、消息、工具调用、审批卡 | **假数据**，写死在 `app.js` 的 `ROOM` 里 |
| 发送消息 | **只追加本地用户气泡，不发请求** |
| 审批按钮 | **不发请求**，点一下只会说明"审批接口尚未实现" |
| 投递方式 / 回复给（`ui.md` §3.2 要求可见） | **没做**：发送本身不发请求，放两个假下拉会更不诚实，见「已知缺口」 |

消息样例的形状贴着 `docs/design/events.md` §3 的信封（`domain` / `kind` / `actor` / `audience` / `payload`），
私聊额外带 `peer`（名字、动作、完成条件），对应 `packages/messaging/src/provenance.ts` 的 `PeerLabel`。
折叠规则也照抄了 `collapsedByDefault()`：房间与通知不折叠，其余默认折叠。

## Bot 图标

`app.js` 里有一份 `packages/identity/src/glyph.ts` 的**等价重写**（fnv1a → 6 族 × 8 调色板 × 4 旋转 × 4 装饰点，输出 SVG）。
不 import `.ts`，因为浏览器跑不了 TypeScript，而这个目录不允许有构建步骤。
为 `chief` / `data-officer` / `selector` / `risk-officer` 四个 id 渲染，深色配色。
**两份实现必须同步**：改 `packages/identity/src/glyph.ts` 的算法时，这里要跟着改，否则同一个 Bot 在两处长得不一样。

## 无障碍

- 配对码用 `<fieldset>` + `<legend>`（`配对码`），每个格子另有 `aria-label="第 N 位"`；第一个带 `autocomplete="one-time-code"`。
- 所有按钮都是原生 `<button>`，可 Tab 到达、可 Enter/Space 触发；可见焦点环（`2px` 主色 + 偏移）。
- 折叠行（Bot 私聊、工具调用）是 `<button aria-expanded aria-controls>`，展开后正文才进入可访问树；展开用 `hidden`，不是只靠 CSS。
- 「需要你」抽屉：`aria-expanded` + `aria-controls`，Esc 关闭，焦点移入面板、关闭后回原位。
- 消息区 `role="log"`，初始渲染后才设 `aria-live="polite"`，避免读屏一次念完整个房间。
- 只做深色：`<meta name="color-scheme" content="dark">`，没有浅色主题（浅色 token 在 `packages/tokens` 里已有，但这一版没实现）。
- 图片/图标：图标是装饰性的（旁边有名字），因此 `role="presentation" aria-hidden="true"`，不重复念名字。

## 与 packages/tokens 的关系

`styles.css` 顶部的颜色、间距、圆角、字号是**手工复制**自 `packages/tokens/src/index.ts`（深色一套）。
零构建意味着不能 import 那个 `.ts`；两处必须保持一致，改 token 时同步改 CSS 变量。
`cssVars()` 的输出采用 `--roost-*` 命名，这里沿用同一套名字，方便以后接上。

## 已知缺口（对照设计文档）

1. **`ui.md` §3.2 的「投递方式 / 回复给」两个下拉没做**：发送是本地模拟，做出来就是假控件。
2. **`ui.md` §3.10 的展开状态按设备记**：没做持久化（本切片不写任何本地存储）。
3. **`ui.md` §5 的状态**：流式光标、停止、离线细条、预算横幅、沙箱拒绝都还没有（没有后端事件流）。
4. **`ui.md` §4 多端**：窄屏只是把左栏藏起来，「需要你」挪到房间头；没有底部 Tab、没有深链 `/w/<id>/room/<id>`。
5. **`bot-identity.md` §7 状态环 / §8 群聊拼合**：没做，只在头部用一个小圆点表示"正在工作"。
6. **房间的「折叠 Bot 之间的对话」开关（`messaging.md` §14.2）**：没做，私聊按默认折叠渲染。
7. **配对成功的响应体没有写进文档**：`apps/api` 现在返回 `{ deviceId, sessionToken, expiresAt }`，
   而 `auth.md` §10 只给了路径。这里对 `200` 与空 body 都放行，读 `sessionToken` 存内存（不落盘）。
   建议把响应体补进 `auth.md`——顺带定一下 `auth.md` §7「token 放 HttpOnly cookie」与现状（JSON 里返回 token）哪个算数。
8. **服务端错误文案是英文**：`apps/api` 返回 `{ ok: false, error: { code, message } }`，`message` 是英文
   （`pairing code is not valid` 之类）。按本页规则"失败显示服务端 message"，界面会原样显示英文；
   而 `auth.md` §8 规定的是中文话术（「配对码已过期，请重新生成」）。要么服务端出中文，要么前端按 `error.code` 映射。
9. **跨源 `?api=` 现在会被浏览器拦掉**：`apps/api` 没有 CORS 头，且 `Content-Type: application/json` 会触发预检，
   预检直接 404。所以 `?api=http://127.0.0.1:8787` 只在给控制面加了 CORS（含 `Access-Control-Allow-Headers: content-type`）
   或由控制面同源伺服本目录时才可用；页面会如实报"连不上 API"。本切片已用真实 `apps/api` 验证过同源流程。
10. **设计稿里没有的两个诚实标注**：房间顶部那条"假数据预览"提示条，和配对页的"预览房间（假数据，不配对）"按钮。
    它们是为这一版切片加的，接上真 room API 后应删除。
11. **「需要你」在 `ui.md` §3.3 是一整页**，这里先做成右侧抽屉（不打断房间阅读）；位置与形态待设计确认。

## 后续（沿用本目录原来的 v0 范围）

1. 配对页（已做）、房间（已做壳）
2. Bot 详情、时间线、用量、设置
3. 真实事件流（SSE）+ 本地 store；届时再决定技术栈（Vite + React 仍是候选，但当前切片证明不需要构建也能先跑）
