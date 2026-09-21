#!/usr/bin/env bash
# ColdStorage Master — 실무 업무 흐름 테스트
#
#   ./test/scenarios.sh
#   BASE=... USERNAME=... PASSWORD=... ./test/scenarios.sh
#
# smoke.sh 는 엔드포인트 하나하나를 본다. 여기서는 회사가 실제로 일하는 순서대로
# 이어서 밟는다 — 문제는 단일 API 가 아니라 연결부에서 터지기 때문이다.
# (계약금 받고 → 나눠 출고하고 → 완료하고 → 잘못 눌러 되돌렸을 때
#  미수금·상태·출고수량·KPI 가 전부 제자리로 오는가)
#
# 비교 대상 문자열은 전부 ASCII 로 쓴다 — Git Bash 에서 curl -d 로 보낸 한글이
# 깨져 저장되는 경우가 있어, 한글을 되읽어 비교하면 환경 탓으로 실패한다.

. "$(dirname "$0")/lib.sh"
login

echo "대상: $BASE"
TAG="ZZSC$$"          # 이 실행이 만든 데이터의 표식
ALL_IDS=""            # 마지막에 지울 주문 id

echo
echo "════ S1. 신규 수주 한 건을 끝까지 ════"
echo "[고객 등록 → 견적 → 수주 → 계약금 → 분할출고 → 잔금 → 완료]"

# ── 신규 거래처 등록
CUST="CUST-$TAG"
body -X POST "$BASE/api/customers" -H 'Content-Type: application/json' \
     -d "{\"id\":\"$CUST\",\"name\":\"$CUST\",\"rep\":\"hong\",\"phone\":\"010-0000-0000\"}" >/dev/null
check "거래처 등록"               "$CUST" "$(body "$BASE/api/customers/$CUST" | jsonq 'JSON.parse(s).name')"

# ── 견적 작성 (번호는 서버가 매긴다)
OID=$(body -X POST "$BASE/api/quotations" -H 'Content-Type: application/json' \
           -d "{\"customer_id\":\"$CUST\",\"customer\":\"$CUST\",\"memo\":\"$TAG\"}" | jsonq 'JSON.parse(s).id')
ALL_IDS="$ALL_IDS $OID"
check "견적 생성됨"               "true" "$([ -n "$OID" ] && echo true || echo false)"
[ -z "$OID" ] && { echo "견적을 만들지 못해 중단합니다."; summary; }
check "  판매번호 YY/MM/DD-N 형식" "true" \
      "$(body "$BASE/api/quotations/$OID" | jsonq "/^\d{2}\/\d{2}\/\d{2}-\d+$/.test(JSON.parse(s).no)")"
check "  새 건은 항상 draft"      "draft" "$(body "$BASE/api/quotations/$OID" | jsonq 'JSON.parse(s).order_status')"
check "  작성자가 기록됨"         "true" \
      "$(body "$BASE/api/quotations/$OID" | jsonq 'JSON.parse(s).created_by.length>0')"

# ── 품목 3종 (판넬 / 도어 / 부자재). 부가세 별도 기준
body -X PUT "$BASE/api/order_items/order/$OID" -H 'Content-Type: application/json' \
     -d '[{"name":"panel","spec":"100T","unit":"EA","qty":20,"unit_price":45000},
          {"name":"door","spec":"1200x2000","unit":"EA","qty":2,"unit_price":850000},
          {"name":"parts","spec":"set","unit":"SET","qty":1,"unit_price":300000}]' >/dev/null
# 20*45000 + 2*850000 + 1*300000 = 900000 + 1700000 + 300000 = 2,900,000
check "품목 3종 저장"             3 "$(body "$BASE/api/order_items/order/$OID" | jsonq 'JSON.parse(s).length')"
check "  공급가액 2,900,000"      2900000 "$(body "$BASE/api/quotations/$OID" | jsonq 'JSON.parse(s).supply_amount')"
check "  부가세 290,000"          290000  "$(body "$BASE/api/quotations/$OID" | jsonq 'JSON.parse(s).vat_amount')"
check "  합계 3,190,000 (세포함)" 3190000 "$(body "$BASE/api/quotations/$OID" | jsonq 'JSON.parse(s).total')"
check "  ★ 공급가액+부가세 == 합계" "true" \
      "$(body "$BASE/api/quotations/$OID" | jsonq '(o=>o.supply_amount+o.vat_amount+o.exempt_amount===o.total)(JSON.parse(s))')"

# ── 견적서 인쇄 데이터
body -X PATCH "$BASE/api/quotations/$OID/memo" -H 'Content-Type: application/json' \
     -d '{"memo_internal":"SECRET-INTERNAL","memo_customer":"thanks"}' >/dev/null
