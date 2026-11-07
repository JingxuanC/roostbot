# 方案 A 的沙箱镜像：一个用户/工作区一个沙箱，里面跑长活 DSH + room-agent。
#
#   node:22-slim（glibc，DSH 的 native binding 有预编译包）
#   + @deepseek-ai/dsh（SDK 长活进程）
#   + room-agent.mjs（沙箱主进程：JSON-RPC 驱动 DSH，按房间管理会话）
#
# 构建（远端 Docker 28；构建机的 docker bridge 关了 IPv4 forwarding，需要 host 网络拉
# npm/apt 包）：
#   docker build --network host -f apps/runtime/agent.Dockerfile -t roost/agent:dev .
#
# 外部 runtime（docs/design/agent-runtimes.md §12.1）：默认安装 Claude Code CLI +
# Codex CLI/codex-acp；grok-build 没有公开官方安装包，默认跳过（见 GROK_BUILD_*）。
# 所有版本固定，镜像里不写任何 key/OAuth 状态；缺少的二进制由 adapter probe 报成
# 数据（ok:false/problems），不影响 DSH 启动，也不影响 multi-runtime 默认关闭。
# 运行（由控制面创建沙箱时指定）：
#   sandbox create --from roost/agent:dev -- node /opt/roost/room-agent.mjs
FROM node:22-slim

ARG DSH_VERSION=0.2.1-rc.5
# External runtimes: pinned, opt-out via build args. No credentials are baked in.
ARG INSTALL_CLAUDE_CODE=1
ARG CLAUDE_CODE_VERSION=2.1.319
ARG INSTALL_CODEX_CLI=1
ARG CODEX_VERSION=0.167.0
ARG INSTALL_CODEX_ACP=1
ARG CODEX_ACP_VERSION=0.16.0
# grok-build has no public official package/installer at the pinned date. Point
# this at a pinned tarball (containing bin/<GROK_BUILD_BIN>) to install it;
# default empty = explicit skip with a note.
ARG GROK_BUILD_INSTALL_URL=
ARG GROK_BUILD_SHA256=
ARG GROK_BUILD_BIN=grok

