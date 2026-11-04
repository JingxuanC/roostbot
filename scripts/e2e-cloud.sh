#!/bin/sh
# 云端 e2e 包装：在**云主机**上跑 scripts/cloud-run.sh，加超时、清理与跳过判定。
#
# 用法（云主机、仓库根）：
#   sh scripts/e2e-cloud.sh
#
# 本地没有 OpenShell/Docker 时**跳过**（exit 77），不假装通过：
#   SKIP: 远端 e2e 需要 OpenShell + Docker；本机没有，跳过（这是预期）。
#
# 环境变量：
#   ROOST_E2E_TIMEOUT   总超时秒数（默认 900）
#   ROOST_E2E_PORT      控制面端口（默认 8792）
#   ROOST_E2E_BUILD     1 = 先构建 roost/agent:dev 镜像（默认 0，用已有镜像）
#   ROOST_E2E_KEEP      1 = 保留临时 DB/日志（默认 0）
#   ROOST_RUNTIME_TOKEN 不设则随机生成；只在本进程环境里，不落盘、不打印
#   ROOST_DB            默认 /tmp/roost-e2e-$$.db（不碰仓库里的 data/）
#
# 退出码：0 通过 · 1 失败 · 77 跳过 · 124 超时
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 1

TIMEOUT="${ROOST_E2E_TIMEOUT:-900}"
PORT="${ROOST_E2E_PORT:-8792}"
KEEP="${ROOST_E2E_KEEP:-0}"
BUILD="${ROOST_E2E_BUILD:-0}"
DB="${ROOST_DB:-/tmp/roost-e2e-$$.db}"
LOG="/tmp/roost-e2e-$$.log"
API_LOG="/tmp/roost-cloud-api.log"
TIMED_OUT=0

skip() {
  echo "SKIP: $*"
  echo "SKIP: 远端 e2e 需要 OpenShell + Docker；本机没有，跳过（这是预期）。"
  echo "SKIP: 在云主机上跑：sh scripts/e2e-cloud.sh（或 workflow_dispatch 触发 e2e-remote）。"
  exit 77
}

# 只在需要时打印；密码/token 永远不打印。
echo "== e2e-cloud：$(hostname 2>/dev/null || echo host) $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
echo "   root=$ROOT port=$PORT timeout=${TIMEOUT}s db=$DB"

command -v node >/dev/null 2>&1 || skip "没有 node（需要 >= 22.18）"
command -v curl >/dev/null 2>&1 || skip "没有 curl"
command -v python3 >/dev/null 2>&1 || skip "没有 python3（cloud-run.sh 解析 JSON 用）"
command -v openshell >/dev/null 2>&1 || skip "没有 openshell CLI"
command -v docker >/dev/null 2>&1 || skip "没有 docker（OpenShell 需要）"

# 记录启动前已有的 API 进程，清理时只杀本次新起的，不误伤同机其他实例。
PIDS_BEFORE="$(pgrep -f 'apps/api/src/main.ts' 2>/dev/null | tr '\n' ' ')"

cleanup() {
  # 先停本次新起的控制面（cloud-run.sh 用 nohup，脚本退出不会带走它）。
  for pid in $(pgrep -f 'apps/api/src/main.ts' 2>/dev/null || true); do
    case " $PIDS_BEFORE " in
      *" $pid "*) ;;
      *) kill -TERM "$pid" 2>/dev/null || true ;;
    esac
  done
  sleep 1
  for pid in $(pgrep -f 'apps/api/src/main.ts' 2>/dev/null || true); do
    case " $PIDS_BEFORE " in
      *" $pid "*) ;;
      *) kill -KILL "$pid" 2>/dev/null || true ;;
    esac
  done
  if [ "$KEEP" = "1" ]; then
    echo "   keep: $DB $LOG $API_LOG"
  else
    rm -f "$DB" "$DB-wal" "$DB-shm" /tmp/roost-start.json
  fi
}
trap cleanup EXIT
trap 'echo "== 收到终止信号，停止 e2e"; TIMED_OUT=1' INT TERM

if [ "$BUILD" = "1" ]; then
  echo "== 0) 构建沙箱镜像 roost/agent:dev"
  if ! docker build -f apps/runtime/agent.Dockerfile -t roost/agent:dev . >>"$LOG" 2>&1; then
    echo "FAIL: docker build 失败；日志见 $LOG"
    tail -40 "$LOG" 2>/dev/null || true
    exit 1
  fi
fi

# cloud-run.sh 要求 token；每次随机，避免把长期凭据写进日志/环境快照。
if [ -z "${ROOST_RUNTIME_TOKEN:-}" ]; then
  ROOST_RUNTIME_TOKEN="rt_e2e_$(date +%s)_$$"
fi
ROOST_DB="$DB"
ROOST_CP_PORT="${ROOST_CP_PORT:-$PORT}"
ROOST_SANDBOX="${ROOST_SANDBOX:-openshell}"
export ROOST_RUNTIME_TOKEN ROOST_DB PORT ROOST_CP_PORT ROOST_SANDBOX

echo "== 1) 运行 cloud-run.sh（超时 ${TIMEOUT}s，输出见 $LOG）"
sh "$ROOT/scripts/cloud-run.sh" >"$LOG" 2>&1 &
RUNNER=$!
STARTED="$(date +%s)"
while kill -0 "$RUNNER" 2>/dev/null; do
  NOW="$(date +%s)"
  if [ "$TIMED_OUT" = "1" ] || [ $((NOW - STARTED)) -ge "$TIMEOUT" ]; then
    TIMED_OUT=1
    echo "TIMEOUT: 超过 ${TIMEOUT}s，停止本次 e2e"
    kill -TERM "$RUNNER" 2>/dev/null || true
    sleep 2
    kill -KILL "$RUNNER" 2>/dev/null || true
    break
  fi
  sleep 2
done
wait "$RUNNER" 2>/dev/null
RC=$?

if [ "$TIMED_OUT" = "1" ]; then
  echo "FAIL: 超时（${TIMEOUT}s）；最后 40 行："
  tail -40 "$LOG" 2>/dev/null || true
  exit 124
fi
if [ "$RC" -ne 0 ]; then
  echo "FAIL: cloud-run.sh 退出码 $RC；最后 40 行："
  tail -40 "$LOG" 2>/dev/null || true
  echo "  控制面日志：$API_LOG"
  exit 1
fi

# cloud-run.sh 成功时最后一行是 PASS；再确认一次，避免它半路 exit 0。
if ! grep -q '结果: PASS' "$LOG"; then
  echo "FAIL: cloud-run.sh 没有打印 PASS；最后 40 行："
  tail -40 "$LOG" 2>/dev/null || true
  exit 1
fi

echo "== PASS（$(($(date +%s) - STARTED))s）"
grep -E '^  (workspace|bots|runtime|round|浏览器|房间|结果)' "$LOG" 2>/dev/null || true
exit 0