check "견적서 인쇄 데이터 -> 200" 200 "$(code "$BASE/api/print/quotations/$OID")"
check "  품목 3종 포함"           3 "$(body "$BASE/api/print/quotations/$OID" | jsonq 'JSON.parse(s).items.length')"
check "  공급자 상호 포함"        "true" \
      "$(body "$BASE/api/print/quotations/$OID" | jsonq '!!JSON.parse(s).company')"
check "  ★ 내부 메모는 빠짐"      "true" \
      "$(body "$BASE/api/print/quotations/$OID" | jsonq "!/SECRET-INTERNAL/.test(s)")"

# ── 수주 확정
check "수주 확정 draft->ordered"  200 "$(code -X PATCH "$BASE/api/quotations/$OID/status" \
                                        -H 'Content-Type: application/json' -d '{"status":"ordered"}')"

# ── 계약금 30% (957,000)
check "계약금 입금 -> 200"        200 "$(code -X POST "$BASE/api/payments" -H 'Content-Type: application/json' \
                                        -d "{\"order_id\":$OID,\"amount\":957000,\"paid_at\":\"2026-09-21\"}")"
check "  미수금 2,233,000"        2233000 \
      "$(body "$BASE/api/quotations/$OID" | jsonq '(o=>o.total-o.total_paid)(JSON.parse(s))')"

# ── 1차 출고 (판넬만)
PANEL=$(body "$BASE/api/order_items/order/$OID" | jsonq "JSON.parse(s).find(i=>i.name==='panel').id")
DOOR=$( body "$BASE/api/order_items/order/$OID" | jsonq "JSON.parse(s).find(i=>i.name==='door').id")
PARTS=$(body "$BASE/api/order_items/order/$OID" | jsonq "JSON.parse(s).find(i=>i.name==='parts').id")
check "1차 출고(판넬 20) -> 200"  200 "$(code -X POST "$BASE/api/shipments" -H 'Content-Type: application/json' \
                                        -d "{\"order_id\":$OID,\"item_id\":$PANEL,\"qty\":20,\"shipped_at\":\"2026-09-21\"}")"
check "  상태 partial 로 자동 승격" "partial" "$(body "$BASE/api/quotations/$OID" | jsonq 'JSON.parse(s).order_status')"
check "  판넬만 출고 반영"        "20,0,0" \
      "$(body "$BASE/api/order_items/order/$OID" | jsonq "JSON.parse(s).sort((a,b)=>a.id-b.id).map(i=>i.shipped_qty).join(',')")"
check "  인쇄 데이터에 출고 1건"  1 "$(body "$BASE/api/print/quotations/$OID" | jsonq 'JSON.parse(s).shipments.length')"

# ── 2차 출고 (나머지) — 묶음 출고로
check "2차 출고(묶음) -> 200"     200 "$(code -X POST "$BASE/api/shipment-batches" -H 'Content-Type: application/json' \
                                        -d "{\"shipped_at\":\"2026-09-22\",\"items\":[{\"order_id\":$OID,\"item_id\":$DOOR,\"qty\":2},{\"order_id\":$OID,\"item_id\":$PARTS,\"qty\":1}]}")"
check "  상태 shipped"            "shipped" "$(body "$BASE/api/quotations/$OID" | jsonq 'JSON.parse(s).order_status')"
check "  출고 이력 3건"           3 "$(body "$BASE/api/shipments/order/$OID" | jsonq 'JSON.parse(s).length')"

# ── 잔금
check "잔금 입금 -> 200"          200 "$(code -X POST "$BASE/api/payments" -H 'Content-Type: application/json' \
                                        -d "{\"order_id\":$OID,\"amount\":2233000,\"paid_at\":\"2026-09-23\"}")"
check "  미수금 0"                0 "$(body "$BASE/api/quotations/$OID" | jsonq '(o=>o.total-o.total_paid)(JSON.parse(s))')"

# ── 완료 묶음
CB=$(body -X POST "$BASE/api/completion-batches" -H 'Content-Type: application/json' \
          -d "{\"order_ids\":[$OID]}" | jsonq 'JSON.parse(s).batch_id')
check "완료 처리 -> done"         "done" "$(body "$BASE/api/quotations/$OID" | jsonq 'JSON.parse(s).order_status')"
check "  완료묶음 id 기록"        "$CB" "$(body "$BASE/api/quotations/$OID" | jsonq 'String(JSON.parse(s).completion_batch_id)')"
check "  이력에 전 단계가 남음"   "true" \
      "$(body "$BASE/api/quotations/$OID/history" | jsonq "(c=>['ordered','done'].every(x=>c.some(r=>r.to_status===x)))(JSON.parse(s).changes)")"

