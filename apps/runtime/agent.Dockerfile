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

# 会话日志跟工作区走（停止/启动沙箱不丢），见 docs/spikes/0002。
ENV DSH_HOME=/workspace/.dsh
# 沙箱边界由 OpenShell 提供；DSH 自己的审批在沙箱里只会卡住 Bot。
ENV DSH_PERMISSION_MODE=danger-full-access
ENV HOME=/workspace
WORKDIR /workspace
# 沙箱以 uid 1000 运行，WORKDIR 必须对它是可用的（否则 OpenShell 报
# "OCI WorkingDir is not usable by the sandbox identity"）。
RUN mkdir -p /workspace/.dsh && chown -R 1000:1000 /workspace

# 沙箱主进程：长活 room-agent（内部再起 `dsh --profile sdk`）。
CMD ["node", "/opt/roost/room-agent.mjs"]
