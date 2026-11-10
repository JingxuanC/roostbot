#!/bin/sh
# Install/update the Roost Docker runtime worker on a Docker host.
# Run as root on the host that owns the Docker daemon.
#
#   ROOST_DOCKER_WORKSPACE_ROOT=/var/lib/roost/workspaces \
#     sh scripts/install-docker-worker.sh
#
# The caller must provide /etc/roost/docker-worker.env (see
# deploy/docker-worker.env.example) or this script copies the example and stops.
set -eu
REPO_ROOT=${REPO_ROOT:-$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)}
WORKER_HOME=${ROOST_DOCKER_WORKER_HOME:-/opt/roost}
ENV_FILE=${ROOST_DOCKER_WORKER_ENV:-/etc/roost/docker-worker.env}
SERVICE=/etc/systemd/system/roost-docker-worker.service

command -v node >/dev/null 2>&1 || { echo "node is required (install Node 22)" >&2; exit 1; }
command -v docker >/dev/null 2>&1 || { echo "docker CLI is required" >&2; exit 1; }

mkdir -p "$WORKER_HOME" "${ROOST_DOCKER_WORKSPACE_ROOT:-/var/lib/roost/workspaces}" "$(dirname "$ENV_FILE")"
install -m 755 "$REPO_ROOT/apps/runtime/docker-worker.mjs" "$WORKER_HOME/docker-worker.mjs"
install -m 644 "$REPO_ROOT/deploy/roost-docker-worker.service" "$SERVICE"

if [ ! -f "$ENV_FILE" ]; then
  install -m 600 "$REPO_ROOT/deploy/docker-worker.env.example" "$ENV_FILE"
  echo "created $ENV_FILE; set ROOST_DOCKER_WORKER_TOKEN and host paths, then rerun" >&2
  exit 2
fi

systemctl daemon-reload
systemctl enable roost-docker-worker
systemctl restart roost-docker-worker
systemctl is-active roost-docker-worker
