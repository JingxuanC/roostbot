# @roost/plugins

插件清单、预检与安装状态。**同一套 DSH 插件模型，兼容；但平台要补三件事**：版本预检、无人值守安装、信任与授权。

设计见 [`docs/design/plugins.md`](../../docs/design/plugins.md)。

## 为什么需要预检

我们踩过两次真实的坑：

| 事故 | 原因 |
|---|---|
| `dsh-uzi` 启动报 `reading 'prefixes'` | peer 依赖是旧 DSH API |
| 两个 bundle 都注册 `/api/trust-center` | 重复路由，第二个直接失败 |

所以 `preflight()` 在安装前检查四项：DSH 版本区间、路由冲突、slot 冲突、数据依赖/磁盘。**任一失败禁止安装**。

## 三类插件

| 类别 | 安装方式 | 谁能改 |
|---|---|---|
| 基础族（镜像预置） | 构建时打入 | 不能改 |
| 可授权族（市场） | 控制面 lockfile → runtime sync | admin |
| 本地开发（`link:`） | **云上禁止**（`isCloudInstallable` 会拦） | 仅本机 |

## 待办

- [ ] 预检的第五项：临时 profile dry-run mount
- [ ] 安装后冒烟（面板数/工具数/无重复路由）
- [ ] 兼容矩阵与产品版本升级联动