echo
echo "════ S2. 잘못 눌렀을 때 되돌리기 ════"
echo "[출고 삭제 → 입금 삭제 → 완료 해제 → 취소/해제]"

# ── 완료 해제 (출고 원장대로 shipped 로 돌아와야 한다)
code -X PATCH "$BASE/api/quotations/$OID/uncomplete" >/dev/null
check "완료 해제 -> shipped 복귀"  "shipped" "$(body "$BASE/api/quotations/$OID" | jsonq 'JSON.parse(s).order_status')"
check "  빈 완료묶음은 삭제됨"     0 "$(body "$BASE/api/completion-batches" | jsonq "JSON.parse(s).filter(b=>b.id===$CB).length")"
check "  금액은 그대로 3,190,000"  3190000 "$(body "$BASE/api/quotations/$OID" | jsonq 'JSON.parse(s).total')"

# ── 입금 오등록 되돌리기
PAYID=$(body "$BASE/api/payments/order/$OID" | jsonq 'JSON.parse(s).pop().id')
code -X DELETE "$BASE/api/payments/$PAYID" >/dev/null
check "잔금 입금 삭제 -> 미수금 복구" 2233000 \
      "$(body "$BASE/api/quotations/$OID" | jsonq '(o=>o.total-o.total_paid)(JSON.parse(s))')"

# ── 출고 오입력 되돌리기 (2차분 2건 삭제 → partial 로)
for SID in $(body "$BASE/api/shipments/order/$OID" | jsonq "JSON.parse(s).filter(x=>x.shipped_at==='2026-09-22').map(x=>x.id).join(' ')"); do
  code -X DELETE "$BASE/api/shipments/$SID" >/dev/null
done
check "2차 출고 삭제 -> partial 복귀" "partial" "$(body "$BASE/api/quotations/$OID" | jsonq 'JSON.parse(s).order_status')"
check "  출고수량 원장에서 재계산"    "20,0,0" \
      "$(body "$BASE/api/order_items/order/$OID" | jsonq "JSON.parse(s).sort((a,b)=>a.id-b.id).map(i=>i.shipped_qty).join(',')")"

# ── 1차분까지 삭제 → 출고 0 이면 ordered 로
SID1=$(body "$BASE/api/shipments/order/$OID" | jsonq 'JSON.parse(s)[0].id')
code -X DELETE "$BASE/api/shipments/$SID1" >/dev/null
check "★ 출고 전부 삭제 -> ordered 롤백" "ordered" "$(body "$BASE/api/quotations/$OID" | jsonq 'JSON.parse(s).order_status')"
check "  출고수량 전부 0"         "0,0,0" \
      "$(body "$BASE/api/order_items/order/$OID" | jsonq "JSON.parse(s).sort((a,b)=>a.id-b.id).map(i=>i.shipped_qty).join(',')")"

# ── 거래 취소 후 되살리기 (계약금만 남은 상태 = ordered)
code -X PATCH "$BASE/api/quotations/$OID/cancel" -H 'Content-Type: application/json' \
     -d '{"reason":"customer hold"}' >/dev/null
check "거래 취소 -> cancelled"    "cancelled" "$(body "$BASE/api/quotations/$OID" | jsonq 'JSON.parse(s).order_status')"
check "  취소 사유 기록"          "customer hold" "$(body "$BASE/api/quotations/$OID" | jsonq 'JSON.parse(s).cancelled_reason')"

echo
echo "  [취소 상태에서 막혀야 하는 것들]"
check "  취소 건에 입금 -> 400"   400 "$(code -X POST "$BASE/api/payments" -H 'Content-Type: application/json' \
                                        -d "{\"order_id\":$OID,\"amount\":1000}")"
check "  취소 건에 출고 -> 400"   400 "$(code -X POST "$BASE/api/shipments" -H 'Content-Type: application/json' \
                                        -d "{\"order_id\":$OID,\"item_id\":$PANEL,\"qty\":1}")"
check "  취소 건 품목 수정 -> 400" 400 "$(code -X PUT "$BASE/api/order_items/order/$OID" \
                                        -H 'Content-Type: application/json' -d '[]')"
check "  취소 건 완료묶음 -> 400" 400 "$(code -X POST "$BASE/api/completion-batches" \
                                        -H 'Content-Type: application/json' -d "{\"order_ids\":[$OID]}")"

code -X PATCH "$BASE/api/quotations/$OID/uncancel" >/dev/null
check "★ 취소 해제 -> 취소 직전(ordered) 복원" "ordered" \
      "$(body "$BASE/api/quotations/$OID" | jsonq 'JSON.parse(s).order_status')"
check "  계약금은 그대로"         957000 "$(body "$BASE/api/quotations/$OID" | jsonq 'JSON.parse(s).total_paid')"
check "  미수금 2,233,000 복원"   2233000 \
      "$(body "$BASE/api/quotations/$OID" | jsonq '(o=>o.total-o.total_paid)(JSON.parse(s))')"

