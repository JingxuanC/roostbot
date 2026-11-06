# 方案 A 的沙箱镜像：一个用户/工作区一个沙箱，里面跑长活 DSH + room-agent。
#
#   node:22-slim（glibc，DSH 的 native binding 有预编译包）
#   + @deepseek-ai/dsh（SDK 长活进程）
#   + room-agent.mjs（沙箱主进程：JSON-RPC 驱动 DSH，按房间管理会话）
#
# 构建（远端 Docker 28）：
#   docker build -f apps/runtime/agent.Dockerfile -t roost/agent:dev .
# 运行（由控制面创建沙箱时指定）：
#   sandbox create --from roost/agent:dev -- node /opt/roost/room-agent.mjs
FROM node:22-slim

ARG DSH_VERSION=0.2.1-rc.5
RUN npm install -g "@deepseek-ai/dsh@${DSH_VERSION}" && npm cache clean --force && dsh --version

COPY apps/runtime/room-agent.mjs /opt/roost/room-agent.mjs
# routine 隔离回合的纯函数；room-agent import 它，漏 COPY 会在沙箱里启动即崩。
COPY apps/runtime/routine-turn.mjs /opt/roost/routine-turn.mjs
# room-agent 的 dsh web 子进程封装（插件面板容器，ADR 0004）；缺这个文件 room-agent 起不来。
COPY apps/runtime/dsh-web.mjs /opt/roost/dsh-web.mjs
# 审批桥：启动 dsh 前由 room-agent 装进 $DSH_HOME/profiles/<profile>（TODO 5.4.3）。
COPY apps/runtime/profile-plugins.mjs /opt/roost/profile-plugins.mjs
COPY packages/approvals-bridge /opt/roost/packages/approvals-bridge
# 沙箱以 uid 1000 运行：COPY 会保留宿主机源文件权限（本地可能是 600），
# 不放开读权限时 room-agent 连 dsh-web.mjs 都 import 不了。
RUN chmod -R a+rX /opt/roost

# 会话日志跟工作区走（停止/启动沙箱不丢），见 docs/spikes/0002。
ENV DSH_HOME=/workspace/.dsh
# 沙箱里默认开面板容器（127.0.0.1:4099）；控制面/用户可设 ROOST_DSH_WEB=0 关掉。
ENV ROOST_DSH_WEB=1
# 审批桥默认开（可用 ROOST_APPROVAL_BRIDGE=0 覆盖）。开着时 room-agent 会把
# DSH 的权限档位钉到 workspace-write，否则 approval 策略是 never，桥收不到请求。
ENV ROOST_APPROVAL_BRIDGE=1
ENV ROOST_APPROVAL_BRIDGE_PACKAGE=/opt/roost/packages/approvals-bridge
# 沙箱外边界由 OpenShell 提供；这里保留 danger-full-access 作为「桥关闭时」的
# 默认档位，桥启用时 room-agent 会覆盖它（approval 才能到达 answerer）。
ENV DSH_PERMISSION_MODE=danger-full-access
ENV HOME=/workspace
WORKDIR /workspace
# 沙箱以 uid 1000 运行，WORKDIR 必须对它是可用的（否则 OpenShell 报
# "OCI WorkingDir is not usable by the sandbox identity"）。
RUN mkdir -p /workspace/.dsh && chown -R 1000:1000 /workspace

# 沙箱主进程：长活 room-agent（内部再起 `dsh --profile sdk`）。
CMD ["node", "/opt/roost/room-agent.mjs"]