# libssl3: codex-acp's linux-x64 native binary links libssl.so.3. git/curl are
# runtime needs of the external CLIs; ca-certificates is required for HTTPS.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git libssl3 \
    && rm -rf /var/lib/apt/lists/*
RUN npm install -g "@deepseek-ai/dsh@${DSH_VERSION}" && npm cache clean --force && dsh --version

RUN set -eux; \
    if [ "${INSTALL_CLAUDE_CODE}" = "1" ]; then \
      npm install -g --no-audit --no-fund "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"; \
    else echo "NOTE: Claude Code CLI skipped (INSTALL_CLAUDE_CODE=0)"; fi; \
    if [ "${INSTALL_CODEX_CLI}" = "1" ]; then \
      npm install -g --no-audit --no-fund "@openai/codex@${CODEX_VERSION}"; \
    else echo "NOTE: Codex CLI skipped (INSTALL_CODEX_CLI=0)"; fi; \
    if [ "${INSTALL_CODEX_ACP}" = "1" ]; then \
      npm install -g --no-audit --no-fund "@zed-industries/codex-acp@${CODEX_ACP_VERSION}"; \
    else echo "NOTE: codex-acp skipped (INSTALL_CODEX_ACP=0)"; fi; \
    if [ -n "${GROK_BUILD_INSTALL_URL}" ]; then \
      echo "installing grok-build from ${GROK_BUILD_INSTALL_URL}"; \
      mkdir -p /opt/agents/grok-build/bin; \
      curl -fsSL "${GROK_BUILD_INSTALL_URL}" -o /tmp/grok-build.tar.gz; \
      if [ -n "${GROK_BUILD_SHA256}" ]; then \
        echo "${GROK_BUILD_SHA256}  /tmp/grok-build.tar.gz" | sha256sum -c -; \
      else echo "WARNING: GROK_BUILD_SHA256 is empty; pinning hash is recommended"; fi; \
      tar -xzf /tmp/grok-build.tar.gz -C /opt/agents/grok-build --strip-components=1; \
      if [ -f "/opt/agents/grok-build/bin/${GROK_BUILD_BIN}" ]; then \
        chmod +x "/opt/agents/grok-build/bin/${GROK_BUILD_BIN}"; \
      else echo "NOTE: tarball had no bin/${GROK_BUILD_BIN}; probe will report it missing"; fi; \
      rm -f /tmp/grok-build.tar.gz; \
    else \
      echo "NOTE: grok-build ACP wrapper not installed (no public official package)."; \
      echo "      Set GROK_BUILD_INSTALL_URL (+GROK_BUILD_SHA256) to a pinned tarball."; \
      echo "      Probe reports it as data (ok:false/problems); DSH boot is unaffected."; \
    fi; \
    npm cache clean --force

COPY apps/runtime/room-agent.mjs /opt/roost/room-agent.mjs
# routine 隔离回合的纯函数；room-agent import 它，漏 COPY 会在沙箱里启动即崩。
COPY apps/runtime/routine-turn.mjs /opt/roost/routine-turn.mjs
COPY apps/runtime/turn-grace.mjs /opt/roost/turn-grace.mjs
# room-agent 的 dsh web 子进程封装（插件面板容器，ADR 0004）；缺这个文件 room-agent 起不来。
COPY apps/runtime/dsh-web.mjs /opt/roost/dsh-web.mjs
# 审批桥：启动 dsh 前由 room-agent 装进 $DSH_HOME/profiles/<profile>（TODO 5.4.3）。
COPY apps/runtime/profile-plugins.mjs /opt/roost/profile-plugins.mjs
COPY packages/approvals-bridge /opt/roost/packages/approvals-bridge
# 多 Agent runtime（docs/design/agent-runtimes.md）：supervisor 动态 import
# ./agent-supervisor.mjs；镜像里用符号链接把真实文件保留在 apps/runtime/，
# 这样 supervisor/adapters 的 ../../packages 相对导入仍然指向 /opt/roost/packages。
COPY packages/agent-runtime /opt/roost/packages/agent-runtime
COPY apps/runtime/agent-adapters /opt/roost/apps/runtime/agent-adapters
COPY apps/runtime/agent-supervisor.mjs /opt/roost/apps/runtime/agent-supervisor.mjs
RUN ln -s /opt/roost/apps/runtime/agent-supervisor.mjs /opt/roost/agent-supervisor.mjs
# 多 runtime 默认关闭；控制面可通过 ROOST_MULTI_RUNTIME=1 打开。
ENV ROOST_MULTI_RUNTIME=0
# Adapter commands. Missing binaries are reported by probe as data, not boot errors.
ENV ROOST_CLAUDE_BIN=claude
ENV ROOST_CODEX_BIN=codex-acp
ENV ROOST_GROK_BIN=/opt/agents/grok-build/bin/grok
# 沙箱以 uid 1000 运行：COPY 会保留宿主机源文件权限（本地可能是 600），
# 不放开读权限时 room-agent 连 dsh-web.mjs 都 import 不了。
RUN chmod -R a+rX /opt/roost

# Build-time smoke checks (never fail on a missing external runtime):
# - the supervisor/registry graph imports through the symlink layout;
# - room-agent still exports its entry (boot path intact);
# - each external runtime probe returns DATA (ok/version/auth/problems), never throws.
RUN set -eux; \
    dsh --version; \
    node --input-type=module -e 'await import("/opt/roost/agent-supervisor.mjs"); await import("/opt/roost/apps/runtime/agent-adapters/registry.mjs"); console.log("multi-runtime graph ok")'; \
    node --input-type=module -e 'const m = await import("/opt/roost/room-agent.mjs"); if (typeof m.startRoomAgent !== "function") process.exit(1); console.log("room-agent entry ok")'; \
    node --input-type=module -e 'const { createRuntimeAdapter } = await import("/opt/roost/apps/runtime/agent-adapters/registry.mjs"); const cases = [["grok-build", { command: process.env.ROOST_GROK_BIN, args: [], initializeTimeoutMs: 1500 }], ["codex", { command: process.env.ROOST_CODEX_BIN, args: [], initializeTimeoutMs: 1500 }], ["claude-code", { command: process.env.ROOST_CLAUDE_BIN }]]; const out = {}; for (const [kind, config] of cases) { try { const adapter = createRuntimeAdapter(kind, config); const probe = await adapter.probe(); out[kind] = { ok: probe.ok, version: probe.version ?? null, auth: probe.auth, problems: (probe.problems ?? []).slice(0, 1) }; } catch (error) { out[kind] = { ok: false, error: String(error?.message ?? error) }; } } console.log(JSON.stringify(out))'

# 会话日志跟工作区走（停止/启动沙箱不丢），见 docs/spikes/0002。
ENV DSH_HOME=/workspace/.dsh
# 沙箱里默认开面板容器（127.0.0.1:4099）；控制面/用户可设 ROOST_DSH_WEB=0 关掉。
ENV ROOST_DSH_WEB=1
# 默认关闭审批桥：产品默认 Bot 全权，bash 不再逐次审批。需要审批时改成 1 并接入审批卡。
# DSH 的权限档位钉到 workspace-write，否则 approval 策略是 never，桥收不到请求。
ENV ROOST_APPROVAL_BRIDGE=0
ENV ROOST_APPROVAL_BRIDGE_PACKAGE=/opt/roost/packages/approvals-bridge
# The profile plugin owns token deltas; room-agent must not re-send the final paragraph.
ENV ROOST_STREAM_TAP=1
# 沙箱外边界由 OpenShell 提供；这里保留 danger-full-access 作为「桥关闭时」的
# 默认档位，桥启用时 room-agent 会覆盖它（approval 才能到达 answerer）。
ENV DSH_PERMISSION_MODE=danger-full-access
ENV HOME=/workspace
WORKDIR /workspace
# 沙箱以 uid 1000 运行，WORKDIR 必须对它是可用的（否则 OpenShell 报
# "OCI WorkingDir is not usable by the sandbox identity"）。
RUN mkdir -p /workspace/.dsh && chown -R 1000:1000 /workspace

# 沙箱主进程：长活 room-agent（内部再起 `dsh --profile sdk`）。
# OpenShell 拒绝 uid/gid 0 的 workload identity，最终镜像不能以 root 运行。
USER 1000:1000
CMD ["node", "/opt/roost/room-agent.mjs"]
