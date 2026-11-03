# apps/web — 网页端

配对登录后的主界面：Bot 列表、房间、时间线、审批、记忆面板、设置。

## 技术栈（待定，建议）

- Vite + React 19 + TypeScript（与 DSH 客户端同栈，插件可直接复用）
- 状态：事件流（SSE）+ 本地 store
- 样式：Tailwind（与 alpha-desk 官网一致）

## v0 范围

1. 配对页（输入配对码）
2. Bot 列表 + 一个房间的对话
3. 审批卡片
4. 设置：provider token、记忆开关、本地 DSH 配对状态

## 不做的

- 不做行情/报告面板（那是 alpha-desk 插件族的事）
- 不做桌面壳（后续用 Tauri 或 Electron，先网页）
