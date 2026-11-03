#!/bin/sh
# roostbot runtime entrypoint.
#
# One workspace container runs two processes:
#   1. the runtime sidecar (base path + /healthz + /activity + runtime token) on
#      127.0.0.1:${PORT}; this is the only port the control plane should expose.
#   2. DSH (the upstream), normally 127.0.0.1:4100; it stays on loopback.
#
# Signals: SIGTERM/SIGINT stop DSH first (so in-flight turns can drain), then the
# sidecar. If either process dies on its own the container exits non-zero.
#
# The real workspace profile is materialised by the control plane; this image
# only ships a baseline at /opt/roostbot/profile (see Dockerfile).
set -eu

log() { printf '[entrypoint] %s\n' "$*" >&2; }
die() { log "ERROR: $*"; exit 2; }

# --- required environment ---------------------------------------------------
if [ -z "${UPSTREAM:-}" ]; then
  die "UPSTREAM is required (e.g. http://127.0.0.1:4100)"
fi
if [ -z "${RUNTIME_TOKEN:-}" ]; then
  die "RUNTIME_TOKEN is required"
fi
if [ -z "${BASE_PATH:-}" ]; then
  die "BASE_PATH is required (e.g. /w/ws_123)"
fi

case "$UPSTREAM" in
  http://*) : ;;
  *) die "UPSTREAM must be an http:// URL the sidecar can reach (got '$UPSTREAM')" ;;
