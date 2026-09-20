#!/usr/bin/env bash
# ColdStorage Master — API 스모크 테스트
#
#   ./test/smoke.sh                       # 일회용 DB로 서버를 직접 띄워 테스트 (기본)
#   BASE=https://coldstorage.agonyang.com ./test/smoke.sh   # 기존 서버 대상
#   PASSWORD=xxxx ./test/smoke.sh
#
# BASE 를 주지 않으면 임시 디렉토리에 새 DB 를 만들어 거기에만 쓴다.
# 실 데이터(data/)는 절대 건드리지 않는다 — 과거에 테스트가 실 테이블을 비운 적이 있다.

set -u

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
  DATA_DIR="$TMPDATA" PORT="$PORT" APP_PASSWORD="$PASSWORD" \
    node "$(dirname "$0")/../server.js" >"$TMPDATA/server.log" 2>&1 &
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

echo "대상: $BASE"
echo

# ── 인증 게이트 ─────────────────────────────────────────────
echo "[인증]"
check "미인증 페이지 -> 302"      302 "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/")"
check "미인증 API -> 401"         401 "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/dashboard")"
check "/login.html 공개 -> 200"   200 "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/login.html")"
check "틀린 비밀번호 -> 401"      401 "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/login" \
                                        -H 'Content-Type: application/json' -d '{"password":"__wrong__"}')"
curl -s -c "$CK" -o /dev/null -X POST "$BASE/api/login" \
     -H 'Content-Type: application/json' -d "{\"password\":\"$PASSWORD\"}"
check "로그인 후 API -> 200"      200 "$(code "$BASE/api/dashboard")"

# ── P0-2: 무인증 DoS ────────────────────────────────────────
echo
echo "[P0-2 무인증 DoS]"
check "GET /% -> 400"             400 "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/%")"
check "GET /%zz -> 400"           400 "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/%zz")"
check "  프로세스 생존"           200 "$(alive)"

# ── P0-3: 민감 파일 ─────────────────────────────────────────
echo
echo "[P0-3 민감 파일 차단]"
# 차단은 403(경로 거부) 또는 404(확장자 거부) 어느 쪽이든 통과로 본다
blocked() { c=$(code "$1"); { [ "$c" = "403" ] || [ "$c" = "404" ]; } && echo blocked || echo "$c"; }
check "/data/.session-secret"     blocked "$(blocked "$BASE/data/.session-secret")"
check "/data/coldstorage.db"      blocked "$(blocked "$BASE/data/coldstorage.db")"
check "/server.js"                blocked "$(blocked "$BASE/server.js")"
check "/package.json"             blocked "$(blocked "$BASE/package.json")"
check "/.gitignore"               blocked "$(blocked "$BASE/.gitignore")"
check "정상 파일은 그대로"        200 "$(code "$BASE/orders.html")"

# ── 테스트 주문 준비 ────────────────────────────────────────
echo
echo "[테스트 데이터 준비]"
STAMP="ZZSMOKE-$$"
body -X POST "$BASE/api/quotations" -H 'Content-Type: application/json' \
     -d "{\"no\":\"$STAMP\",\"date\":\"2026-01-01\",\"customer\":\"__smoke__\",\"order_status\":\"ordered\",\"total\":0,\"total_paid\":0}" >/dev/null
OID=$(body "$BASE/api/quotations" | jsonq "JSON.parse(s).filter(q=>q.no==='$STAMP').pop().id")
check "주문 생성됨" "true" "$([ -n "$OID" ] && echo true || echo false)"
[ -z "$OID" ] && { echo "주문을 만들지 못해 중단합니다."; exit 1; }

body -X PUT "$BASE/api/order_items/order/$OID" -H 'Content-Type: application/json' \
     -d '[{"name":"스모크품목","qty":10,"unit_price":1000}]' >/dev/null
IID=$(body "$BASE/api/order_items/order/$OID" | jsonq "JSON.parse(s)[0].id")
check "품목 생성됨" "true" "$([ -n "$IID" ] && echo true || echo false)"

# ── P0-4: FK / 품목 저장 ────────────────────────────────────
echo
echo "[P0-4 출고 이력 보존]"
check "출고 3개 등록 -> 200"      200 "$(code -X POST "$BASE/api/shipments" -H 'Content-Type: application/json' \
                                        -d "{\"order_id\":$OID,\"item_id\":$IID,\"qty\":3}")"
