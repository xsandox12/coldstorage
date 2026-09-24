#!/usr/bin/env bash
# ColdStorage Master — API 스모크 테스트 (엔드포인트 단위)
#
#   ./test/smoke.sh                       # 일회용 DB로 서버를 직접 띄워 테스트 (기본)
#   BASE=https://coldstorage.agonyang.com ./test/smoke.sh   # 기존 서버 대상
#   USERNAME=admin PASSWORD=xxxx ./test/smoke.sh
#
# 업무 흐름을 순서대로 잇는 테스트는 scenarios.sh 에 있다.

. "$(dirname "$0")/lib.sh"

echo "대상: $BASE"
echo

# ── 인증 게이트 ─────────────────────────────────────────────
echo "[인증]"
check "미인증 페이지 -> 302"      302 "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/")"
check "미인증 API -> 401"         401 "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/dashboard")"
check "/login.html 공개 -> 200"   200 "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/login.html")"
check "틀린 비밀번호 -> 401"      401 "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/login" \
                                        -H 'Content-Type: application/json' -d "{\"username\":\"$USERNAME\",\"password\":\"__wrong__\"}")"
check "없는 아이디 -> 401"        401 "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/login" \
                                        -H 'Content-Type: application/json' -d "{\"username\":\"__nobody__\",\"password\":\"$PASSWORD\"}")"
login
check "로그인 후 API -> 200"      200 "$(code "$BASE/api/dashboard")"
check "/api/me 가 사용자 반환"    "$USERNAME" "$(body "$BASE/api/me" | jsonq 'JSON.parse(s).username')"

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
# total 은 부가세 포함 합계다 (total_paid 가 실입금액이라 세포함이어야 미수금이 맞는다)
check "  공급가액 재계산(10*2000)" "20000" "$(body "$BASE/api/quotations" | jsonq "JSON.parse(s).find(q=>q.id===$OID).supply_amount")"
check "  합계는 부가세 포함 22000"  "22000" "$(body "$BASE/api/quotations" | jsonq "JSON.parse(s).find(q=>q.id===$OID).total")"
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
# 클라이언트 키가 컬럼명에 그대로 보간돼 모르는 키는 SQL 오류(500)를 냈다
CUSTID=$(body "$BASE/api/customers" | jsonq 'JSON.parse(s)[0].id')
check "모르는 컬럼 무시 (500 아님)" 200 \
      "$(code -X PATCH "$BASE/api/customers/$CUSTID" -H 'Content-Type: application/json' \
         -d '{"__nope__":1,"nested":{"a":1}}')"
check "  프로세스 생존"           200 "$(alive)"
check "빈 PATCH -> 400 (starred 주입 안 함)" 400 \
      "$(code -X PATCH "$BASE/api/customers/$CUSTID" -H 'Content-Type: application/json' -d '{}')"
# users 는 TABLES 에 없다. 전용 경로만 열려 있고 해시는 절대 나가면 안 된다.
check "users 목록에 해시 미노출" "true" \
      "$(body "$BASE/api/users" | jsonq "!/password_hash|salt/.test(s)")"
check "users 제네릭 PUT 차단" 404 \
      "$(code -X PUT "$BASE/api/users/1" -H 'Content-Type: application/json' -d '{"role":"admin"}')"
check "users 제네릭 DELETE 차단" 404 "$(code -X DELETE "$BASE/api/users/1")"

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
check "  해제 후 원장 기준 partial" "partial" \
      "$(body "$BASE/api/quotations" | jsonq "JSON.parse(s).find(q=>q.id===$OID).order_status")"
check "이력 조회에 취소 기록"     "true" \
      "$(body "$BASE/api/quotations/$OID/history" | jsonq "JSON.parse(s).changes.some(c=>c.to_status==='cancelled')")"
# 출고 이력이 없으면 autoStatus 가 복구해주지 않는다. 그래서 해제를 무조건 draft 로 하면
# tracksUnpaid 가 draft 를 제외하므로 계약금만 받은 주문의 미수금이 증발한다.
STAMP2="ZZSMOKE2-$$"
body -X POST "$BASE/api/quotations" -H 'Content-Type: application/json' \
     -d "{\"no\":\"$STAMP2\",\"date\":\"2026-01-01\",\"customer\":\"__smoke__\"}" >/dev/null
OID2=$(body "$BASE/api/quotations" | jsonq "JSON.parse(s).filter(q=>q.no==='$STAMP2').pop().id")
body -X PUT "$BASE/api/order_items/order/$OID2" -H 'Content-Type: application/json' \
     -d '[{"name":"미출고품목","qty":5,"unit_price":10000}]' >/dev/null
# 새 주문은 항상 draft 로 시작한다. 상태는 전이 검사를 거쳐서만 올라간다.
code -X PATCH "$BASE/api/quotations/$OID2/status" -H 'Content-Type: application/json' -d '{"status":"ordered"}' >/dev/null
code -X PATCH "$BASE/api/quotations/$OID2/cancel" -H 'Content-Type: application/json' \
     -d '{"reason":"출고전 취소"}' >/dev/null
code -X PATCH "$BASE/api/quotations/$OID2/uncancel" >/dev/null
check "★ 출고 없는 주문 해제 -> ordered 복원" "ordered" \
      "$(body "$BASE/api/quotations" | jsonq "JSON.parse(s).find(q=>q.id===$OID2).order_status")"
check "  해제 후 미수금에 다시 잡힘" "true" \
      "$(body "$BASE/api/dashboard" | jsonq 'JSON.parse(s).kpi.totalUnpaid >= 50000')"
code -X DELETE "$BASE/api/quotations/$OID2" >/dev/null

check "대시보드 내부메모 미노출"  "true" \
      "$(body "$BASE/api/dashboard" | jsonq "JSON.parse(s).recent.every(r=>!('memo_internal' in r))")"

