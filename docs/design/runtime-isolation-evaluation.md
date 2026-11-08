# Runtime 隔离评估：Docker / gVisor / Kata

> 状态：评估记录（2026-11-08）。当前默认 Docker bridge + 非 root + cap-drop +
> no-new-privileges + egress allowlist；gVisor/Kata 未安装。

## 当前 Docker 边界

```text
container isolation
non-root uid 1000
cap-drop ALL
no-new-privileges
read-only rootfs（opt-in，DSH native addon 暂不兼容）
memory/cpu/pids limit
dedicated bridge network + default-deny egress
```

能防：

```text
普通进程越权写宿主
容器访问未授权出网
资源无序占用
```

不能防：

```text
内核漏洞逃逸
容器内进程共享宿主内核
```

## 评估选项

| 方案 | 隔离 | 运维成本 | 当前结论 |
|---|---|---|---|
| Docker 默认 runc | 中 | 低 | 当前使用 |
| gVisor runsc | 高（用户态内核） | 中 | 未安装；需验证 DSH/Bash/CLI 兼容性 |
| Kata Containers | 高（微虚拟机） | 高 | 需要 KVM/节点配置 |
| 独立云主机/VM | 最高 | 很高 | 多宿主阶段再评估 |

## gVisor 最小验收

```text
安装 runsc 并注册 docker runtime
用 roost/agent:multi-runtime 启动一个 workspace
验证 DSH / Bash / Claude / Codex 的 syscall 兼容
验证 egress allowlist 仍生效
验证资源限制和 ready
压力测试启动延迟和 CPU 开销
```

未通过前不切换默认 runtime。

## 决策

```text
当前：Docker runc + bridge + egress allowlist
触发升级：多租户不可信代码、容器逃逸风险要求提高
下一候选：gVisor runsc（优先），Kata 作为 VM 级备选
```
