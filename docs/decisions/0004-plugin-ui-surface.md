# 0004 — 插件面板用 iframe 嵌 DSH Web，产品界面仍是我们的

- 状态：已定
- 日期：2026-11-04

## 背景

DSH 插件分两半：host 半（工具/服务/技能）没有界面也能用；client 半是注册进 **DSH Web slot**
的 React 组件（主区、侧栏面板、浮层）。我们的网页是房间/Bot 产品，没有 DSH 的 slot 系统，
所以第三方插件的面板无处渲染。

## 决定

**每个用户沙箱里多跑一个 `dsh web`，只作为"插件面板容器"；控制面鉴权反代；我们的界面用
iframe 打开面板。产品主界面（房间、Bot、设置、市场）永远是我们自己的 UI。**

```
用户沙箱（已有，每用户一个）
  ├─ room-agent → dsh --profile sdk     房间对话（现有链路）
  └─ dsh web  127.0.0.1:4099            仅插件面板
        ↑ 反代 /w/<workspace>/dsh/*（设备会话鉴权、base path 剥离）
        ↓
我们的页面：房间照旧；插件面板 tab 内嵌 iframe
```

## 备选与理由

| 方案 | 结论 | 理由 |
|---|---|---|
| 自绘面板 | ❌ 否 | 只能覆盖我们自己的少数插件；第三方插件永远用不了；每个插件一个前端项目 |
| 整站切 DSH Web | ❌ 否 | 等于放弃我们的产品（房间/Bot/审批/市场都不是 DSH 界面） |
| **iframe 嵌 DSH Web（只作面板容器）** | ✅ 采用 | 第三方面板原样可用；主界面不变；我们有 sidecar base-path 经验 |
| 整页打开 DSH Web | 保留为高级选项 | 给重度用户/调试，不是默认路径 |

## 约束

1. **DSH Web 只绑 127.0.0.1**，外部只能经控制面反代（带设备会话校验）
2. iframe 用独立源 + `sandbox="allow-scripts allow-same-origin"`，不与我们同源。
   独立源的做法是：控制面在**同 host、不同端口**再起一个只服务 `/w/<workspace>/dsh/*`
   的监听（`ServerOptions.dshProxyPort`），iframe 指向该端口。cookie 不区分端口，主端口
   签发的会话 cookie 对反代端口同样有效；iframe 保留的是反代端口自己的 origin，与主控制面
   （另一个端口）仍是跨源，插件代码碰不到主控制面的 DOM/storage。纯 `allow-scripts`
   不带 `allow-same-origin` 是 opaque origin，子资源（`<script src>`/fetch）带不上 cookie
   且被 CORS 阻断，真实 DSH Web 无法工作，因此不再采用。
3. 面板空闲时随沙箱 stop/start；打开面板才唤醒（不常驻占用）
4. 插件的 host 半不依赖 DSH Web：面板缺失时工具/技能照常工作
5. 每个用户两个 DSH 进程（sdk / web），内存预算按 ~400MB 估，沙箱规格要留余量

## 后果

- `plugin-marketplace.md` §3 的 C 级有了确定方案，市场卡片可以标"面板需打开容器"
- 要建四块：沙箱内 dsh web 进程、鉴权反代、iframe 容器、生命周期（唤醒/休眠）
- 面板来源需要披露：来自插件 manifest 的 `panels` 声明 + DSH Web 实际注册数冒烟
- 后续若面板性能/内存不可接受，可降级为"只给 host 半 + 自绘少数高频面板"

## 待办

- [x] 反代路由与 base path 细节（`/w/<workspace>/dsh/*`；`apps/api/src/dsh-proxy-routes.ts`）
- [x] 反代独立源监听（`ServerOptions.dshProxyPort`，同 host 不同端口；`GET /api/config` 下发
      `dshBase`，`GET /api/workspaces/:id/dsh/status` 代探面板容器）
- [ ] iframe 容器组件与 CSP（前端切到 `dshBase` + `allow-same-origin`）
- [x] 面板清单接口（manifest `panels` 声明；实际注册数冒烟留后续）
- [ ] 沙箱规格与内存预算更新
