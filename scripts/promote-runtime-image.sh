#!/bin/sh
# Verify and promote a built runtime image tag on the Docker host.
# Usage: promote-runtime-image.sh <image-ref> [target-tag]
set -eu
IMAGE=${1:?usage: promote-runtime-image.sh <image-ref> [target-tag]}
TARGET=${2:-roost/agent:multi-runtime}
DOCKER_HOST=${DOCKER_HOST:-unix:///var/run/docker28/docker.sock}
export DOCKER_HOST
docker run --rm --entrypoint sh "$IMAGE" -lc '
  set -e
  id
  node --version
  dsh --version
  claude --version
  codex --version
  test -f /opt/roost/room-agent.mjs
  test -f /opt/roost/external-approvals.mjs
  test -f /opt/roost/codex-home/config.toml
'
docker tag "$IMAGE" "$TARGET"
echo "promoted $IMAGE -> $TARGET"
