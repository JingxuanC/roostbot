#!/bin/sh
# Install Hermes Agent with ACP support for Roost's hermes adapter.
# This is optional and intentionally separated from the base image: Hermes is a
# Python application and its own installer may pull large tool/browser assets.
set -eu
INSTALL_DIR=${HERMES_INSTALL_DIR:-/opt/agents/hermes}
HERMES_HOME=${HERMES_HOME:-$INSTALL_DIR/home}
command -v curl >/dev/null 2>&1 || { echo "curl is required" >&2; exit 1; }
mkdir -p "$INSTALL_DIR" "$HERMES_HOME"
curl -fsSL https://hermes-agent.nousresearch.com/install.sh \
  | HERMES_INSTALL_DIR="$INSTALL_DIR" HERMES_HOME="$HERMES_HOME" bash -s -- \
      --non-interactive --skip-browser --skip-computer-use
ln -sf "$HERMES_HOME/bin/hermes" /usr/local/bin/hermes 2>/dev/null || true
hermes --version || true