echo
echo "════ S3. 부가세 — 포함/별도 왕복 ════"
# 면세 품목을 섞은 뒤 INCLUSIVE 로 갔다가 EXCLUSIVE 로 돌아오면 원래 합계여야 한다
TID=$(body -X POST "$BASE/api/quotations" -H 'Content-Type: application/json' \
           -d "{\"customer\":\"$TAG-tax\"}" | jsonq 'JSON.parse(s).id')
ALL_IDS="$ALL_IDS $TID"
body -X PUT "$BASE/api/order_items/order/$TID" -H 'Content-Type: application/json' \
     -d '[{"name":"taxable","qty":3,"unit_price":10000},
          {"name":"free","qty":1,"unit_price":5000,"tax_free":1}]' >/dev/null
check "별도: 공급 30,000"         30000 "$(body "$BASE/api/quotations/$TID" | jsonq 'JSON.parse(s).supply_amount')"
check "  면세 5,000 은 과세표준 밖" 5000 "$(body "$BASE/api/quotations/$TID" | jsonq 'JSON.parse(s).exempt_amount')"
check "  부가세 3,000"            3000  "$(body "$BASE/api/quotations/$TID" | jsonq 'JSON.parse(s).vat_amount')"
check "  합계 38,000"             38000 "$(body "$BASE/api/quotations/$TID" | jsonq 'JSON.parse(s).total')"
code -X PATCH "$BASE/api/quotations/$TID/tax" -H 'Content-Type: application/json' -d '{"vat_mode":"INCLUSIVE"}' >/dev/null
check "포함 전환: 합계 35,000"    35000 "$(body "$BASE/api/quotations/$TID" | jsonq 'JSON.parse(s).total')"
check "  ★ 1원 오차 없음"         "true" \
      "$(body "$BASE/api/quotations/$TID" | jsonq '(o=>o.supply_amount+o.vat_amount+o.exempt_amount===o.total)(JSON.parse(s))')"
code -X PATCH "$BASE/api/quotations/$TID/tax" -H 'Content-Type: application/json' -d '{"vat_mode":"EXCLUSIVE"}' >/dev/null
check "★ 별도로 되돌리면 38,000 복귀" 38000 "$(body "$BASE/api/quotations/$TID" | jsonq 'JSON.parse(s).total')"

# 세포함일 때 부가세는 반드시 "차액" 이어야 한다. 따로 구하면 1원씩 깨지는데,
# 대부분의 금액에서는 두 방식의 결과가 같아 드러나지 않는다.
# 6,000원은 갈리는 금액이다 — 차액이면 545, 따로 구하면 546(합계가 6,001이 된다).
RID=$(body -X POST "$BASE/api/quotations" -H 'Content-Type: application/json' \
           -d "{\"customer\":\"$TAG-round\"}" | jsonq 'JSON.parse(s).id')
ALL_IDS="$ALL_IDS $RID"
body -X PUT "$BASE/api/order_items/order/$RID" -H 'Content-Type: application/json' \
     -d '[{"name":"edge","qty":3,"unit_price":2000}]' >/dev/null
code -X PATCH "$BASE/api/quotations/$RID/tax" -H 'Content-Type: application/json' -d '{"vat_mode":"INCLUSIVE"}' >/dev/null
check "★ 반올림 경계(6,000): 공급 5,455" 5455 "$(body "$BASE/api/quotations/$RID" | jsonq 'JSON.parse(s).supply_amount')"
check "★ 부가세는 차액 545 (따로 구하면 546)" 545 "$(body "$BASE/api/quotations/$RID" | jsonq 'JSON.parse(s).vat_amount')"
check "  합계가 6,000 그대로"     6000 "$(body "$BASE/api/quotations/$RID" | jsonq 'JSON.parse(s).total')"

echo
echo "════ S4. 자재 발주 — 발주부터 정산까지 ════"
PID=$(body -X POST "$BASE/api/purchases" -H 'Content-Type: application/json' \
           -d "{\"vendor\":\"VEND-$TAG\",\"memo\":\"$TAG\"}" | jsonq 'JSON.parse(s).id')
check "발주 생성"                 "true" "$([ -n "$PID" ] && echo true || echo false)"
check "  발주번호 PO-YYMMDD-N"    "true" \
      "$(body "$BASE/api/purchases/$PID" | jsonq "/^PO-\d{6}-\d+$/.test(JSON.parse(s).no)")"
body -X PUT "$BASE/api/purchase_items/purchase/$PID" -H 'Content-Type: application/json' \
     -d '[{"name":"rawpanel","qty":30,"unit_price":30000}]' >/dev/null