# ── Phase 4: 도면 통합 ──────────────────────────────────────
echo
echo "[Phase 4 도면]"
check "도면 앱 서빙"              200 "$(code "$BASE/drawing_app.html")"
check "  drawing_base.js"         200 "$(code "$BASE/drawing_base.js")"
check "  drawing_checkplate.js"   200 "$(code "$BASE/drawing_checkplate.js")"
check "죽은 gallery.html 제거"    404 "$(code "$BASE/gallery.html")"
check "죽은 viewer3d.html 제거"   404 "$(code "$BASE/viewer3d.html")"
check "★ 도면 앱이 구조화된 BOM 을 보냄" "true" \
      "$(body "$BASE/drawing_app.html" | grep -q 'items:     bomToItems()' && echo true || echo false)"
check "  ?load= 로 도면 이어 열기" "true" \
      "$(body "$BASE/drawing_app.html" | grep -q "get('load')" && echo true || echo false)"
# 함수가 있다고 쓸 수 있는 건 아니다 — 실제로 이걸 부르는 버튼이 없어서
# 배관은 멀쩡한데 화면에서는 도달할 수 없던 적이 있다.
check "★ 견적서로 보내는 버튼이 실제로 있음" "true" \
      "$(body "$BASE/drawing_app.html" | grep -qE 'onclick="[^\"]*sendBOMToParent' && echo true || echo false)"
check "  견적에서 열었을 때만 보임" "true" \
      "$(body "$BASE/drawing_app.html" | grep -q "send-bom-btn" && echo true || echo false)"
check "drawing_id 기록 -> 200"    200 "$(code -X PATCH "$BASE/api/quotations/$OID/drawing" \
                                        -H 'Content-Type: application/json' -d '{"drawing_id":"12345"}')"
check "  실제로 저장됨"           "12345" \
      "$(body "$BASE/api/quotations" | jsonq "JSON.parse(s).find(q=>q.id===$OID).drawing_id")"
check "없는 주문의 drawing -> 404" 404 "$(code -X PATCH "$BASE/api/quotations/999999/drawing" \
                                        -H 'Content-Type: application/json' -d '{"drawing_id":"1"}')"
# 도면 저장소는 SaaS 가 서빙할 때만 동작한다 (drawingtool.agonyang.com 은 정적 서빙)
DRAWID="9$$"
check "도면 저장 -> 200"          200 "$(code -X POST "$BASE/api/drawings" -H 'Content-Type: application/json' \
                                        -d "{\"id\":$DRAWID,\"name\":\"smoke\",\"starred\":false,\"state\":{\"w\":5000}}")"
check "  다시 읽힘"               "true" \
      "$(body "$BASE/api/drawings" | jsonq "JSON.parse(s).some(d=>Number(d.id)===$DRAWID)")"
check "  state 보존"              5000 "$(body "$BASE/api/drawings" | jsonq "(d=>d&&d.state?d.state.w:'')(JSON.parse(s).find(x=>Number(x.id)===$DRAWID))")"
# 숫자 id 가 TEXT PK 에 "…​.0" 으로 저장되면 아래 두 개가 영영 맞지 않는다
check "  id 가 소수점 없이 저장"  "$DRAWID" \
      "$(body "$BASE/api/drawings" | jsonq "String(JSON.parse(s).find(d=>Number(d.id)===$DRAWID).id)")"
code -X PATCH "$BASE/api/drawings/$DRAWID" -H 'Content-Type: application/json' -d '{}' >/dev/null
check "★ 즐겨찾기 토글"           "true" \
      "$(body "$BASE/api/drawings" | jsonq "JSON.parse(s).find(d=>Number(d.id)===$DRAWID).starred")"
code -X DELETE "$BASE/api/drawings/$DRAWID" >/dev/null
check "  삭제됨"                  "true" \
      "$(body "$BASE/api/drawings" | jsonq "JSON.parse(s).every(d=>Number(d.id)!==$DRAWID)")"

# ── Phase 3: 검색 · 페이지네이션 · 내보내기 · 인쇄 ──────────
echo
echo "[Phase 3 목록 조회]"
check "파라미터 없으면 배열"      "true" "$(body "$BASE/api/quotations" | jsonq 'Array.isArray(JSON.parse(s))')"
check "파라미터 있으면 봉투"      "true" \
      "$(body "$BASE/api/quotations?limit=1" | jsonq "(o=>!Array.isArray(o)&&'rows' in o&&'total' in o)(JSON.parse(s))")"
check "limit 적용"                1 "$(body "$BASE/api/quotations?limit=1" | jsonq 'JSON.parse(s).rows.length')"
check "  total 은 전체 건수"      "true" \
      "$(body "$BASE/api/quotations?limit=1" | jsonq 'JSON.parse(s).total > 1')"
check "limit 상한 500"            500 "$(body "$BASE/api/quotations?limit=99999" | jsonq 'JSON.parse(s).limit')"
check "검색어로 좁혀짐"           "true" \
      "$(body "$BASE/api/quotations?q=$STAMP" | jsonq "JSON.parse(s).rows.every(r=>r.no==='$STAMP')")"
# 검색어는 ASCII 로 — Git Bash 에서 한글을 URL 에 실으면 콘솔 인코딩에 따라 깨진다
check "없는 검색어 -> 0건"        0 "$(body "$BASE/api/quotations?q=__NOMATCH__" | jsonq 'JSON.parse(s).total')"
check "여러 토큰은 모두 포함해야"  0 "$(body "$BASE/api/quotations?q=$STAMP+__NOMATCH__" | jsonq 'JSON.parse(s).total')"
check "상태 필터"                 "true" \
      "$(body "$BASE/api/quotations?status=done" | jsonq "JSON.parse(s).rows.every(r=>r.order_status==='done')")"
check "기간 필터"                 "true" \
      "$(body "$BASE/api/quotations?from=2030-01-01" | jsonq 'JSON.parse(s).total===0')"
check "★ 임의 sort 는 무시(인젝션)" 200 "$(code "$BASE/api/quotations?sort=id);DROP+TABLE+quotations--")"
check "  quotations 테이블 생존"  "true" "$(body "$BASE/api/quotations" | jsonq 'JSON.parse(s).length>0')"
check "  프로세스 생존"           200 "$(alive)"

