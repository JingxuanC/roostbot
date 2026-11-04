# Roost 官网

零构建静态站：`index.html` + `styles.css` + `main.js` + `assets/`。
风格参考 dsbot.app（暖白、大留白、大字号品牌、圆润卡片），内容与鸟形象都是 Roost 自己的。

## 本地预览

```bash
node scripts/serve-site.mjs          # http://127.0.0.1:4173
PORT=8080 node scripts/serve-site.mjs
```

## 结构

| 文件 | 内容 |
|---|---|
| `index.html` | 单页：Hero / 产品截图 / 功能 / 怎么工作 / 鸟舍 / 开源 / FAQ / Footer |
| `styles.css` | 设计变量、响应式（980 / 640 断点）、滚动出现动画 |
| `main.js` | 导航滚动态、移动端抽屉、IntersectionObserver、复制命令 |
| `assets/room.png` | 产品截图（来自 `docs/assets/m5-browser-e2e.png`） |

## 鸟形象

Hero、功能图标、18 只鸟舍、页脚鸟都是 `apps/web/lib/bird.js` 生成的内联 SVG；
形象/配色规则见 [`docs/design/bot-avatar.md`](../../docs/design/bot-avatar.md)。
如果 bird.js 的物种/表情改版，需要重新生成这些内联 SVG（保持 id、尺寸、配饰参数）。

## 部署

任何静态托管都能直接放 `apps/site/`（GitHub Pages、Cloudflare Pages、对象存储、nginx）。
没有构建步骤，没有外部字体/CDN 请求。
