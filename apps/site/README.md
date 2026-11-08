# Roost 官网

零构建静态站：`index.html` + `styles.css` + `main.js` + `assets/`。
风格：欧美极简、中性黑白灰、无衬线标题、等宽标签、1px 分隔线；支持 EN / 中文切换。

## 本地预览

```bash
node scripts/serve-site.mjs          # http://127.0.0.1:4173
PORT=8080 node scripts/serve-site.mjs
```

## 结构

| 文件 | 内容 |
|---|---|
| `index.html` | Hero / 产品截图 / 三个原则 / Runtime 表 / 工作方式 / 安全 / 开源 / FAQ / CTA；文案用 `data-i18n` 双语 |
| `styles.css` | 设计 token、响应式（980 / 760 断点）、印刷/减少动态 |
| `main.js` | EN/中文词典与切换、导航滚动态、移动端抽屉、reveal、年份、`data-app` 链接 |
| `assets/room.png` | 产品截图（来自 `docs/assets/ui-desk-room.png`） |

## 设计参考

- Linear：把页面减到只剩必要信息，克制本身就是可信度。
- Vercel：产品界面直接当 hero，而不是抽象插画。
- Anthropic：安静、编辑式的排版，适合 trust-sensitive 的 AI 产品。
- Raycast：细节和微文案决定质感。
- 参考讨论：[The Best AI Startup Websites in 2026](https://studiomaydit.com/blog/best-ai-startup-websites-2026)。

原则：不复制表面，只复用原则；Roost 自己的差异是「多个 Agent 在同一房间，共享上下文」。

语言：默认跟随浏览器语言，可用右上角 `EN / 中文` 切换；`?lang=en` 可强制英文。

## 部署

任何静态托管都能直接放 `apps/site/`（GitHub Pages、Cloudflare Pages、对象存储、nginx）。
没有构建步骤，没有外部字体/CDN。App 地址默认 `https://roostbots.com/`；可在
`<body data-app-url="...">` 覆盖。