echo
echo "[Phase 3 CSV 내보내기]"
CSV=$(body "$BASE/api/export/quotations?limit=5")
check "★ UTF-8 BOM 으로 시작"     "true" "$(printf '%s' "$CSV" | head -c 3 | od -An -tx1 | tr -d ' \n' | grep -q '^efbbbf$' && echo true || echo false)"
check "머리글에 공급가액"          "true" "$(printf '%s' "$CSV" | head -1 | grep -q '공급가액' && echo true || echo false)"
check "★ 내부메모는 내보내지 않음" "true" "$(printf '%s' "$CSV" | grep -qi 'memo_internal' && echo false || echo true)"
check "내보낼 수 없는 리소스 -> 404" 404 "$(code "$BASE/api/export/drawings")"

echo
echo "[Phase 3 인쇄 데이터]"
check "인쇄 데이터 -> 200"        200 "$(code "$BASE/api/print/quotations/$OID")"
check "  ★ 내부메모 제외"         "true" \
      "$(body "$BASE/api/print/quotations/$OID" | jsonq "!('memo_internal' in JSON.parse(s).order)")"
check "  공급자 정보 포함"        "true" \
      "$(body "$BASE/api/print/quotations/$OID" | jsonq '!!JSON.parse(s).company')"
check "  품목·출고·입금 포함"     "true" \
      "$(body "$BASE/api/print/quotations/$OID" | jsonq "(o=>['items','shipments','payments'].every(k=>Array.isArray(o[k])))(JSON.parse(s))")"
check "없는 주문 -> 404"          404 "$(code "$BASE/api/print/quotations/999999")"

echo
echo "[Phase 3 출고 취소]"
SHIPID=$(body "$BASE/api/shipments/order/$OID" | jsonq 'JSON.parse(s)[0].id')
check "출고 취소 -> 200"          200 "$(code -X DELETE "$BASE/api/shipments/$SHIPID")"
check "★ shipped_qty 원장에서 재계산" 0 "$(body "$BASE/api/order_items/order/$OID" | jsonq 'JSON.parse(s)[0].shipped_qty')"
check "  전부 취소되면 ordered 복귀" "ordered" \
      "$(body "$BASE/api/quotations" | jsonq "JSON.parse(s).find(q=>q.id===$OID).order_status")"
check "없는 출고 취소 -> 404"     404 "$(code -X DELETE "$BASE/api/shipments/999999")"
# 이후 항목이 출고 이력을 전제하므로 되돌려 둔다
body -X POST "$BASE/api/shipments" -H 'Content-Type: application/json' \
     -d "{\"order_id\":$OID,\"item_id\":$IID,\"qty\":3}" >/dev/null

# ── Phase 2: 부가세 ─────────────────────────────────────────
echo
echo "[Phase 2 부가세]"
STAMPV="ZZVAT-$$"
body -X POST "$BASE/api/quotations" -H 'Content-Type: application/json' \
     -d "{\"no\":\"$STAMPV\",\"date\":\"2026-01-01\",\"customer\":\"__smoke__\",\"order_status\":\"draft\",\"total\":0,\"total_paid\":0}" >/dev/null
VID=$(body "$BASE/api/quotations" | jsonq "JSON.parse(s).filter(q=>q.no==='$STAMPV').pop().id")
vq() { body "$BASE/api/quotations" | jsonq "JSON.parse(s).find(q=>q.id===$VID).$1"; }

body -X PUT "$BASE/api/order_items/order/$VID" -H 'Content-Type: application/json' \
     -d '[{"name":"과세품","qty":3,"unit_price":10000}]' >/dev/null
check "EXCLUSIVE 공급가액 30000"  30000 "$(vq supply_amount)"
check "  부가세 3000"             3000  "$(vq vat_amount)"
check "  합계 33000"              33000 "$(vq total)"

check "INCLUSIVE 전환 -> 200"     200 "$(code -X PATCH "$BASE/api/quotations/$VID/tax" \
                                        -H 'Content-Type: application/json' -d '{"vat_mode":"INCLUSIVE"}')"
check "  합계가 입력합계 30000"   30000 "$(vq total)"
check "★ 공급가액+부가세 == 합계 (1원 오차 없음)" "true" \
      "$(body "$BASE/api/quotations" | jsonq "(q=>q.supply_amount+q.vat_amount===q.total)(JSON.parse(s).find(x=>x.id===$VID))")"

IID2=$(body "$BASE/api/order_items/order/$VID" | jsonq 'JSON.parse(s)[0].id')
body -X PUT "$BASE/api/order_items/order/$VID" -H 'Content-Type: application/json' \
     -d "[{\"id\":$IID2,\"name\":\"과세품\",\"qty\":3,\"unit_price\":10000},{\"name\":\"면세품\",\"qty\":1,\"unit_price\":5000,\"tax_free\":1}]" >/dev/null
check "면세 5000 은 과세표준 제외"  5000 "$(vq exempt_amount)"
check "  부가세는 그대로 2727"      2727 "$(vq vat_amount)"
check "  합계 35000"                35000 "$(vq total)"

body -X PATCH "$BASE/api/quotations/$VID/tax" -H 'Content-Type: application/json' -d '{"vat_mode":"EXCLUSIVE"}' >/dev/null
check "영세율 적용 -> 부가세 0"    0 "$(body -X PATCH "$BASE/api/quotations/$VID/tax" \
                                       -H 'Content-Type: application/json' -d '{"vat_rate":0}' | jsonq 'JSON.parse(s).vat_amount')"
check "세율 10 은 거부 -> 400"     400 "$(code -X PATCH "$BASE/api/quotations/$VID/tax" \
                                        -H 'Content-Type: application/json' -d '{"vat_rate":10}')"
check "잘못된 과세방식 -> 400"     400 "$(code -X PATCH "$BASE/api/quotations/$VID/tax" \
                                        -H 'Content-Type: application/json' -d '{"vat_mode":"__x__"}')"