PITEM=$(body "$BASE/api/purchase_items/purchase/$PID" | jsonq 'JSON.parse(s)[0].id')
check "  공급가 900,000"          900000 "$(body "$BASE/api/purchases/$PID" | jsonq 'JSON.parse(s).supply_amount')"
check "정산완료로 건너뛰기 -> 400" 400 "$(code -X PATCH "$BASE/api/purchases/$PID/status" \
                                        -H 'Content-Type: application/json' -d '{"status":"done"}')"
code -X PATCH "$BASE/api/purchases/$PID/status" -H 'Content-Type: application/json' -d '{"status":"ordered"}' >/dev/null
check "부분 입고(10) -> partial"  200 "$(code -X POST "$BASE/api/purchase_receipts" -H 'Content-Type: application/json' \
                                        -d "{\"purchase_id\":$PID,\"item_id\":$PITEM,\"qty\":10}")"
check "  상태 partial"            "partial" "$(body "$BASE/api/purchases/$PID" | jsonq 'JSON.parse(s).purchase_status')"
check "초과 입고(21) -> 400"      400 "$(code -X POST "$BASE/api/purchase_receipts" -H 'Content-Type: application/json' \
                                        -d "{\"purchase_id\":$PID,\"item_id\":$PITEM,\"qty\":21}")"
code -X POST "$BASE/api/purchase_receipts" -H 'Content-Type: application/json' \
     -d "{\"purchase_id\":$PID,\"item_id\":$PITEM,\"qty\":20}" >/dev/null
check "잔여 입고 -> received"     "received" "$(body "$BASE/api/purchases/$PID" | jsonq 'JSON.parse(s).purchase_status')"
check "  입고수량 30 누적"        30 "$(body "$BASE/api/purchase_items/purchase/$PID" | jsonq 'JSON.parse(s)[0].received_qty')"
code -X POST "$BASE/api/purchase_payments" -H 'Content-Type: application/json' \
     -d "{\"purchase_id\":$PID,\"amount\":990000}" >/dev/null
check "지급 등록 -> 미지급 0"     0 "$(body "$BASE/api/purchases/$PID" | jsonq '(p=>p.total-p.total_paid)(JSON.parse(s))')"
code -X PATCH "$BASE/api/purchases/$PID/status" -H 'Content-Type: application/json' -d '{"status":"done"}' >/dev/null
check "정산 완료 -> done"         "done" "$(body "$BASE/api/purchases/$PID" | jsonq 'JSON.parse(s).purchase_status')"

# 별도 건: 취소 → 해제 → 삭제
P2=$(body -X POST "$BASE/api/purchases" -H 'Content-Type: application/json' \
          -d "{\"vendor\":\"VEND2-$TAG\"}" | jsonq 'JSON.parse(s).id')
body -X PUT "$BASE/api/purchase_items/purchase/$P2" -H 'Content-Type: application/json' \
     -d '[{"name":"bolt","qty":100,"unit_price":500}]' >/dev/null
code -X PATCH "$BASE/api/purchases/$P2/status" -H 'Content-Type: application/json' -d '{"status":"ordered"}' >/dev/null
code -X PATCH "$BASE/api/purchases/$P2/cancel" -H 'Content-Type: application/json' -d '{"reason":"vendor issue"}' >/dev/null
check "발주 취소 -> cancelled"    "cancelled" "$(body "$BASE/api/purchases/$P2" | jsonq 'JSON.parse(s).purchase_status')"
code -X PATCH "$BASE/api/purchases/$P2/uncancel" >/dev/null
check "★ 해제 -> ordered 복원"    "ordered" "$(body "$BASE/api/purchases/$P2" | jsonq 'JSON.parse(s).purchase_status')"
code -X DELETE "$BASE/api/purchases/$P2" >/dev/null
check "발주 삭제 -> 품목도 사라짐" 0 "$(body "$BASE/api/purchase_items/purchase/$P2" | jsonq 'JSON.parse(s).length')"

echo
echo "════ S5. 월말 마감 — 대시보드 정합성 ════"
# 미수금이 있는 done 1건 / 취소 1건 / 부분출고+미수금 1건 을 만들어 동시에 본다
mkorder() {   # $1=상태만들기용 라벨 → id 출력
  local id
  id=$(body -X POST "$BASE/api/quotations" -H 'Content-Type: application/json' \
            -d "{\"customer\":\"$TAG-$1\",\"date\":\"2026-09-21\"}" | jsonq 'JSON.parse(s).id')
  body -X PUT "$BASE/api/order_items/order/$id" -H 'Content-Type: application/json' \
       -d '[{"name":"x","qty":2,"unit_price":50000}]' >/dev/null
  code -X PATCH "$BASE/api/quotations/$id/status" -H 'Content-Type: application/json' -d '{"status":"ordered"}' >/dev/null
  echo "$id"
}
BEFORE_UNPAID=$(body "$BASE/api/dashboard" | jsonq 'JSON.parse(s).kpi.totalUnpaid')

