#!/usr/bin/env bash
# ColdStorage Master — 테스트 공통 하네스
#
# smoke.sh(엔드포인트 단위)와 scenarios.sh(업무 흐름) 가 함께 쓴다.
# 부트스트랩을 양쪽에 복붙하면 한쪽만 고쳐져 갈라진다 — 이 저장소에서 이미
# 여러 번 겪었다(STATUS_LABEL 5벌, clearFilters 4벌).
#
#   . "$(dirname "$0")/lib.sh"
#   login
#   check "설명" 기대값 "$(실제값)"
#   summary            # 마지막에 호출. 실패가 있으면 종료코드 1
#
# BASE 를 주지 않으면 임시 디렉토리에 새 DB 를 만들어 거기에만 쓴다.
# 실 데이터(data/)는 절대 건드리지 않는다 — 과거에 테스트가 실 테이블을 비운 적이 있다.

set -u

USERNAME="${USERNAME:-admin}"
PASSWORD="${PASSWORD:-0000}"
CK="$(mktemp)"
PASS=0; FAIL=0
OWN_SERVER=""
TMPDATA=""

cleanup() {
  if [ -n "$OWN_SERVER" ]; then kill "$OWN_SERVER" 2>/dev/null; sleep 1; fi
  [ -n "$TMPDATA" ] && rm -rf "$TMPDATA" 2>/dev/null
  rm -f "$CK"
  return 0
}
trap cleanup EXIT

if [ -z "${BASE:-}" ]; then
  TMPDATA="$(mktemp -d)"
  PORT=$(( 19000 + (RANDOM % 1000) ))
  BASE="http://localhost:$PORT"
  echo "일회용 서버 기동 — DATA_DIR=$TMPDATA PORT=$PORT"
  DATA_DIR="$TMPDATA" PORT="$PORT" ADMIN_USER="$USERNAME" ADMIN_PASSWORD="$PASSWORD" \
    node "$(dirname "${BASH_SOURCE[0]}")/../server.js" >"$TMPDATA/server.log" 2>&1 &
  OWN_SERVER=$!
  for _ in $(seq 1 30); do
    curl -s -o /dev/null "$BASE/login.html" && break
    sleep 0.3
  done
fi

red()   { printf '\033[31m%s\033[0m' "$1"; }
green() { printf '\033[32m%s\033[0m' "$1"; }

# check <설명> <기대값> <실제값>
check() {
  if [ "$2" = "$3" ]; then PASS=$((PASS+1)); printf '  %s %s\n' "$(green ok)" "$1"
  else FAIL=$((FAIL+1)); printf '  %s %s (기대 %s, 실제 %s)\n' "$(red FAIL)" "$1" "$2" "$3"; fi
}

code()  { curl -s -b "$CK" -o /dev/null -w '%{http_code}' "$@"; }
body()  { curl -s -b "$CK" "$@"; }
jsonq() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(($1))}catch{console.log('')}})"; }

alive() { curl -s -o /dev/null -w '%{http_code}' "$BASE/login.html"; }

# 쿠키를 $CK 에 받아 둔다. 이후 code/body 가 자동으로 붙여 보낸다.
login() {
  curl -s -c "$CK" -o /dev/null -X POST "$BASE/api/login" \
       -H 'Content-Type: application/json' \
       -d "{\"username\":\"${1:-$USERNAME}\",\"password\":\"${2:-$PASSWORD}\"}"
}

summary() {
  echo
  printf '통과 %s / 실패 %s\n' "$(green "$PASS")" "$([ "$FAIL" -gt 0 ] && red "$FAIL" || echo "$FAIL")"
  [ "$FAIL" -eq 0 ]
}
