# Roost Bot 微信小程序端 · M0

原生小程序 MVP 的第一阶段：**骨架 + 配对登录 + 房间列表**。零依赖，不引入 npm 包。

## 当前范围（诚实清单）

| 有 | 还没有 |
|---|---|
| `wx.request` 封装（Bearer / 错误归一 / 401 处理） | 房间详情页与消息收发（M1） |
| 配对码登录（`POST /api/pairing/claim`） | Bot 列表 / 设置 / 附件（M2） |
| 房间列表（`GET /api/rooms`）+ 下拉刷新 + 退出登录 | 微信一键登录 `code2session`（M4，可选） |
| token 本地存储与过期检查 | 备案域名 / HTTPS / 反代（M3，外部流程） |
| `utils/poll.js` 轮询器（M1 用） | |
| `node:test` 单元测试 | |

**后端本次一行未改** —— Bearer 认证、`messages?after=N`、配对 claim 都是现成能力。

## 跑起来（开发期，不需要备案）

1. 起本地控制面（仓库根目录）：
   ```sh
   ROOST_DB=/tmp/roost.db node --experimental-strip-types apps/api/src/main.ts
   ```
2. 浏览器打开 `http://127.0.0.1:8787/` → 登录 → 生成 **6 位配对码**。
   （想直接看到房间，可先跑 `node --experimental-strip-types scripts/seed-demo.ts /tmp/roost.db`）
3. 微信开发者工具 → 导入项目 → 目录选 `apps/miniprogram` → AppID 选「测试号」。
   `project.config.json` 已设 `urlCheck: false`（不校验合法域名），可直接连本机 8787。
4. 小程序输入配对码 → 连接 → 应看到真实房间列表。

## 验证

```sh
# utils 单测（不需要微信开发者工具）
node --test apps/miniprogram/test/utils.test.js

# 后端基线
sh scripts/verify.sh
```

## 目录

```
apps/miniprogram/
├── project.config.json / app.json / app.js / app.wxss / sitemap.json
├── utils/
│   ├── config.js   # BASE_URL：开发期 127.0.0.1:8787，上线改备案 HTTPS 域名
│   ├── auth.js     # token 存取 / 过期检查
│   ├── api.js      # REST 封装 + 错误归一（隔离后端变化）
│   └── poll.js     # after 游标轮询器（M1）
├── pages/
│   ├── login/      # 配对码登录
│   └── rooms/      # 房间列表
└── test/
    └── utils.test.js
```

## 上线前必改

1. `utils/config.js` 的 `BASE_URL` → 已 ICP 备案的 HTTPS 域名。
2. 微信公众平台配置 `request` 合法域名。
3. **控制面不得直暴公网**（`apps/api/src/server.ts:13`）：走 Nginx/Caddy 反代 + TLS，正确设置 Host / `X-Forwarded-*`。
4. 把 `project.config.json` 的 `urlCheck` 交回给工具设置，真机体验版验证。

## 约定

遵循仓库 `CONVENTIONS.md`：零依赖、不碰别人目录（本目录为独立 scope）、公共接口以设计文档为准、不写假数据接口（拿不到就如实报错）。
