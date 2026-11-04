#!/bin/sh
# 云端一键跑 M4：控制面 + 用户沙箱（room-agent）+ 两个 Bot 的房间对话。
#
# 前置（在云主机上，仓库根执行）：
#   * OpenShell gateway 可认证（openshell status → Authenticated）
#   * 镜像已构建：docker build -f apps/runtime/agent.Dockerfile -t roost/agent:dev .
#   * 环境变量：
#       ROOST_RUNTIME_TOKEN=<随机串>      控制面管理员级内部凭据（旧部署兼容）
#       ROOST_SANDBOX=openshell           （固定）
#       ROOST_CP_HOST=host.openshell.internal
#       ROOST_CP_PORT=<控制面端口，默认 8792>
#       ROOST_SANDBOX_IMAGE=roost/agent:dev
#       PORT=<控制面端口，默认 8792>
#       ROOST_DB=<sqlite 路径，默认 ./data/roost.db>
#
# E6 起沙箱不再继承这个全局 token：/start 会为每个 workspace 签发 24h 短 token，
# 通过 ROOST_RUNTIME_TOKEN 注入沙箱 env。云主机上的 ROOST_RUNTIME_TOKEN 只作为
# 控制面管理员凭据（运维面 / 旧部署兼容），轮换它不再需要重启所有沙箱。
#
# 用法： sh scripts/cloud-run.sh
# 结束后：浏览器打开 http://<云主机>:<PORT>/ ，用脚本打印的新配对码配对。
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 1

PORT="${PORT:-8792}"
CP_HOST="${ROOST_CP_HOST:-host.openshell.internal}"
CP_PORT="${ROOST_CP_PORT:-$PORT}"
TOKEN="${ROOST_RUNTIME_TOKEN:-}"
DB="${ROOST_DB:-$ROOT/data/roost.db}"
IMAGE="${ROOST_SANDBOX_IMAGE:-roost/agent:dev}"
BASE="http://127.0.0.1:$PORT"

[ -n "$TOKEN" ] || { echo "need ROOST_RUNTIME_TOKEN"; exit 2; }
command -v python3 >/dev/null || { echo "need python3"; exit 2; }

json() { python3 -c "import sys,json;d=json.load(sys.stdin);print(eval(sys.argv[1],{'d':d}))" "$1" 2>/dev/null; }
post() { curl -sS -m 30 -X POST "$BASE$1" -H 'content-type: application/json' ${2:+-H "authorization: Bearer $2"} -d "$3"; }
get()  { curl -sS -m 30 "$BASE$1" -H "authorization: Bearer $2"; }

echo "== 1) 启动控制面（SQLite + 沙箱管理）"
mkdir -p "$(dirname "$DB")"
pkill -f "apps/api/src/main.ts" 2>/dev/null
ROOST_HOST=0.0.0.0 ROOST_DB="$DB" ROOST_RUNTIME_TOKEN="$TOKEN" PORT="$PORT" \
ROOST_SANDBOX=openshell ROOST_CP_HOST="$CP_HOST" ROOST_CP_PORT="$CP_PORT" ROOST_SANDBOX_IMAGE="$IMAGE" \
nohup node --experimental-strip-types apps/api/src/main.ts > /tmp/roost-cloud-api.log 2>&1 &
sleep 2
head -1 /tmp/roost-cloud-api.log

echo "== 2) 配对与控制面资源"
ACCOUNT="acc_cloud_$(date +%s)"
CODE=$(post /api/pairing/code '' "{\"accountId\":\"$ACCOUNT\"}" | json "d['code']")
SESSION=$(post /api/pairing/claim '' "{\"code\":\"$CODE\"}" | json "d['sessionToken']")
printf '%s' "$SESSION" > /tmp/roost-cloud-session
chmod 600 /tmp/roost-cloud-session
WS=$(post /api/workspaces "$SESSION" '{"name":"云端验收"}' | json "d['workspace']['id']")
echo "  workspace=$WS"

BOT_A=$(post /api/bots "$SESSION" "{\"workspaceId\":\"$WS\",\"name\":\"研究员\",\"role\":\"选股\",\"model\":\"deepseek-chat\"}" | json "d['bot']['id']")
BOT_B=$(post /api/bots "$SESSION" "{\"workspaceId\":\"$WS\",\"name\":\"评审员\",\"role\":\"风控\",\"model\":\"deepseek-chat\"}" | json "d['bot']['id']")
ROOM=$(post /api/rooms "$SESSION" "{\"workspaceId\":\"$WS\",\"name\":\"云端验收\",\"memberBotIds\":[\"$BOT_A\",\"$BOT_B\"],\"hostBotId\":\"$BOT_A\",\"responder\":{\"kind\":\"everyone\"}}" | json "d['room']['id']")
echo "  bots=$BOT_A,$BOT_B room=$ROOM"

