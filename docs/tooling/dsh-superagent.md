# 开发代理：dsh-superagent

我们用 [dsh-superagent](https://github.com/deepseek-ai/dsh-superagent-prototype)（MIT，研究原型）当开发代理：它常驻、从 GitHub 事件接活、开分支提 PR。

## 本机安装形态

| 项 | 值 |
|---|---|
| profile | `~/.dsh/profiles/superagent`（`dsh web` 模板的副本，与桌面 app 隔离） |
| 插件 | `dsh-superagent`，源码 build 后以 link 安装 |
| DSH CLI | `~/.dsh/superagent-cli`（0.2.1-rc.5，独立副本，不依赖 /tmp） |
| 端口 | `127.0.0.1:3082`（只监听回环） |
| 状态库 | `~/.dsh/state/superagent/orchestrator.sqlite` |
| 常驻 | launchd `com.roostbot.superagent`（`KeepAlive`） |
| 专用 gh 身份 | `~/.local/bin/gh-agent` → `GH_CONFIG_DIR=~/.config/gh-agent` |
| 仓库 checkout | `~/src/roostbot`（每个工单一份 `git worktree`） |

## 配置（已通过管理 API 写入）

```
eval.mode        observe          # 主动工作只记录、不执行
executor.maxWorkers 2
executor.prepare    git worktree per ticket（fetch + worktree add agent/<name>）
policy.sources.github.allowed = ["JingxuanC"]   # 谁能派活
source:github       repository 待专用账号登录后填入（见下）
```

## 还差一步：专用 GitHub 账号

它写的每个 commit／PR 都挂在这个账号下，**不能用操作者自己的账号**。

```bash
# 1) 用专用账号登录（独立配置目录，不碰你自己的 gh）
GH_CONFIG_DIR=~/.config/gh-agent gh auth login
GH_CONFIG_DIR=~/.config/gh-agent gh api user --jq .login

# 2) 把它加为 JingxuanC/roostbot 的协作者（Write），否则推送会失败

# 3) 保存源配置
sh ~/.dsh/state/superagent/finish-github-setup.sh JingxuanC/roostbot
```

## 安装时踩到的三个坑（供复现）

1. **代码签名冲突**：用 DSH 自带的 node 跑 `pnpm build` 会失败（`different Team IDs`，签名进程无法 dlopen 未签名原生模块）。用 `pnpm env use --global 24.21.0` 装出的独立 node 构建。
2. **`dsh plugin add` 找不到 pnpm**：`~/.local/bin/pnpm` 指向已不存在的路径。做一个 shim（`node <real pnpm.cjs>`），并把它放在 PATH 前面。
3. **profile 的 `cordis.patch.yml` 初始是 `[]`**：直接追加会成非法 YAML；把 `[]` 替换为 `webserver.port` 与 `dsh-superagent.stateDir` 两个条目。

## 安全边界

- 面板只监听 `127.0.0.1`，且要求同源请求 + token
- 服务的 PATH 不含 `~/.local/bin`，所以它按名字摸不到操作者的 `gh`；要用 gh 只能走 `gh-agent`
- `eval.mode=observe`：它判断"该做的事"只记录，不自动执行
- auto-merge 关闭；PR 由人来合