# (a) 완료됐지만 미입금 — 예전엔 총 미수금에서 증발했다
DONE_UNPAID=$(mkorder doneunpaid); ALL_IDS="$ALL_IDS $DONE_UNPAID"
DU_ITEM=$(body "$BASE/api/order_items/order/$DONE_UNPAID" | jsonq 'JSON.parse(s)[0].id')
code -X POST "$BASE/api/shipments" -H 'Content-Type: application/json' \
     -d "{\"order_id\":$DONE_UNPAID,\"item_id\":$DU_ITEM,\"qty\":2}" >/dev/null
code -X POST "$BASE/api/completion-batches" -H 'Content-Type: application/json' \
     -d "{\"order_ids\":[$DONE_UNPAID]}" >/dev/null
check "완료건 상태 done"          "done" "$(body "$BASE/api/quotations/$DONE_UNPAID" | jsonq 'JSON.parse(s).order_status')"
check "★ 완료됐지만 미입금 -> 총 미수금에 포함" "true" \
      "$(body "$BASE/api/dashboard" | jsonq "JSON.parse(s).kpi.totalUnpaid === $BEFORE_UNPAID + 110000")"

# (b) 취소건은 빠져야 한다
CANCELLED=$(mkorder cancelled); ALL_IDS="$ALL_IDS $CANCELLED"
AFTER_B=$(body "$BASE/api/dashboard" | jsonq 'JSON.parse(s).kpi.totalUnpaid')
code -X PATCH "$BASE/api/quotations/$CANCELLED/cancel" -H 'Content-Type: application/json' \
     -d '{"reason":"drop"}' >/dev/null
check "★ 취소하면 총 미수금에서 빠짐" "true" \
      "$(body "$BASE/api/dashboard" | jsonq "JSON.parse(s).kpi.totalUnpaid === $AFTER_B - 110000")"
check "  워크큐에도 안 뜸"        0 \
      "$(body "$BASE/api/dashboard" | jsonq "JSON.parse(s).workqueue.filter(w=>w.id===$CANCELLED&&w.tag!=='AS').length")"

# (c) 부분출고 + 미수금 — 예전엔 워크큐에 두 번 떴다
PARTIAL=$(mkorder partial); ALL_IDS="$ALL_IDS $PARTIAL"
P_ITEM=$(body "$BASE/api/order_items/order/$PARTIAL" | jsonq 'JSON.parse(s)[0].id')
code -X POST "$BASE/api/shipments" -H 'Content-Type: application/json' \
     -d "{\"order_id\":$PARTIAL,\"item_id\":$P_ITEM,\"qty\":1}" >/dev/null
check "부분출고 상태 partial"     "partial" "$(body "$BASE/api/quotations/$PARTIAL" | jsonq 'JSON.parse(s).order_status')"
check "★ 워크큐에 딱 1번만 (중복 제거)" 1 \
      "$(body "$BASE/api/dashboard" | jsonq "JSON.parse(s).workqueue.filter(w=>w.id===$PARTIAL&&w.tag!=='AS').length")"
check "  태그는 부분출고"         "부분출고" \
      "$(body "$BASE/api/dashboard" | jsonq "(w=>w?w.tag:'')(JSON.parse(s).workqueue.find(w=>w.id===$PARTIAL&&w.tag!=='AS'))")"

# (d) 출고 완료(shipped)가 진행중 KPI 에 포함되는가 — 예전엔 빠졌다
SHIPPED=$(mkorder shipped); ALL_IDS="$ALL_IDS $SHIPPED"
S_ITEM=$(body "$BASE/api/order_items/order/$SHIPPED" | jsonq 'JSON.parse(s)[0].id')
BEFORE_IP=$(body "$BASE/api/dashboard" | jsonq 'JSON.parse(s).kpi.inProgress')
code -X POST "$BASE/api/shipments" -H 'Content-Type: application/json' \
     -d "{\"order_id\":$SHIPPED,\"item_id\":$S_ITEM,\"qty\":2}" >/dev/null
check "출고 완료 상태 shipped"    "shipped" "$(body "$BASE/api/quotations/$SHIPPED" | jsonq 'JSON.parse(s).order_status')"
check "★ shipped 도 진행중 KPI 에 포함" "true" \
      "$(body "$BASE/api/dashboard" | jsonq "JSON.parse(s).kpi.inProgress === $BEFORE_IP")"