# 프론트와 동일하게 기존 품목의 id 를 포함해 보낸다
check "★ 출고 이력 있는 주문의 품목 저장 -> 200" 200 \
      "$(code -X PUT "$BASE/api/order_items/order/$OID" -H 'Content-Type: application/json' \
         -d "[{\"id\":$IID,\"name\":\"수정품목\",\"qty\":10,\"unit_price\":2000}]")"
check "  프로세스 생존"           200 "$(alive)"
check "  출고 이력 보존" "1" "$(body "$BASE/api/shipments/order/$OID" | jsonq 'JSON.parse(s).length')"
check "  품목 id 보존"    "$IID" "$(body "$BASE/api/order_items/order/$OID" | jsonq 'JSON.parse(s)[0].id')"
check "  shipped_qty 원장에서 재계산" "3" "$(body "$BASE/api/order_items/order/$OID" | jsonq 'JSON.parse(s)[0].shipped_qty')"
check "  총액 재계산(10*2000)" "20000" "$(body "$BASE/api/quotations" | jsonq "JSON.parse(s).find(q=>q.id===$OID).total")"
check "출고분보다 적게 줄이면 -> 400" 400 \
      "$(code -X PUT "$BASE/api/order_items/order/$OID" -H 'Content-Type: application/json' \
         -d "[{\"id\":$IID,\"name\":\"수정품목\",\"qty\":1,\"unit_price\":2000}]")"
check "출고 이력 있는 품목 삭제 -> 400" 400 \
      "$(code -X PUT "$BASE/api/order_items/order/$OID" -H 'Content-Type: application/json' -d '[]')"

# ── P0-6: 입력 검증 ─────────────────────────────────────────
echo
echo "[P0-6 입력 검증]"
check "음수 출고 -> 400"          400 "$(code -X POST "$BASE/api/shipments" -H 'Content-Type: application/json' \
                                        -d "{\"order_id\":$OID,\"item_id\":$IID,\"qty\":-5}")"
check "초과 출고 -> 400"          400 "$(code -X POST "$BASE/api/shipments" -H 'Content-Type: application/json' \
                                        -d "{\"order_id\":$OID,\"item_id\":$IID,\"qty\":9999}")"
check "남의 품목 출고 -> 400"     400 "$(code -X POST "$BASE/api/shipments" -H 'Content-Type: application/json' \
                                        -d "{\"order_id\":$OID,\"item_id\":999999,\"qty\":1}")"
check "잘못된 상태값 -> 400"      400 "$(code -X PATCH "$BASE/api/quotations/$OID/status" -H 'Content-Type: application/json' \
                                        -d '{"status":"__bogus__"}')"

# ── P0-7: 제네릭 라우트 ─────────────────────────────────────
echo
echo "[P0-7 제네릭 라우트 차단]"
# 주의: PUT /api/quotations 는 차단되기 전까지 테이블을 통째로 비운다.
# 빈 배열이 아니라 형식이 틀린 본문으로 "라우트가 사라졌는지"만 확인한다.
GEN=$(code -X PUT "$BASE/api/quotations" -H 'Content-Type: application/json' -d '"__notanarray__"')
check "PUT /api/quotations 차단"  "true" "$([ "$GEN" = "404" ] || [ "$GEN" = "405" ] && echo true || echo false)"
check "  quotations 테이블 생존"  "true" "$(body "$BASE/api/quotations" | jsonq 'JSON.parse(s).length>0')"
check "제네릭 PATCH 로 total 변조 차단" 405 \
      "$(code -X PATCH "$BASE/api/quotations/$OID" -H 'Content-Type: application/json' -d '{"total":999999999}')"

# ── P0-9: 회계·대시보드 정합성 ──────────────────────────────
echo
echo "[P0-9 회계 정합성]"
check "음수 입금 -> 400"          400 "$(code -X POST "$BASE/api/payments" -H 'Content-Type: application/json' \
                                        -d "{\"order_id\":$OID,\"amount\":-1000}")"
check "정상 입금 -> 200"          200 "$(code -X POST "$BASE/api/payments" -H 'Content-Type: application/json' \
                                        -d "{\"order_id\":$OID,\"amount\":5000}")"
check "출고 미완 주문 완료묶음 -> 400" 400 \
      "$(code -X POST "$BASE/api/completion-batches" -H 'Content-Type: application/json' \
         -d "{\"order_ids\":[$OID]}")"
check "취소 사유 없이 -> 400"     400 "$(code -X PATCH "$BASE/api/quotations/$OID/cancel" \
                                        -H 'Content-Type: application/json' -d '{"reason":"  "}')"
check "사유 있는 취소 -> 200"     200 "$(code -X PATCH "$BASE/api/quotations/$OID/cancel" \
                                        -H 'Content-Type: application/json' -d '{"reason":"스모크 테스트"}')"
check "취소건은 미수금에서 제외" "true" \
      "$(body "$BASE/api/dashboard" | jsonq "JSON.parse(s).workqueue.every(w=>w.id!==$OID)")"
check "취소된 주문 입금 -> 400"   400 "$(code -X POST "$BASE/api/payments" -H 'Content-Type: application/json' \
                                        -d "{\"order_id\":$OID,\"amount\":1000}")"
check "취소 해제 -> 200"          200 "$(code -X PATCH "$BASE/api/quotations/$OID/uncancel")"
check "이력 조회에 취소 기록"     "true" \
      "$(body "$BASE/api/quotations/$OID/history" | jsonq "JSON.parse(s).changes.some(c=>c.to_status==='cancelled')")"
check "대시보드 내부메모 미노출"  "true" \
      "$(body "$BASE/api/dashboard" | jsonq "JSON.parse(s).recent.every(r=>!('memo_internal' in r))")"

# ── 정리 ────────────────────────────────────────────────────
echo
echo "[정리]"
code -X DELETE "$BASE/api/quotations/$OID" >/dev/null
check "테스트 주문 삭제됨" "0" "$(body "$BASE/api/quotations" | jsonq "JSON.parse(s).filter(q=>q.no==='$STAMP').length")"


echo
printf '통과 %s / 실패 %s\n' "$(green "$PASS")" "$([ "$FAIL" -gt 0 ] && red "$FAIL" || echo "$FAIL")"
[ "$FAIL" -eq 0 ]
