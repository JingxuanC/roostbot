# 代码约定（所有模块通用）

1. **零依赖优先**：不引入 npm 包就解决的问题，不引入。HTTP 用 `node:http`，测试用 `node:test`。
2. **TypeScript 但不需要构建**：源码是 `.ts`，用 `node --experimental-strip-types` 直接跑。
   - 只用**可擦除**语法：类型、接口、`as`、枚举可用 `const` 对象；**不要用** `enum`、`namespace`、参数属性、装饰器。
   - 相对导入必须写扩展名：`import { x } from './y.ts'`。
3. **每个包自己的测试**：`packages/<name>/test/*.test.ts`，`node:test` + `node:assert/strict`。
4. **不碰别人的目录**：每个 agent 只改自己 scope 里的文件；根 `package.json`、`README.md`、`.github/` 由 Lead 管。
5. **公共接口先看设计文档**：`docs/design/` 里 16 份是唯一事实源；与文档冲突时按文档实现，并在 PR 说明里指出文档哪句被证明不准确。
6. **不写假数据接口**：宁可返回 501 + 原因，也不要假装成功。
