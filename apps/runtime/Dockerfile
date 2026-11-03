# syntax=docker/dockerfile:1
#
# roostbot runtime image — DSH + the runtime sidecar in one workspace container.
#
#   build:  docker build -f apps/runtime/Dockerfile -t roostbot-runtime:dev apps/runtime
#   run:    see apps/runtime/README.md (UPSTREAM / RUNTIME_TOKEN / BASE_PATH required)
#
# ---------------------------------------------------------------------------
# HONEST STATUS: this Dockerfile has NEVER been built. The development machine
# has no Docker/podman/colima (docs/spikes/0001-runtime-contract.md), so nothing
# below is validated. Specifically unverified:
#   1. the npm global install layout copied from the builder stage, and whether
#      @deepseek-ai/dsh native modules have a musl/alpine build (or compile);
#   2. the exact `dsh web --profile <dir>` invocation used by entrypoint.sh —
#      the spike only proved `--profile` exists somewhere in the CLI;
#   3. whether DSH hands out its Web port from the profile (cordis.patch.yml
#      webserver.port) so that UPSTREAM=http://127.0.0.1:4100 is the real port;
#   4. the HEALTHCHECK node one-liner and the start-period/retries values
#      against a real cold start;
#   5. that /data/dsh is the directory DSH actually treats as $DSH_HOME.
# Validate in CI on linux/amd64 and linux/arm64 before shipping.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS dsh-install

ARG DSH_VERSION=0.2.1-rc.5

# Build toolchain stays in this stage. Needed only if npm has to compile a
# native addon (node-pty / koffi / node-addon-require-builtin) against musl.
RUN apk add --no-cache python3 make g++ linux-headers
RUN npm install --global --no-fund --no-audit "@deepseek-ai/dsh@${DSH_VERSION}" \
 && dsh --version

FROM node:22-alpine

ARG DSH_VERSION=0.2.1-rc.5

LABEL org.opencontainers.image.title="roostbot runtime" \
      org.opencontainers.image.description="DSH + runtime sidecar (base path, /healthz, /activity, runtime token)" \
      org.opencontainers.image.version="${DSH_VERSION}" \
      org.opencontainers.image.licenses="Apache-2.0"

# UPSTREAM points at the loopback DSH process. BASE_PATH and RUNTIME_TOKEN are
# injected by the control plane at start; the entrypoint refuses to run without
# them (BASE_PATH= is intentionally not given a default here).
ENV PORT=19400 \
    DSH_PORT=4100 \
    UPSTREAM=http://127.0.0.1:4100 \
    DSH_HOME=/data/dsh \
    DSH_PROFILE=/opt/roostbot/profile

# The CLI is a symlink into /usr/local/lib/node_modules; keep the link relative
# so it still resolves after the copy. (Unverified — see header note 1.)
COPY --from=dsh-install /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY --from=dsh-install /usr/local/bin/dsh /usr/local/bin/dsh

WORKDIR /opt/roostbot
COPY --chown=node:node sidecar/ /opt/roostbot/sidecar/
# profile/ here is ONLY a baseline. The control plane generates the real
# workspace profile (package.json + cordis.yml + cordis.patch.yml + plugin
# lockfile) on the workspace volume and points DSH_PROFILE at it (or mounts over
# this directory). Tenant plugins/tokens must never be baked into the image.
COPY --chown=node:node profile/ /opt/roostbot/profile/
COPY --chown=node:node entrypoint.sh /opt/roostbot/entrypoint.sh

RUN chmod 0755 /opt/roostbot/entrypoint.sh \
 && mkdir -p /data/dsh \
 && chown node:node /data /data/dsh

USER node

# Only the sidecar is exposed; DSH stays on 127.0.0.1 inside the container.
EXPOSE 19400
VOLUME ["/data"]

# Liveness = sidecar answers AND upstream DSH is not unreachable ("ok":true).
# A plain 200 is not enough: the sidecar deliberately answers 200 with
# {"ok":false} while DSH is still booting. BASE_PATH is normalised inside the
# one-liner so a trailing slash cannot produce //healthz.
HEALTHCHECK --interval=10s --timeout=3s --start-period=60s --retries=3 \
  CMD node -e 'const base=(process.env.BASE_PATH||"").replace(/\/+$/,"");const port=process.env.PORT||"19400";fetch("http://127.0.0.1:"+port+base+"/healthz").then(r=>r.json()).then(j=>process.exit(j.ok===true?0:1)).catch(()=>process.exit(1))'

STOPSIGNAL SIGTERM

# entrypoint.sh starts sidecar + DSH, watches both, and drains DSH before the
# sidecar on SIGTERM.
CMD ["/opt/roostbot/entrypoint.sh"]