# 소수 수량 — qty 가 REAL 이라 SUM(qty*unit_price) 는 INTEGER 컬럼에 REAL 로 들어간다
body -X PATCH "$BASE/api/quotations/$VID/tax" -H 'Content-Type: application/json' -d '{"vat_rate":0.1}' >/dev/null
body -X PUT "$BASE/api/order_items/order/$VID" -H 'Content-Type: application/json' \
     -d '[{"name":"소수","qty":1.5,"unit_price":33333}]' >/dev/null
check "★ 소수 수량이어도 금액이 정수" "true" \
      "$(body "$BASE/api/quotations" | jsonq "(q=>Number.isInteger(q.total)&&Number.isInteger(q.supply_amount)&&Number.isInteger(q.vat_amount))(JSON.parse(s).find(x=>x.id===$VID))")"
check "  합계 = 공급+부가세"        "true" \
      "$(body "$BASE/api/quotations" | jsonq "(q=>q.supply_amount+q.vat_amount===q.total)(JSON.parse(s).find(x=>x.id===$VID))")"
code -X DELETE "$BASE/api/quotations/$VID" >/dev/null

# ── Phase 1: 계정 ───────────────────────────────────────────
echo
echo "[Phase 1 계정]"
STAFF="zz$$"
check "계정 생성 -> 200"          200 "$(code -X POST "$BASE/api/users" -H 'Content-Type: application/json' \
                                        -d "{\"username\":\"$STAFF\",\"password\":\"pw1234\",\"name\":\"스모크직원\",\"role\":\"staff\"}")"
check "중복 아이디 -> 409"        409 "$(code -X POST "$BASE/api/users" -H 'Content-Type: application/json' \
                                        -d "{\"username\":\"$STAFF\",\"password\":\"pw1234\"}")"
check "잘못된 아이디 형식 -> 400" 400 "$(code -X POST "$BASE/api/users" -H 'Content-Type: application/json' \
                                        -d '{"username":"a b","password":"pw1234"}')"
check "짧은 비밀번호 -> 400"      400 "$(code -X POST "$BASE/api/users" -H 'Content-Type: application/json' \
                                        -d '{"username":"zzshort","password":"1"}')"
SCK="$(mktemp)"
curl -s -c "$SCK" -o /dev/null -X POST "$BASE/api/login" -H 'Content-Type: application/json' \
     -d "{\"username\":\"$STAFF\",\"password\":\"pw1234\"}"
scode() { curl -s -b "$SCK" -o /dev/null -w '%{http_code}' "$@"; }
check "staff 가 계정 생성 -> 403" 403 "$(scode -X POST "$BASE/api/users" -H 'Content-Type: application/json' \
                                        -d '{"username":"zzhack","password":"pw1234"}')"
check "staff 가 남의 비번 변경 -> 403" 403 "$(scode -X PATCH "$BASE/api/users/1/password" \
                                        -H 'Content-Type: application/json' -d '{"password":"pw1234"}')"
SID=$(body "$BASE/api/users" | jsonq "JSON.parse(s).find(u=>u.username==='$STAFF').id")
check "staff 세션 유효"           200 "$(scode "$BASE/api/me")"
check "비활성화 -> 200"           200 "$(code -X PATCH "$BASE/api/users/$SID/active" \
                                        -H 'Content-Type: application/json' -d '{"active":false}')"
check "★ 비활성화 즉시 기존 세션 무효" 401 "$(scode "$BASE/api/me")"
check "비활성 계정 재로그인 -> 401" 401 "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/login" \
                                        -H 'Content-Type: application/json' -d "{\"username\":\"$STAFF\",\"password\":\"pw1234\"}")"
check "비활성 계정은 목록에서 제외" "true" \
      "$(body "$BASE/api/users" | jsonq "JSON.parse(s).every(u=>u.username!=='$STAFF')")"
check "자기 계정 비활성화 -> 400" 400 "$(code -X PATCH "$BASE/api/users/1/active" \
                                        -H 'Content-Type: application/json' -d '{"active":false}')"
rm -f "$SCK"

# 터널 뒤에서는 모든 요청이 같은 소켓 IP 다. IP 만으로 세면 한 사람의 오타가
# 사무실 전체를 잠근다 — 제한은 (IP, 아이디) 단위여야 한다.
for _ in $(seq 1 12); do
  curl -s -o /dev/null -X POST "$BASE/api/login" -H 'Content-Type: application/json' \
       -d '{"username":"__lockme__","password":"x"}'
done
check "★ 반복 실패한 아이디는 429"  429 "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/login" \
                                        -H 'Content-Type: application/json' -d '{"username":"__lockme__","password":"x"}')"
check "★ 다른 아이디는 영향 없음"   200 "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/login" \
                                        -H 'Content-Type: application/json' -d "{\"username\":\"$USERNAME\",\"password\":\"$PASSWORD\"}")"

echo
echo "[Phase 1 이력에 행위자]"
check "상태 변경에 이름 기록"     "true" \
      "$(body "$BASE/api/quotations/$OID/history" | jsonq "JSON.parse(s).changes.some(c=>c.user_name && c.user_id)")"
check "created_by 기록"           "true" \
      "$(body "$BASE/api/quotations" | jsonq "!!JSON.parse(s).find(q=>q.id===$OID).created_by")"
# 주문을 지우면 이력도 함께 사라져야 한다. quotations.id 는 AUTOINCREMENT 가 아니라
# 재사용되므로, 남아 있으면 새 주문이 남의 이력을 물려받는다.
STAMP3="ZZSMOKE3-$$"
body -X POST "$BASE/api/quotations" -H 'Content-Type: application/json' \
     -d "{\"no\":\"$STAMP3\",\"date\":\"2026-01-01\",\"customer\":\"__smoke__\",\"order_status\":\"draft\",\"total\":0,\"total_paid\":0}" >/dev/null
