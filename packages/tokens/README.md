# @roost/tokens

设计 token：冷底 + 暖强调，一套间距/字号/动效。

设计见 [`docs/design/ui.md`](../../docs/design/ui.md) §6。

```ts
import { cssVars, color, space, radius, fontSize, motion } from '@roost/tokens'
const style = cssVars('dark')   // → { '--roost-bg': '#0B0C0E', … }
```

## 规则

- 间距只用 **4 的倍数**（`space`）
- 颜色只用 `color` 里的语义 token，不写裸 hex
- 动效时长只用 `motion` 的 120/180/240；`prefers-reduced-motion` 时归零但**保留状态变化**
- 深浅色两套都要过对比度检查（正文 ≥ 4.5:1）

## 待办

- [ ] 导出 Tailwind preset（`tailwind.config.ts`）
- [ ] 对比度自动检查脚本
- [ ] 移动端字号（`sm` 在手机上 +1）
