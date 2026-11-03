# @roost/sandbox

沙箱策略模型：文件系统、进程、**按二进制**的出站规则；默认拒绝；策略变更的“需证明”判定。

设计见 [`docs/design/sandboxing.md`](../../docs/design/sandboxing.md)。

## 一句话

**DSH 决定做什么，沙箱只负责执行；凭据不进沙箱，只在出站时由可信侧注入。**

## 三条硬规则

1. **默认拒绝**：没列出的文件、目的地、程序一律拒绝
2. **按程序授权**：不是“沙箱能连 github”，而是“`git` 能连 github 的只读接口”
3. **变更需证明**：新增带凭据的主机、扩大 HTTP 方法、触碰云元数据端点 → 必须人工批准

## 采用哪一层

| 层 | 选型 |
|---|---|
| workspace 容器 | 容器运行时（租户边界） |
| 回合沙箱 | **NVIDIA OpenShell**（Apache-2.0，内核 LSM + seccomp 网络中介 + 策略证明）；备选 gVisor / microVM |

不自己写 bubblewrap：它没有网络中介、凭据注入与策略证明。

## 诚实边界

本机（macOS/Windows）**不承诺沙箱隔离**——没有 Landlock/seccomp。本机执行 = 用户自己的信任域，调用带 grant 与审计，但不是安全边界。

## 不在这个包里

- 沙箱执行（OpenShell / gVisor 的运行时）
- 凭据存储（控制面密钥服务）
- 快照与恢复（`scheduling.md`）

## 待办

- [ ] 策略 → OpenShell YAML 的转换器
- [ ] 策略版本与证明结果的持久化
- [ ] 拒绝原因 → 上下文注入的文案（让模型能换路径而不是死循环）
