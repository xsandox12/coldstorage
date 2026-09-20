#!/usr/bin/env bash
# ColdStorage Master — API 스모크 테스트
#
#   ./test/smoke.sh                       # localhost:9000
#   BASE=https://coldstorage.agonyang.com ./test/smoke.sh
#   PASSWORD=xxxx ./test/smoke.sh
#
# 테스트 데이터는 no 가 ZZSMOKE- 로 시작하며 끝나면 지운다.

set -u

BASE="${BASE:-http://localhost:9000}"
PASSWORD="${PASSWORD:-0000}"
CK="$(mktemp)"
PASS=0; FAIL=0

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
check "/data/.session-secret"     403 "$(code "$BASE/data/.session-secret")"
check "/data/coldstorage.db"      403 "$(code "$BASE/data/coldstorage.db")"
check "/server.js"                404 "$(code "$BASE/server.js")"
check "/package.json"             404 "$(code "$BASE/package.json")"
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
check "★ 출고 이력 있는 주문의 품목 저장 -> 200" 200 \
      "$(code -X PUT "$BASE/api/order_items/order/$OID" -H 'Content-Type: application/json' \
         -d '[{"name":"수정품목","qty":10,"unit_price":2000}]')"
check "  프로세스 생존"           200 "$(alive)"
check "  출고 이력 보존" "1" "$(body "$BASE/api/shipments/order/$OID" | jsonq 'JSON.parse(s).length')"

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

# ── 정리 ────────────────────────────────────────────────────
echo
echo "[정리]"
code -X DELETE "$BASE/api/quotations/$OID" >/dev/null
check "테스트 주문 삭제됨" "0" "$(body "$BASE/api/quotations" | jsonq "JSON.parse(s).filter(q=>q.no==='$STAMP').length")"
rm -f "$CK"

echo
printf '통과 %s / 실패 %s\n' "$(green "$PASS")" "$([ "$FAIL" -gt 0 ] && red "$FAIL" || echo "$FAIL")"
[ "$FAIL" -eq 0 ]