OID3=$(body "$BASE/api/quotations" | jsonq "JSON.parse(s).filter(q=>q.no==='$STAMP3').pop().id")
code -X PATCH "$BASE/api/quotations/$OID3/status" -H 'Content-Type: application/json' -d '{"status":"ordered"}' >/dev/null
check "  이력 1건 생성"           1 "$(body "$BASE/api/quotations/$OID3/history" | jsonq 'JSON.parse(s).changes.length')"
code -X DELETE "$BASE/api/quotations/$OID3" >/dev/null
body -X POST "$BASE/api/quotations" -H 'Content-Type: application/json' \
     -d "{\"no\":\"$STAMP3-b\",\"date\":\"2026-01-01\",\"customer\":\"__smoke__\",\"order_status\":\"draft\",\"total\":0,\"total_paid\":0}" >/dev/null
OID4=$(body "$BASE/api/quotations" | jsonq "JSON.parse(s).filter(q=>q.no==='$STAMP3-b').pop().id")
check "★ 삭제 후 재사용 id 가 이력을 물려받지 않음" 0 \
      "$(body "$BASE/api/quotations/$OID4/history" | jsonq 'JSON.parse(s).changes.length')"
code -X DELETE "$BASE/api/quotations/$OID4" >/dev/null

# ── Phase 5: 채번 ───────────────────────────────────────────
echo
echo "[Phase 5 채번]"
mkorder() { body -X POST "$BASE/api/quotations" -H 'Content-Type: application/json' \
                 -d "{\"customer\":\"__seq__\"}" | jsonq 'JSON.parse(s).id'; }
noof()   { body "$BASE/api/quotations/$1" | jsonq 'JSON.parse(s).no'; }
S1=$(mkorder); S2=$(mkorder)
N1=$(noof "$S1"); N2=$(noof "$S2")
check "번호를 서버가 매김"        "true" "$([ -n "$N1" ] && echo true || echo false)"
check "  연속 생성 시 번호가 다름" "true" "$([ "$N1" != "$N2" ] && echo true || echo false)"
code -X DELETE "$BASE/api/quotations/$S1" >/dev/null
S3=$(mkorder); N3=$(noof "$S3")
# COUNT 기반이면 중간 건 삭제 후 번호가 되돌아가 N2 와 겹친다
check "★ 중간 건 삭제 후에도 번호가 겹치지 않음" "true" \
      "$([ "$N3" != "$N2" ] && echo true || echo false)"
check "  중복 번호 직접 지정 -> 409" 409 \
      "$(code -X POST "$BASE/api/quotations" -H 'Content-Type: application/json' -d "{\"no\":\"$N2\"}")"
check "  자사 상호는 설정에서"    "true" \
      "$(body "$BASE/api/quotations/$S3" | jsonq "JSON.parse(s).ref !== undefined")"
code -X DELETE "$BASE/api/quotations/$S2" >/dev/null
code -X DELETE "$BASE/api/quotations/$S3" >/dev/null

# ── Phase 5: 완료 해제 ──────────────────────────────────────
echo
echo "[Phase 5 완료 해제]"
CID=$(body -X POST "$BASE/api/quotations" -H 'Content-Type: application/json' \
           -d '{"customer":"__comp__"}' | jsonq 'JSON.parse(s).id')
body -X PUT "$BASE/api/order_items/order/$CID" -H 'Content-Type: application/json' \
     -d '[{"name":"comp","qty":2,"unit_price":1000}]' >/dev/null
CITEM=$(body "$BASE/api/order_items/order/$CID" | jsonq 'JSON.parse(s)[0].id')
code -X PATCH "$BASE/api/quotations/$CID/status" -H 'Content-Type: application/json' -d '{"status":"ordered"}' >/dev/null
code -X POST "$BASE/api/shipments" -H 'Content-Type: application/json' \
     -d "{\"order_id\":$CID,\"item_id\":$CITEM,\"qty\":2}" >/dev/null
CB=$(body -X POST "$BASE/api/completion-batches" -H 'Content-Type: application/json' \
          -d "{\"order_ids\":[$CID]}" | jsonq 'JSON.parse(s).batch_id')
check "완료묶음 생성 후 done"     "done" "$(body "$BASE/api/quotations/$CID" | jsonq 'JSON.parse(s).order_status')"
code -X PATCH "$BASE/api/quotations/$CID/uncomplete" >/dev/null
check "★ 완료 해제 -> 출고 기록대로 shipped" "shipped" \
      "$(body "$BASE/api/quotations/$CID" | jsonq 'JSON.parse(s).order_status')"
check "  빈 완료묶음은 함께 삭제"  0 \
      "$(body "$BASE/api/completion-batches" | jsonq "JSON.parse(s).filter(b=>b.id===$CB).length")"
check "  완료 아닌 건 해제 -> 400" 400 "$(code -X PATCH "$BASE/api/quotations/$CID/uncomplete")"
# 묶음 단위 취소
CB2=$(body -X POST "$BASE/api/completion-batches" -H 'Content-Type: application/json' \
           -d "{\"order_ids\":[$CID]}" | jsonq 'JSON.parse(s).batch_id')
check "묶음 통째 취소 -> 200"     200 "$(code -X DELETE "$BASE/api/completion-batches/$CB2")"
check "  주문이 shipped 로 복귀"  "shipped" "$(body "$BASE/api/quotations/$CID" | jsonq 'JSON.parse(s).order_status')"
code -X DELETE "$BASE/api/quotations/$CID" >/dev/null

# ── Phase 5: 구매 취소·삭제 (판매와 대칭) ───────────────────
echo
echo "[Phase 5 구매 취소]"
PID=$(body -X POST "$BASE/api/purchases" -H 'Content-Type: application/json' \
           -d '{"vendor":"__seq__"}' | jsonq 'JSON.parse(s).id')
check "발주번호를 서버가 매김"    "true" \
      "$(body "$BASE/api/purchases/$PID" | jsonq "/^PO-\d{6}-\d+$/.test(JSON.parse(s).no)")"
body -X PUT "$BASE/api/purchase_items/purchase/$PID" -H 'Content-Type: application/json' \
     -d '[{"name":"panel","qty":4,"unit_price":1000}]' >/dev/null
