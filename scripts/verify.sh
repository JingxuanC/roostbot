#!/bin/sh
# Lead 的验收脚本：跑全部测试 + 起 API 打一遍真实 HTTP。
# 用法：sh scripts/verify.sh
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 1
NODE=node
command -v node >/dev/null 2>&1 || { echo "need node on PATH"; exit 1; }

echo "== 1) 全部测试"
TEST_GLOBS=""
for dir in packages apps; do
  [ -d "$dir" ] || continue
  TEST_GLOBS="$TEST_GLOBS $(ls -d "$dir"/*/test/*.test.ts 2>/dev/null)"
done
if [ -z "${TEST_GLOBS// /}" ]; then
  echo "  (没有找到测试文件)"
  TEST_RC=0
else
  # shellcheck disable=SC2086
  $NODE --experimental-strip-types --test $TEST_GLOBS 2>&1 | tail -12
  TEST_RC=$?
fi

echo
echo "== 2) API 冒烟（真实 HTTP）"
if [ -f apps/api/src/main.ts ]; then
  PORT=$(python3 -c "import random;print(random.randint(18000,19999))")
  ROOST_DB=/tmp/roost-verify-$$.db PORT=$PORT $NODE --experimental-strip-types apps/api/src/main.ts >/tmp/roost-api.log 2>&1 &
  API_PID=$!
  sleep 2
  base="http://127.0.0.1:$PORT"
  printf '  healthz   : '; curl -sS -m 5 -o /tmp/h.json -w '%{http_code} ' "$base/healthz"; head -c 80 /tmp/h.json; echo
  printf '  pairing   : '; curl -sS -m 5 -o /tmp/p.json -w '%{http_code} ' -X POST "$base/api/pairing/code" -H 'content-type: application/json' -d '{"accountId":"acc_1"}'; head -c 120 /tmp/p.json; echo
  CODE=$(python3 -c "import json;print(json.load(open('/tmp/p.json')).get('code',''))" 2>/dev/null)
  printf '  claim     : '; curl -sS -m 5 -o /tmp/c.json -w '%{http_code} ' -X POST "$base/api/pairing/claim" -H 'content-type: application/json' -d "{\"code\":\"$CODE\"}"; head -c 120 /tmp/c.json; echo
  TOKEN=$(python3 -c "import json;print(json.load(open('/tmp/c.json')).get('sessionToken',''))" 2>/dev/null)
  printf '  workspaces: '; curl -sS -m 5 -o /tmp/w.json -w '%{http_code} ' "$base/api/workspaces" -H "authorization: Bearer $TOKEN"; head -c 120 /tmp/w.json; echo
  printf '  no token  : '; curl -sS -m 5 -o /tmp/n.json -w '%{http_code} ' "$base/api/workspaces"; head -c 80 /tmp/n.json; echo
  kill "$API_PID" 2>/dev/null
  wait "$API_PID" 2>/dev/null
else
  echo "  (apps/api/src/main.ts 不存在，跳过)"
fi

echo
echo "== 3) 总结"
[ "$TEST_RC" = "0" ] && echo "  tests: ok" || echo "  tests: FAILED"
exit "$TEST_RC"