echo "== 3) 启动用户沙箱（room-agent 作为主进程）"
# 沙箱的 ROOST_RUNTIME_TOKEN 由控制面在这里签发（每 workspace 一个 24h 短 token），
# 不再沿用云主机 env 里的全局 token；响应里的 tokenId 只用于审计/回收，不是明文。
post "/api/workspaces/$WS/start" "$SESSION" '{}' > /tmp/roost-start.json
cat /tmp/roost-start.json | head -c 300; echo
START_TOKEN_ID=$(json "d.get('tokenId','')" < /tmp/roost-start.json)
echo "  sandbox runtime token issued: ${START_TOKEN_ID:-none (legacy global token)}"
for i in $(seq 1 60); do
  PHASE=$(get "/api/workspaces/$WS/runtime" "$SESSION" | json "d.get('runtime') and d['runtime']['phase'] or ''")
  [ "$PHASE" = "ready" ] && break
  sleep 3
done
echo "  runtime phase=$PHASE"

echo "== 4) 两个 Bot 的房间对话"
post "/api/rooms/$ROOM/messages" "$SESSION" '{"text":"请用一句话说今天盘前该看什么"}' >/dev/null
for i in $(seq 1 60); do
  COUNT=$(get "/api/rooms/$ROOM/messages" "$SESSION" | json "sum(1 for m in d['messages'] if m['actor']['kind']=='bot')")
  [ "${COUNT:-0}" -ge 2 ] && break
  sleep 3
done
get "/api/rooms/$ROOM/messages" "$SESSION" | python3 -c '
import sys, json
for m in json.load(sys.stdin)["messages"]:
    kind = m["actor"]["kind"]
    text = m["text"][:120].replace(chr(10), " ")
    print("  [" + kind + "] " + text)
'
ROUND_STATE=$(get "/api/rooms/$ROOM" "$SESSION" | json "d.get('round') and d['round']['state'] or 'none'")

MEMORY="skip"
SB=$(openshell sandbox list 2>/dev/null | awk -v n="$WS" 'NR>1 && $1 ~ /^user-/ {print $1; exit}')
if [ "${ROOST_CHECK_MEMORY:-0}" = "1" ] && [ -n "$SB" ]; then
  echo "== 5) 多轮记忆 + stop/start =="
  ask() { post "/api/rooms/$ROOM/messages" "$SESSION" "{\"text\":\"$1\"}" >/dev/null; }
  wait_bots() {
    for i in $(seq 1 60); do
      C=$(get "/api/rooms/$ROOM/messages" "$SESSION" | json "sum(1 for m in d['messages'] if m['actor']['kind']=='bot')")
      [ "${C:-0}" -ge "$1" ] && return 0
      sleep 3
    done
    return 1
  }
  ask "请记住这个数字：4271。"; wait_bots 3 || true
  ask "我刚才让你记住的数字是多少？只回答数字。"; wait_bots 4 || true
  FIRST=$(get "/api/rooms/$ROOM/messages" "$SESSION" | json "d['messages'][-1]['text']" || true)
  echo "  before restart: $FIRST"
  openshell sandbox stop "$SB" >/dev/null 2>&1
  # 等 stop 真正落定再 start；否则 OpenShell 会报 concurrent modification 并进 Error。
  for i in $(seq 1 30); do
    P=$(openshell sandbox list 2>/dev/null | awk -v n="$SB" '$1 == n {print $NF}')
    [ "$P" = "Stopped" ] && break
    sleep 2
  done
  sleep 3
  post "/api/workspaces/$WS/start" "$SESSION" '{}' >/dev/null
  for i in $(seq 1 60); do
    P=$(get "/api/workspaces/$WS/runtime" "$SESSION" | json "d.get('runtime') and d['runtime']['phase'] or ''")
    [ "$P" = "ready" ] && break
    sleep 3
  done
  echo "\n  restart phase=$P"
  ask "重启之后：我刚才让你记住的数字是多少？只回答数字。"; wait_bots 5 || true
  AFTER=$(get "/api/rooms/$ROOM/messages" "$SESSION" | json "d['messages'][-1]['text']" || true)
  echo "  after restart:  $AFTER"
  # 重启后的回答里必须还能看到 4271；重启前的回答可能只是"好的"，不作为硬条件。
  case "$AFTER" in
    *4271*) MEMORY="pass" ;;
    *) MEMORY="fail" ;;
  esac
  echo "  memory=$MEMORY"
fi
echo "  round=$ROUND_STATE"

WEB_CODE=$(curl -sS -m 10 -X POST "$BASE/api/pairing/code" -H 'content-type: application/json' -H "authorization: Bearer $SESSION" -d "{\"accountId\":\"$ACCOUNT\"}" | json "d.get('code','')")
echo
echo "== 完成"
echo "  浏览器: http://<云主机>:$PORT/  配对码: $WEB_CODE"
echo "  房间:   $ROOM"
echo "  session: /tmp/roost-cloud-session（用于继续验证，600 权限）"
if [ "${COUNT:-0}" -ge 2 ] && [ "$ROUND_STATE" = "done" ] && [ "$MEMORY" != "fail" ]; then
  echo "  结果: PASS（两个 Bot 都回复，轮次 done；memory=${MEMORY}）"
  exit 0
fi
echo "  结果: 未达成（检查 /tmp/roost-cloud-api.log、openshell logs、镜像）"
exit 1