# (e) 워크큐 최신순 / 내부 메모 미노출
check "워크큐가 최신순"           "true" \
      "$(body "$BASE/api/dashboard" | jsonq "(u=>u.length<2||u.every((r,i)=>i===0||u[i-1].date>=r.date))(JSON.parse(s).workqueue.filter(w=>w.tag==='미수금'))")"
check "★ recent 에 내부 메모 없음" "true" \
      "$(body "$BASE/api/dashboard" | jsonq "JSON.parse(s).recent.every(r=>!('memo_internal' in r))")"

echo
echo "════ S6. 하루에 여러 건 — 번호가 겹치지 않는가 ════"
# 오늘 3건을 만들고 중간 건을 취소·삭제한 뒤 한 건 더 만든다.
# COUNT 기반 채번이면 번호가 되돌아가 앞 건과 겹친다.
N1=$(body -X POST "$BASE/api/quotations" -H 'Content-Type: application/json' -d "{\"customer\":\"$TAG-n1\"}" | jsonq 'JSON.parse(s).id')
N2=$(body -X POST "$BASE/api/quotations" -H 'Content-Type: application/json' -d "{\"customer\":\"$TAG-n2\"}" | jsonq 'JSON.parse(s).id')
NO1=$(body "$BASE/api/quotations/$N1" | jsonq 'JSON.parse(s).no')
NO2=$(body "$BASE/api/quotations/$N2" | jsonq 'JSON.parse(s).no')
check "연속 생성 시 번호가 다름"  "true" "$([ -n "$NO1" ] && [ "$NO1" != "$NO2" ] && echo true || echo false)"
code -X DELETE "$BASE/api/quotations/$N1" >/dev/null
# COUNT 기반 채번이면 여기서 번호가 N2 와 겹쳐 UNIQUE 인덱스에 걸리고,
# 주문 자체가 만들어지지 않는다(500). 그래서 "생성됐는가" 를 먼저 단언한다 —
# 이걸 빼면 실패 시 no 가 "undefined" 가 되어 "다르다" 검사가 헛돈다.
N3RAW=$(body -X POST "$BASE/api/quotations" -H 'Content-Type: application/json' -d "{\"customer\":\"$TAG-n3\"}")
N3=$(echo "$N3RAW" | jsonq 'JSON.parse(s).id')
ALL_IDS="$ALL_IDS $N2 $N3"
check "★ 중간 건 삭제 후에도 주문이 만들어짐" "true" "$(echo "$N3RAW" | jsonq 'JSON.parse(s).ok===true')"
check "  번호 형식이 정상"        "true" \
      "$(echo "$N3RAW" | jsonq '/^\d{2}\/\d{2}\/\d{2}-\d+$/.test(JSON.parse(s).no||"")')"
NO3=$(echo "$N3RAW" | jsonq 'JSON.parse(s).no')
check "  앞 번호와 안 겹침"       "true" \
      "$([ -n "$NO3" ] && [ "$NO3" != "$NO2" ] && echo true || echo false)"
check "  중복 번호 직접 지정 -> 409" 409 \
      "$(code -X POST "$BASE/api/quotations" -H 'Content-Type: application/json' -d "{\"no\":\"$NO2\"}")"

echo
echo "════ S7. 사무 업무 — 찾기 · 내보내기 ════"
check "검색어 1개"                "true" \
      "$(body "$BASE/api/quotations?q=$TAG" | jsonq 'JSON.parse(s).total>0')"
check "★ 토큰 2개는 AND 로 걸림"  0 \
      "$(body "$BASE/api/quotations?q=$TAG%20__nomatch__" | jsonq 'JSON.parse(s).total')"
check "기간 밖이면 0건"           0 \
      "$(body "$BASE/api/quotations?q=$TAG&from=2020-01-01&to=2020-12-31" | jsonq 'JSON.parse(s).total')"
check "★ 상태 다중 선택(콤마)"    "true" \
      "$(body "$BASE/api/quotations?q=$TAG&status=cancelled,done" | jsonq "(o=>o.rows.every(r=>['cancelled','done'].includes(r.order_status)))(JSON.parse(s))")"
check "limit 적용"                1 "$(body "$BASE/api/quotations?q=$TAG&limit=1" | jsonq 'JSON.parse(s).rows.length')"
check "offset 으로 다른 행"       "true" \
      "$(body "$BASE/api/quotations?q=$TAG&limit=1&offset=1" | jsonq "JSON.parse(s).rows[0].id !== $(body "$BASE/api/quotations?q=$TAG&limit=1" | jsonq 'JSON.parse(s).rows[0].id')")"