esac
case "$BASE_PATH" in
  /*) : ;;
  *) die "BASE_PATH must start with '/' (got '$BASE_PATH')" ;;
esac
# proxy.mjs strips trailing slashes; normalise here too so the health URL and
# the forwarded path agree. "/" stays as the root mount.
while [ "$BASE_PATH" != "/" ] && [ "${BASE_PATH%/}" != "$BASE_PATH" ]; do
  BASE_PATH="${BASE_PATH%/}"
done

# --- configuration ----------------------------------------------------------
PORT="${PORT:-19400}"
DSH_HOME="${DSH_HOME:-/data/dsh}"
DSH_DATA_DIR="${DSH_DATA_DIR:-$DSH_HOME/alpha-desk}"
DSH_PROFILE="${DSH_PROFILE:-/opt/roostbot/profile}"
DSH_BIN="${DSH_BIN:-dsh}"
DSH_SUBCOMMAND="${DSH_SUBCOMMAND:-web}"
SIDECAR_SCRIPT="${SIDECAR_SCRIPT:-/opt/roostbot/sidecar/proxy.mjs}"
NODE_BIN="${NODE_BIN:-node}"
DSH_SHUTDOWN_TIMEOUT="${DSH_SHUTDOWN_TIMEOUT:-20}"
SIDECAR_SHUTDOWN_TIMEOUT="${SIDECAR_SHUTDOWN_TIMEOUT:-5}"

export UPSTREAM RUNTIME_TOKEN BASE_PATH PORT DSH_DATA_DIR DSH_HOME

# --- preflight ---------------------------------------------------------------
command -v "$NODE_BIN" >/dev/null 2>&1 || die "node not found: $NODE_BIN"
command -v "$DSH_BIN" >/dev/null 2>&1 || die "DSH binary not found on PATH: $DSH_BIN"
[ -f "$SIDECAR_SCRIPT" ] || die "sidecar script not found: $SIDECAR_SCRIPT"
[ -d "$DSH_PROFILE" ] || die "DSH profile not found: $DSH_PROFILE"
mkdir -p "$DSH_HOME" || die "cannot create DSH_HOME: $DSH_HOME"

SIDECAR_PID=""
DSH_PID=""
WATCHDOG_PID=""
SHUTTING_DOWN=0
HEALTH_URL="http://127.0.0.1:${PORT}${BASE_PATH%/}/healthz"

# Probe the sidecar's own /healthz (it answers 200 even when upstream DSH is
# still booting; that is the liveness signal we want here). Prefer wget from
# Alpine, fall back to node so the script also works on a plain Node image.
probe_health() {
  if command -v wget >/dev/null 2>&1; then
    wget -q -T 2 -O /dev/null "$1" 2>/dev/null
    return $?
  fi
  "$NODE_BIN" -e '
    const http = require("node:http")
    const req = http.get(new URL(process.argv[1]), (res) => {
      res.resume()
      process.exit(res.statusCode === 200 ? 0 : 1)
    })
    req.setTimeout(1500, () => { req.destroy(); process.exit(1) })
    req.on("error", () => process.exit(1))
  ' "$1" >/dev/null 2>&1
}

wait_for_sidecar() {
  tries=0
  while [ "$tries" -lt 10 ]; do
    if probe_health "$HEALTH_URL"; then
      return 0
    fi
    sleep 1
    tries=$((tries + 1))
  done
  return 1
}

# wait full `timeout` seconds before SIGKILL, but reap immediately when the
# process exits. Polling `kill -0` would mistake a zombie for a live process.
stop_process() {
  label=$1
  pid=$2
  timeout=$3
  if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null; then
    return 0
  fi
  log "stopping ${label} (pid ${pid}, ${timeout}s grace)"
  kill -TERM "$pid" 2>/dev/null || true
  (
    sleep "$timeout"
    if kill -0 "$pid" 2>/dev/null; then
      printf '[entrypoint] %s did not exit in %ss; sending SIGKILL\n' "$label" "$timeout" >&2
      kill -KILL "$pid" 2>/dev/null || true
    fi
  ) &
  watchdog=$!
  set +e
  wait "$pid"
  status=$?
  set -e
  kill "$watchdog" 2>/dev/null || true
  wait "$watchdog" 2>/dev/null || true
  log "${label} exited (status ${status})"
  return 0
}

shutdown() {
  if [ "$SHUTTING_DOWN" -eq 1 ]; then
    return 0
  fi
  SHUTTING_DOWN=1
  # Do not reconfigure the signal trap here: background helpers spawned by
  # stop_process must keep the default TERM disposition so the fallback watchdog
  # can actually be stopped. Repeated signals are absorbed by on_signal.
  # The container runtime's SIGKILL is still the last resort.

  # Ordered stop: watcher, then DSH (drain), then the front door.
  stop_process "health-watchdog" "$WATCHDOG_PID" 1
  stop_process "DSH" "$DSH_PID" "$DSH_SHUTDOWN_TIMEOUT"
  stop_process "sidecar" "$SIDECAR_PID" "$SIDECAR_SHUTDOWN_TIMEOUT"
}

on_signal() {
  if [ "$SHUTTING_DOWN" -eq 1 ]; then
    log "already shutting down; ignoring repeated signal"
    return 0
  fi
  log "received SIGTERM/SIGINT; shutting down"
  shutdown
  exit 0
}
trap on_signal TERM INT

# A sidecar that stops answering means the workspace is unreachable. Take DSH
# down with it so the container exits non-zero instead of running headless.
watch_sidecar() {
  failures=0
  while :; do
    if probe_health "$HEALTH_URL"; then
      failures=0
    else
      failures=$((failures + 1))
      if [ "$failures" -ge 3 ]; then
        log "sidecar health probe failed ${failures} times; terminating DSH"
        kill -TERM "$DSH_PID" 2>/dev/null || true
        return 0
      fi
    fi
    sleep 2
  done
}

# --- start the sidecar -------------------------------------------------------
log "starting sidecar on 127.0.0.1:${PORT}${BASE_PATH} -> ${UPSTREAM}"
"$NODE_BIN" "$SIDECAR_SCRIPT" &
SIDECAR_PID=$!

if ! wait_for_sidecar; then
  log "sidecar did not become ready at ${HEALTH_URL}"
  shutdown
  exit 1
fi

# --- start DSH ---------------------------------------------------------------
# `--profile` is passed after the subcommand, matching `dsh plugin --profile X ...`.
# DSH_EXTRA_ARGS is an optional flag list from the control plane.
if [ -n "$DSH_SUBCOMMAND" ]; then
  set -- "$DSH_SUBCOMMAND"
else
  set --
fi
set -- "$@" --profile "$DSH_PROFILE"
if [ -n "${DSH_EXTRA_ARGS:-}" ]; then
  # Deliberate word splitting: this is a flag list, not a single path.
  # shellcheck disable=SC2086
  set -- "$@" $DSH_EXTRA_ARGS
fi
log "starting DSH: ${DSH_BIN} $*"
"$DSH_BIN" "$@" &
DSH_PID=$!

watch_sidecar &
WATCHDOG_PID=$!

# Block on DSH. SIGTERM interrupts wait, runs on_signal, and exits 0.
set +e
wait "$DSH_PID"
DSH_STATUS=$?
set -e

if [ "$SHUTTING_DOWN" -eq 0 ]; then
  log "DSH exited unexpectedly (status ${DSH_STATUS})"
  shutdown
  exit 1
fi