check "정산완료로 건너뛰기 -> 400" 400 \
      "$(code -X PATCH "$BASE/api/purchases/$PID/status" -H 'Content-Type: application/json' -d '{"status":"done"}')"
code -X PATCH "$BASE/api/purchases/$PID/status" -H 'Content-Type: application/json' -d '{"status":"ordered"}' >/dev/null
check "/status 로는 취소 불가"    400 \
      "$(code -X PATCH "$BASE/api/purchases/$PID/status" -H 'Content-Type: application/json' -d '{"status":"cancelled"}')"
check "사유 없는 취소 -> 400"     400 \
      "$(code -X PATCH "$BASE/api/purchases/$PID/cancel" -H 'Content-Type: application/json' -d '{}')"
check "취소 -> 200"               200 \
      "$(code -X PATCH "$BASE/api/purchases/$PID/cancel" -H 'Content-Type: application/json' -d '{"reason":"공급업체 사정"}')"
check "  상태가 cancelled"        "cancelled" "$(body "$BASE/api/purchases/$PID" | jsonq 'JSON.parse(s).purchase_status')"
check "  취소 건에 지급 등록 -> 400" 400 \
      "$(code -X POST "$BASE/api/purchase_payments" -H 'Content-Type: application/json' -d "{\"purchase_id\":$PID,\"amount\":1000}")"
check "  취소 건에 입고 등록 -> 400" 400 \
      "$(code -X POST "$BASE/api/purchase_receipts" -H 'Content-Type: application/json' \
         -d "{\"purchase_id\":$PID,\"item_id\":$(body "$BASE/api/purchase_items/purchase/$PID" | jsonq 'JSON.parse(s)[0].id'),\"qty\":1}")"
code -X PATCH "$BASE/api/purchases/$PID/uncancel" >/dev/null
check "★ 해제 시 취소 전 상태로 복원" "ordered" \
      "$(body "$BASE/api/purchases/$PID" | jsonq 'JSON.parse(s).purchase_status')"
check "발주 삭제 -> 200"          200 "$(code -X DELETE "$BASE/api/purchases/$PID")"
check "  품목도 함께 삭제"        0 \
      "$(body "$BASE/api/purchase_items/purchase/$PID" | jsonq 'JSON.parse(s).length')"

# ── 카탈로그 역등록 ─────────────────────────────────────────
echo
echo "[카탈로그]"
PBEFORE=$(body "$BASE/api/products" | jsonq 'JSON.parse(s).length')
# 표기만 다른 같은 품목 두 건. 정규화 비교로 한 건만 들어가야 한다.
BULK='[{"name":"ZZPANEL (GRAY)","spec":"100T","unit":"EA","unit_price":72000},
       {"name":"ZZPANEL GRAY","spec":"100 T","unit":"EA","unit_price":80000}]'
check "카탈로그 역등록 -> 200"    200 \
      "$(code -X POST "$BASE/api/products/bulk" -H 'Content-Type: application/json' -d "$BULK")"
check "★ 표기만 다른 중복은 한 건만" 1 \
      "$(body "$BASE/api/products" | jsonq "JSON.parse(s).filter(p=>p.name.indexOf('ZZPANEL')===0).length")"
check "  단가·규격이 들어감"      "72000|100T" \
      "$(body "$BASE/api/products" | jsonq "JSON.parse(s).filter(p=>p.name.indexOf('ZZPANEL')===0).map(p=>p.price+'|'+p.note).join('')")"
code -X POST "$BASE/api/products/bulk" -H 'Content-Type: application/json' -d "$BULK" >/dev/null
check "★ 다시 보내도 늘지 않음"   1 \
      "$(body "$BASE/api/products" | jsonq "JSON.parse(s).filter(p=>p.name.indexOf('ZZPANEL')===0).length")"
check "배열이 아니면 400"         400 \
      "$(code -X POST "$BASE/api/products/bulk" -H 'Content-Type: application/json' -d '{"name":"x"}')"
CATID=$(body "$BASE/api/products" | jsonq "JSON.parse(s).find(p=>p.name.indexOf('ZZPANEL')===0).id")
code -X DELETE "$BASE/api/products/$CATID" >/dev/null
check "  정리 후 원래 개수"       "$PBEFORE" "$(body "$BASE/api/products" | jsonq 'JSON.parse(s).length')"

# ── 지난 단가 힌트 ──────────────────────────────────────────
echo
echo "[단가 힌트]"
HOID=$(body -X POST "$BASE/api/quotations" -H 'Content-Type: application/json' \
       -d "{\"date\":\"2026-01-05\",\"customer\":\"ZZHINT\"}" | jsonq 'JSON.parse(s).id')
body -X PUT "$BASE/api/order_items/order/$HOID" -H 'Content-Type: application/json' \
     -d '[{"name":"ZZHINTITEM (A)","spec":"100T","unit":"EA","qty":1,"unit_price":51000}]' >/dev/null
check "이력에서 단가를 찾음"      51000 \
      "$(body "$BASE/api/price-hint?name=ZZHINTITEM%20(A)&spec=100T" | jsonq 'JSON.parse(s).price')"
check "  근거가 history"          "history" \
      "$(body "$BASE/api/price-hint?name=ZZHINTITEM%20(A)&spec=100T" | jsonq 'JSON.parse(s).source')"
check "★ 띄어쓰기·괄호가 달라도 같은 품목" 51000 \
      "$(body "$BASE/api/price-hint?name=ZZHINTITEM%20A&spec=100%20T" | jsonq 'JSON.parse(s).price')"
check "모르는 품목은 null"        "null" \
      "$(body "$BASE/api/price-hint?name=ZZNOSUCHITEM&spec=" | jsonq 'String(JSON.parse(s).price)')"
check "이름이 비면 null"          "null" \
      "$(body "$BASE/api/price-hint?name=&spec=" | jsonq 'String(JSON.parse(s).price)')"