check "파라미터 없으면 배열 그대로" "true" "$(body "$BASE/api/quotations" | jsonq 'Array.isArray(JSON.parse(s))')"
CSVROWS=$(body "$BASE/api/export/quotations?q=$TAG" | sed 1d | grep -c . )
APIROWS=$(body "$BASE/api/quotations?q=$TAG&limit=500" | jsonq 'JSON.parse(s).rows.length')
check "★ CSV 가 화면 필터와 같은 건수" "$APIROWS" "$CSVROWS"
check "  CSV 에 UTF-8 BOM"        "true" \
      "$(body "$BASE/api/export/quotations?q=$TAG" | head -c 3 | od -An -tx1 | tr -d ' \n' | grep -q '^efbbbf$' && echo true || echo false)"

echo
echo "════ S8. 여러 직원이 함께 ════"
STAFF="staff$$"
code -X POST "$BASE/api/users" -H 'Content-Type: application/json' \
     -d "{\"username\":\"$STAFF\",\"password\":\"staffpw123\",\"name\":\"STAFFNAME\",\"role\":\"staff\"}" >/dev/null
SCK="$(mktemp)"
curl -s -c "$SCK" -o /dev/null -X POST "$BASE/api/login" -H 'Content-Type: application/json' \
     -d "{\"username\":\"$STAFF\",\"password\":\"staffpw123\"}"
# 직원이 주문을 만들고 확정까지
SOID=$(curl -s -b "$SCK" -X POST "$BASE/api/quotations" -H 'Content-Type: application/json' \
            -d "{\"customer\":\"$TAG-staff\"}" | jsonq 'JSON.parse(s).id')
ALL_IDS="$ALL_IDS $SOID"
curl -s -b "$SCK" -X PUT "$BASE/api/order_items/order/$SOID" -H 'Content-Type: application/json' \
     -d '[{"name":"y","qty":1,"unit_price":1000}]' >/dev/null
curl -s -b "$SCK" -o /dev/null -X PATCH "$BASE/api/quotations/$SOID/status" \
     -H 'Content-Type: application/json' -d '{"status":"ordered"}'
check "직원이 만든 주문의 작성자"  "STAFFNAME" "$(body "$BASE/api/quotations/$SOID" | jsonq 'JSON.parse(s).created_by')"
# 관리자가 이어받아 출고·완료
A_ITEM=$(body "$BASE/api/order_items/order/$SOID" | jsonq 'JSON.parse(s)[0].id')
code -X POST "$BASE/api/shipments" -H 'Content-Type: application/json' \
     -d "{\"order_id\":$SOID,\"item_id\":$A_ITEM,\"qty\":1}" >/dev/null
code -X POST "$BASE/api/completion-batches" -H 'Content-Type: application/json' \
     -d "{\"order_ids\":[$SOID]}" >/dev/null
code -X PATCH "$BASE/api/quotations/$SOID/uncomplete" >/dev/null
check "★ 이력에 두 사람 이름이 각각 남음" "true" \
      "$(body "$BASE/api/quotations/$SOID/history" | jsonq "(c=>c.some(r=>r.user_name==='STAFFNAME')&&c.some(r=>r.user_name!=='STAFFNAME'&&r.user_name))(JSON.parse(s).changes)")"
check "  직원은 계정 생성 불가"   403 \
      "$(curl -s -b "$SCK" -o /dev/null -w '%{http_code}' -X POST "$BASE/api/users" \
         -H 'Content-Type: application/json' -d '{"username":"x1","password":"pw123456","name":"x"}')"
# 퇴사 처리 → 기존 세션 즉시 무효
SUID=$(body "$BASE/api/users" | jsonq "JSON.parse(s).find(u=>u.username==='$STAFF').id")
code -X PATCH "$BASE/api/users/$SUID/active" -H 'Content-Type: application/json' -d '{"active":0}' >/dev/null
check "★ 퇴사 처리 시 기존 세션 즉시 무효" 401 \
      "$(curl -s -b "$SCK" -o /dev/null -w '%{http_code}' "$BASE/api/dashboard")"
rm -f "$SCK"

echo
echo "════ 정리 ════"
for ID in $ALL_IDS; do code -X DELETE "$BASE/api/quotations/$ID" >/dev/null; done
code -X DELETE "$BASE/api/purchases/$PID" >/dev/null
code -X DELETE "$BASE/api/customers/$CUST" >/dev/null
check "시나리오 주문 전부 삭제됨" 0 \
      "$(body "$BASE/api/quotations?q=$TAG&limit=500" | jsonq 'JSON.parse(s).total')"
check "시나리오 발주 전부 삭제됨" 0 \
      "$(body "$BASE/api/purchases?q=$TAG&limit=500" | jsonq 'JSON.parse(s).total')"
check "고아 이력 없음"            0 \
      "$(body "$BASE/api/quotations/$OID/history" | jsonq 'JSON.parse(s).changes.length')"

summary
