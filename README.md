# Roost Bot

一群住在云机器上的 Bot，能连回你自己电脑上的 DSH。

- **云机器**：常驻、随时可用，Bot 团队在云上值班
- **本地 DSH**：配对一次，云上的 Bot 就能使用你本机的工具、文件和模型额度
- **记忆**：由 [causal-memory](../causal-memory) 提供，不是聊天记录，是可检索、可追溯的判断
- **模型**：用户自带 token（BYO），平台不转售推理

状态：**骨架阶段**。这里是仓库根，代码在 `apps/`、`packages/`，设计与决策在 `docs/`。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/vision.md](docs/vision.md) | 做什么、不做什么、为谁做 |
| [docs/architecture.md](docs/architecture.md) | 控制面 / 运行时 / 沙箱 / 租户模型 |
| [docs/runtime-contract.md](docs/runtime-contract.md) | DSH 作为云运行时必须提供的七条契约 |
| [docs/design/](docs/design/) | 设计文档（10 份）：事件、认证、记忆、预算、loop 与上下文、消息、协作、调度、工作区、沙箱 |
| [docs/spikes/](docs/spikes/) | 可复现的实验与结论（含环境限制） |
| [docs/decisions/](docs/decisions/) | 命名、记忆、许可等决策记录 |

## 许可

Apache License 2.0，见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)。

第三方组件登记在 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