# 카탈로그는 이력이 없을 때만 쓰인다
body -X POST "$BASE/api/products/bulk" -H 'Content-Type: application/json' \
     -d '[{"name":"ZZCATONLY","spec":"50T","unit":"EA","unit_price":33000}]' >/dev/null
check "이력이 없으면 카탈로그"    "33000|catalog" \
      "$(body "$BASE/api/price-hint?name=ZZCATONLY&spec=50T" | jsonq "JSON.parse(s).price+'|'+JSON.parse(s).source")"
# 비고와 행 순서가 살아남는지
body -X PUT "$BASE/api/order_items/order/$HOID" -H 'Content-Type: application/json' \
     -d '[{"name":"ZZSECOND","spec":"","unit":"EA","qty":1,"unit_price":100,"note":"ZZNOTE"},
          {"name":"ZZHINTITEM (A)","spec":"100T","unit":"EA","qty":1,"unit_price":51000}]' >/dev/null
check "★ 행 순서가 저장됨"        "ZZSECOND" \
      "$(body "$BASE/api/order_items/order/$HOID" | jsonq 'JSON.parse(s)[0].name')"
check "★ 비고가 저장됨"           "ZZNOTE" \
      "$(body "$BASE/api/order_items/order/$HOID" | jsonq 'JSON.parse(s)[0].note')"
code -X DELETE "$BASE/api/quotations/$HOID" >/dev/null
CATID2=$(body "$BASE/api/products" | jsonq "JSON.parse(s).filter(p=>p.name.indexOf('ZZCATONLY')===0).map(p=>p.id).join('')")
code -X DELETE "$BASE/api/products/$CATID2" >/dev/null
check "  힌트 테스트 정리됨"      0 \
      "$(body "$BASE/api/quotations" | jsonq "JSON.parse(s).filter(q=>q.customer==='ZZHINT').length")"

# ── 템플릿 · 복사 ───────────────────────────────────────────
echo
echo "[템플릿]"
check "이름 없는 템플릿 -> 400"   400 \
      "$(code -X POST "$BASE/api/item_templates" -H 'Content-Type: application/json' -d '{"items":[{"name":"A"}]}')"
check "품목 없는 템플릿 -> 400"   400 \
      "$(code -X POST "$BASE/api/item_templates" -H 'Content-Type: application/json' -d '{"name":"ZZTPL","items":[]}')"
check "품목명이 다 빈 템플릿 -> 400" 400 \
      "$(code -X POST "$BASE/api/item_templates" -H 'Content-Type: application/json' -d '{"name":"ZZTPL","items":[{"name":"  "}]}')"
TPL='{"name":"ZZTPL","items":[{"name":"ZZTA","spec":"S1","unit":"EA","qty":2,"unit_price":1000,"tax_free":1},
                              {"name":"ZZTB","spec":"","unit":"EA","qty":1,"unit_price":2000}]}'
check "템플릿 저장 -> 200"        200 \
      "$(code -X POST "$BASE/api/item_templates" -H 'Content-Type: application/json' -d "$TPL")"
check "  같은 이름은 409"         409 \
      "$(code -X POST "$BASE/api/item_templates" -H 'Content-Type: application/json' -d "$TPL")"
check "  품목이 배열로 돌아옴"    2 \
      "$(body "$BASE/api/item_templates" | jsonq "JSON.parse(s).find(t=>t.name==='ZZTPL').items.length")"
check "★ 면세 구분이 살아남음"    1 \
      "$(body "$BASE/api/item_templates" | jsonq "JSON.parse(s).find(t=>t.name==='ZZTPL').items[0].tax_free")"
check "  만든 사람이 기록됨"      "true" \
      "$(body "$BASE/api/item_templates" | jsonq "String(JSON.parse(s).find(t=>t.name==='ZZTPL').created_by.length>0)")"
TPLID=$(body "$BASE/api/item_templates" | jsonq "JSON.parse(s).find(t=>t.name==='ZZTPL').id")
check "템플릿 삭제 -> 200"        200 "$(code -X DELETE "$BASE/api/item_templates/$TPLID")"
check "  목록에서 사라짐"         0 \
      "$(body "$BASE/api/item_templates" | jsonq "JSON.parse(s).filter(t=>t.name==='ZZTPL').length")"

echo
echo "[견적 복사]"
COID=$(body -X POST "$BASE/api/quotations" -H 'Content-Type: application/json' \
       -d '{"customer":"ZZCOPYSRC","site_name":"ZZSITE"}' | jsonq 'JSON.parse(s).id')
body -X PUT "$BASE/api/order_items/order/$COID" -H 'Content-Type: application/json' \
     -d '[{"name":"ZZCA","spec":"S","unit":"EA","qty":2,"unit_price":5000,"note":"ZZN","tax_free":1},
          {"name":"ZZCB","spec":"","unit":"EA","qty":1,"unit_price":3000}]' >/dev/null
body -X POST "$BASE/api/payments" -H 'Content-Type: application/json' \
     -d "{\"order_id\":$COID,\"amount\":1000,\"paid_at\":\"2026-01-01\"}" >/dev/null
SRCTOTAL=$(body "$BASE/api/quotations/$COID" | jsonq 'JSON.parse(s).total')
NEWID=$(body -X POST "$BASE/api/quotations/$COID/copy" -H 'Content-Type: application/json' -d '{}' | jsonq 'JSON.parse(s).id')
check "복사본이 만들어짐"         "true" "$([ -n "$NEWID" ] && [ "$NEWID" != "undefined" ] && echo true || echo false)"
check "★ 합계가 같음"             "$SRCTOTAL" "$(body "$BASE/api/quotations/$NEWID" | jsonq 'JSON.parse(s).total')"
check "★ 입금은 안 따라옴"        0 "$(body "$BASE/api/quotations/$NEWID" | jsonq 'JSON.parse(s).total_paid')"
check "★ 상태는 견적부터"         "draft" "$(body "$BASE/api/quotations/$NEWID" | jsonq 'JSON.parse(s).order_status')"
check "  번호는 새로 매겨짐"      "false" \
      "$(body "$BASE/api/quotations/$NEWID" | jsonq "String(JSON.parse(s).no === '$(body "$BASE/api/quotations/$COID" | jsonq 'JSON.parse(s).no')')")"
