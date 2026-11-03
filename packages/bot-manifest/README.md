# @roost/bot-manifest

一个 Bot 就是一份声明：它是谁、能用什么、记得什么。运行时按 manifest 装载，不把配置写死在团队文件里。

- `bot.schema.json` — v1 规范
- `example.bot.json` — 一个真实形状的样例

## 设计要点

1. **版本化**：manifest 可打包、可分发、可回滚，像插件一样
2. **能力是白名单**：`tools.allow` / `tools.deny`，没写就是不能用
3. **审批是清单**：危险动作要列出来，运行时才允许发起审批
4. **记忆带作用域**：`team` / `room` / `member`，读取规则见 `docs/architecture.md`
5. **调度带 checks**：先跑纯代码检查，值得才起模型

## 待补

- [ ] TypeScript 类型生成（json-schema-to-typescript）
- [ ] 校验 CLI：`roostbot bot validate <file>`
