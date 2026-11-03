# @roost/artifacts

Bot 做出来的图片、PDF、报告、表格怎么到用户手上：**内容寻址 + 消息级授权 + 渲染矩阵**。

设计见 [`docs/design/artifacts.md`](../../docs/design/artifacts.md)。

## 三条硬规则

1. **渲染层拿不到真实路径**：只有受控 URL；文件经消息级路由打开，校验"这条消息确实引用了它"
2. **HTML/SVG 永不内联**：它们是脚本，只能进独立源 iframe 或新标签
3. **过大只给下载**：单文件 > 50MB、图片长边 > 8000px、表格 > 20MB 一律降级为下载卡片

## 渲染策略

```ts
renderModeOf(kind, size, mime)
  image → inline-image | card-download（>8MB）
  pdf   → card-preview（首页缩略图）
  html  → sandbox-frame
  table → table-preview（前 20 行）
  code  → code-block（>20 行折叠）
```

## 待办

- [ ] 缩略图生成（图片 + PDF 首页）与 EXIF 剥离
- [ ] 消息级文件路由（POST 校验 + Range + no-store）
- [ ] 沙箱 iframe 的域名规划（独立源）