check "  현장명을 승계"           "ZZSITE" "$(body "$BASE/api/quotations/$NEWID" | jsonq 'JSON.parse(s).site_name')"
check "  품목 2건"                2 "$(body "$BASE/api/order_items/order/$NEWID" | jsonq 'JSON.parse(s).length')"
check "★ 출고 수량은 0 부터"      0 \
      "$(body "$BASE/api/order_items/order/$NEWID" | jsonq 'JSON.parse(s).reduce((a,b)=>a+(b.shipped_qty||0),0)')"
check "  비고·면세 승계"          "ZZN|1" \
      "$(body "$BASE/api/order_items/order/$NEWID" | jsonq "JSON.parse(s)[0].note+'|'+JSON.parse(s)[0].tax_free")"
check "  출처가 기록됨"           "$COID" \
      "$(body "$BASE/api/quotations/$NEWID/history" | jsonq "String((JSON.parse(s).sources||[])[0]?.source_quotation_id||'')")"
EMPTYID=$(body -X POST "$BASE/api/quotations" -H 'Content-Type: application/json' -d '{"customer":"ZZCOPYEMPTY"}' | jsonq 'JSON.parse(s).id')
check "★ 품목 없는 건 복사 -> 400" 400 "$(code -X POST "$BASE/api/quotations/$EMPTYID/copy" -H 'Content-Type: application/json' -d '{}')"
code -X DELETE "$BASE/api/quotations/$EMPTYID" >/dev/null
check "없는 건 복사 -> 404"       404 "$(code -X POST "$BASE/api/quotations/999999/copy" -H 'Content-Type: application/json' -d '{}')"
code -X DELETE "$BASE/api/quotations/$NEWID" >/dev/null
code -X DELETE "$BASE/api/quotations/$COID" >/dev/null
check "  복사 테스트 정리됨"      0 \
      "$(body "$BASE/api/quotations" | jsonq "JSON.parse(s).filter(q=>q.customer==='ZZCOPYSRC').length")"

# ── 문서 조건 · 할인 ────────────────────────────────────────
echo
echo "[문서 조건]"
DOID=$(body -X POST "$BASE/api/quotations" -H 'Content-Type: application/json' \
       -d '{"customer":"ZZDOC"}' | jsonq 'JSON.parse(s).id')
body -X PUT "$BASE/api/order_items/order/$DOID" -H 'Content-Type: application/json' \
     -d '[{"name":"ZZDA","spec":"","unit":"EA","qty":1,"unit_price":1000000},
          {"name":"ZZDB","spec":"","unit":"EA","qty":1,"unit_price":500000,"tax_free":1}]' >/dev/null
check "할인 전 합계"              1600000 "$(body "$BASE/api/quotations/$DOID" | jsonq 'JSON.parse(s).total')"
check "납기·결제조건 저장 -> 200" 200 \
      "$(code -X PATCH "$BASE/api/quotations/$DOID/memo" -H 'Content-Type: application/json' \
         -d '{"delivery_terms":"ZZ3WEEKS","payment_terms":"ZZ30-70","valid_until":"2026-12-31"}')"
check "  인쇄 데이터에 납기"      "ZZ3WEEKS" \
      "$(body "$BASE/api/print/quotations/$DOID" | jsonq 'JSON.parse(s).order.delivery_terms')"
check "  인쇄 데이터에 결제조건"  "ZZ30-70" \
      "$(body "$BASE/api/print/quotations/$DOID" | jsonq 'JSON.parse(s).order.payment_terms')"
check "★ 인쇄가 설정 유효기간을 받음" "15" \
      "$(body "$BASE/api/print/quotations/$DOID" | jsonq 'String(JSON.parse(s).quotation.validity_days)')"
check "할인 100000 -> 200"        200 \
      "$(code -X PATCH "$BASE/api/quotations/$DOID/tax" -H 'Content-Type: application/json' -d '{"discount":100000}')"
check "★ 과세분에서만 깎임"       "900000|90000|500000|1490000" \
      "$(body "$BASE/api/quotations/$DOID" | jsonq "[JSON.parse(s).supply_amount,JSON.parse(s).vat_amount,JSON.parse(s).exempt_amount,JSON.parse(s).total].join('|')")"
check "음수 할인 -> 400"          400 \
      "$(code -X PATCH "$BASE/api/quotations/$DOID/tax" -H 'Content-Type: application/json' -d '{"discount":-1}')"
check "★ 과세분보다 큰 할인은 잘림" "0|0|500000|500000" \
      "$(code -X PATCH "$BASE/api/quotations/$DOID/tax" -H 'Content-Type: application/json' -d '{"discount":9999999}' >/dev/null;
         body "$BASE/api/quotations/$DOID" | jsonq "[JSON.parse(s).supply_amount,JSON.parse(s).vat_amount,JSON.parse(s).exempt_amount,JSON.parse(s).total].join('|')")"
code -X PATCH "$BASE/api/quotations/$DOID/tax" -H 'Content-Type: application/json' -d '{"discount":0}' >/dev/null
check "  할인 해제하면 되돌아옴"  1600000 "$(body "$BASE/api/quotations/$DOID" | jsonq 'JSON.parse(s).total')"
code -X DELETE "$BASE/api/quotations/$DOID" >/dev/null
check "  문서 조건 테스트 정리됨" 0 \
      "$(body "$BASE/api/quotations" | jsonq "JSON.parse(s).filter(q=>q.customer==='ZZDOC').length")"

# ── 정리 ────────────────────────────────────────────────────
echo
echo "[정리]"
code -X DELETE "$BASE/api/quotations/$OID" >/dev/null
check "테스트 주문 삭제됨" "0" "$(body "$BASE/api/quotations" | jsonq "JSON.parse(s).filter(q=>q.no==='$STAMP').length")"


summary
