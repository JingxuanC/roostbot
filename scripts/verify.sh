#!/bin/sh
# Lead 的验收脚本：跑全部测试 + 起 API 打一遍真实 HTTP。
# 用法：sh scripts/verify.sh 或 bash scripts/verify.sh（POSIX，dash 也能跑）
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 1
NODE=node
command -v node >/dev/null 2>&1 || { echo "need node on PATH"; exit 1; }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/roost-verify.XXXXXX")"
API_PID=""
WORKER_PID=""
cleanup() {
  if [ -n "$API_PID" ]; then kill "$API_PID" 2>/dev/null || true; fi
  if [ -n "$WORKER_PID" ]; then kill "$WORKER_PID" 2>/dev/null || true; fi
  rm -rf "$TMP"
}
trap cleanup EXIT INT TERM

echo "== 1) 全部测试"
set --
found=0
for dir in packages apps; do
  [ -d "$dir" ] || continue
  for f in "$dir"/*/test/*.test.ts; do
    [ -f "$f" ] || continue
    set -- "$@" "$f"
    found=1
  done
done
if [ "$found" -eq 0 ]; then
  echo "  (没有找到测试文件)"
  TEST_RC=0
else
  $NODE --experimental-strip-types --test "$@" >"$TMP/test.log" 2>&1
  TEST_RC=$?
  tail -12 "$TMP/test.log"
fi

echo
echo "== 2) API 冒烟（真实 HTTP）"
BOT_FAIL=0
if [ -f apps/api/src/main.ts ]; then
  PORT=$(python3 -c "import random;print(random.randint(18000,19999))")
  RUNTIME_TOKEN="rt_verify_$(date +%s)"
  ROOST_RUNTIME_TOKEN="$RUNTIME_TOKEN" ROOST_DB="$TMP/roost.db" PORT=$PORT $NODE --experimental-strip-types apps/api/src/main.ts >"$TMP/api.log" 2>&1 &
  API_PID=$!
  sleep 2
  base="http://127.0.0.1:$PORT"
  printf '  healthz   : '; curl -sS -m 5 -o "$TMP/h.json" -w '%{http_code} ' "$base/healthz"; head -c 80 "$TMP/h.json"; echo
  printf '  pairing   : '; curl -sS -m 5 -o "$TMP/p.json" -w '%{http_code} ' -X POST "$base/api/pairing/code" -H 'content-type: application/json' -d '{"accountId":"acc_1"}'; head -c 120 "$TMP/p.json"; echo
  CODE=$(python3 -c "import json;print(json.load(open('$TMP/p.json')).get('code',''))" 2>/dev/null)
  printf '  claim     : '; curl -sS -m 5 -o "$TMP/c.json" -w '%{http_code} ' -X POST "$base/api/pairing/claim" -H 'content-type: application/json' -d "{\"code\":\"$CODE\"}"; head -c 120 "$TMP/c.json"; echo
  TOKEN=$(python3 -c "import json;print(json.load(open('$TMP/c.json')).get('sessionToken',''))" 2>/dev/null)
  printf '  workspaces: '; curl -sS -m 5 -o "$TMP/w.json" -w '%{http_code} ' "$base/api/workspaces" -H "authorization: Bearer $TOKEN"; head -c 120 "$TMP/w.json"; echo
  printf '  no token  : '; curl -sS -m 5 -o "$TMP/n.json" -w '%{http_code} ' "$base/api/workspaces"; head -c 80 "$TMP/n.json"; echo
  WSID=$(python3 -c "import json;d=json.load(open('$TMP/w.json'));print(d['workspaces'][0]['id'] if d.get('workspaces') else '')" 2>/dev/null)
  if [ -z "$WSID" ]; then
    curl -sS -m 5 -o "$TMP/wc.json" -X POST "$base/api/workspaces" -H 'content-type: application/json' -H "authorization: Bearer $TOKEN" -d '{"name":"我的工作区"}' >/dev/null
    WSID=$(python3 -c "import json;print(json.load(open('$TMP/wc.json'))['workspace']['id'])" 2>/dev/null)
  fi
  printf '  room      : '; curl -sS -m 5 -o "$TMP/rc.json" -w '%{http_code} ' -X POST "$base/api/rooms" -H 'content-type: application/json' -H "authorization: Bearer $TOKEN" -d "{\"workspaceId\":\"$WSID\",\"name\":\"量化研究组\"}"; head -c 100 "$TMP/rc.json"; echo
  ROOMID=$(python3 -c "import json;print(json.load(open('$TMP/rc.json'))['room']['id'])" 2>/dev/null)
  printf '  message   : '; curl -sS -m 5 -o "$TMP/mc.json" -w '%{http_code} ' -X POST "$base/api/rooms/$ROOMID/messages" -H 'content-type: application/json' -H "authorization: Bearer $TOKEN" -d '{"text":"盘前看一下异动"}'; head -c 100 "$TMP/mc.json"; echo
  printf '  messages  : '; curl -sS -m 5 -o "$TMP/mr.json" -w '%{http_code} ' "$base/api/rooms/$ROOMID/messages" -H "authorization: Bearer $TOKEN"; head -c 140 "$TMP/mr.json"; echo
  printf '  internal  : '; curl -sS -m 5 -o "$TMP/ir.json" -w '%{http_code} ' "$base/api/internal/rooms" -H "x-runtime-token: $RUNTIME_TOKEN"; head -c 80 "$TMP/ir.json"; echo

  # Bot 回合：起 room-agent（没有成员时走单 Bot 回退），新消息应收到 Bot 回复。
  ROOST_API="$base" ROOST_RUNTIME_TOKEN="$RUNTIME_TOKEN" ROOST_BOT_ID=selector \
    ROOST_WORKSPACE_ID="$WSID" ROOST_DSH_BIN="$ROOT/apps/runtime/test/fake-dsh.mjs" \
    $NODE --experimental-strip-types apps/runtime/room-agent.mjs >"$TMP/room-agent.log" 2>&1 &
  WORKER_PID=$!
  curl -sS -m 5 -o /dev/null -X POST "$base/api/rooms/$ROOMID/messages" -H 'content-type: application/json' -H "authorization: Bearer $TOKEN" -d '{"text":"第二句：Bot 会回我吗"}'
  BOT_OK=""
  i=1
  while [ "$i" -le 10 ]; do
    BOT_OK=$(curl -sS -m 5 "$base/api/rooms/$ROOMID/messages" -H "authorization: Bearer $TOKEN" | python3 -c "import sys,json;d=json.load(sys.stdin);print('yes' if any(m['actor']['kind']=='bot' for m in d['messages']) else '')" 2>/dev/null)
    [ "$BOT_OK" = "yes" ] && break
    sleep 0.4
    i=$((i + 1))
  done
  printf '  bot reply : %s\n' "${BOT_OK:-no}"
  if [ "$BOT_OK" != "yes" ]; then
    BOT_FAIL=1
    echo "----- room-agent.log -----"
    cat "$TMP/room-agent.log" 2>/dev/null || true
  fi
  kill $WORKER_PID 2>/dev/null || true
  kill "$API_PID" 2>/dev/null || true
  wait "$API_PID" 2>/dev/null || true
  WORKER_PID=""
  API_PID=""
else
  echo "  (apps/api/src/main.ts 不存在，跳过)"
fi

echo
echo "== 3) 总结"
if [ "$TEST_RC" = "0" ]; then echo "  tests: ok"; else echo "  tests: FAILED"; fi
if [ "$BOT_FAIL" = "1" ]; then
  echo "  bot reply: FAILED"
  exit 1
fi
exit "$TEST_RC"
