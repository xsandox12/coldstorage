/* ColdStorage Master — 화면 공통 유틸
 *
 * 그동안 상태 라벨·날짜·금액 포맷이 화면마다 복붙돼 있었고(일부는 값이 서로 달랐다),
 * fetch 77곳에 응답 검사가 하나도 없어 저장 실패가 성공처럼 보였다. 여기로 모은다.
 */

/* ── 상태 ──────────────────────────────────────────────────────
 * 화면마다 STATUS_LABEL 을 서로 다른 도메인(판매/구매/AS)으로 쓰고 있어
 * 공용 이름은 SALES_ 접두사로 분리한다. 판매 화면들은 아래를 참조한다. */
const SALES_STATUS_LABEL = {
  draft:'견적', ordered:'주문', partial:'부분출고', shipped:'출고', done:'완료', cancelled:'취소',
};
const SALES_STATUS_CLS = {
  draft:'s-draft', ordered:'s-ordered', partial:'s-partial',
  shipped:'s-shipped', done:'s-done', cancelled:'s-cancelled',
};
/** 미수금으로 집계하는 상태인가.
 *  견적(draft)은 아직 주문이 아니고 취소건은 받을 돈이 없다. 완료(done)는 포함한다 —
 *  납품이 끝났는데 못 받은 돈이야말로 미수금이다.
 *  서버 /api/dashboard 의 totalUnpaid 조건과 반드시 같아야 한다. */
const UNPAID_EXCLUDED = ['draft', 'cancelled'];
function tracksUnpaid(status) { return !UNPAID_EXCLUDED.includes(status); }

/** 상태 배지 HTML */
function statusBadge(status, labels = SALES_STATUS_LABEL, classes = SALES_STATUS_CLS) {
  return `<span class="status-badge ${classes[status] || 's-draft'}">${esc(labels[status] || status || '')}</span>`;
}

/* ── 포맷 ──────────────────────────────────────────────────── */
/** 로컬 시간 기준 YYYY-MM-DD. toISOString() 은 UTC 라 KST 새벽에 전날이 나온다. */
function today() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
/** 금액 — 항상 '원'까지 붙인다 (화면마다 표기가 달랐다) */
function won(n) { return `${Math.round(Number(n) || 0).toLocaleString()}원`; }
/** 금액 숫자만 */
function num(n) { return (Math.round(Number(n) || 0)).toLocaleString(); }
/** 수량 — REAL 이라 0.30000000000000004 같은 값이 그대로 노출될 수 있다 */
function qty(n) {
  const v = Number(n) || 0;
  return Number.isInteger(v) ? String(v) : String(Math.round(v * 1000) / 1000);
}
/** HTML 이스케이프 — innerHTML 에 넣는 사용자 입력에 반드시 적용 */
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]
  ));
}

/* ── 토스트 ────────────────────────────────────────────────── */
function toast(msg, kind = 'info') {
  let box = document.getElementById('cs-toast');
  if (!box) {
    box = document.createElement('div');
    box.id = 'cs-toast';
    box.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);z-index:9999;' +
                        'display:flex;flex-direction:column;gap:8px;align-items:center';
    document.body.appendChild(box);
  }
  const bg = kind === 'error' ? '#dc2626' : kind === 'ok' ? '#15803d' : '#334155';
  const el = document.createElement('div');
  el.style.cssText = `background:${bg};color:#fff;padding:10px 18px;border-radius:8px;font-size:13px;` +
                     'box-shadow:0 4px 12px rgba(0,0,0,.15);max-width:80vw';
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => el.remove(), kind === 'error' ? 5000 : 2500);
}

/* ── 제출 버튼 가드 ────────────────────────────────────────── */
/** 연타로 중복 주문서·중복 입금이 생기던 것을 막는다.
 *  사용: onclick="guard(this, submitPayment)" 또는 await guard(btn, fn) */
async function guard(btn, fn) {
  if (!btn || btn.disabled) return;
  btn.disabled = true;
  const old = btn.textContent;
  btn.textContent = '처리 중…';
  try { return await fn(); }
  finally { btn.disabled = false; btn.textContent = old; }
}

/* ── 검색 ──────────────────────────────────────────────────── */
/** 여러 필드에 대한 부분일치. 공백으로 나눈 모든 토큰이 포함돼야 한다. */
function matches(query, ...fields) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return true;
  const hay = fields.map(f => String(f ?? '').toLowerCase()).join(' ');
  return q.split(/\s+/).every(tok => hay.includes(tok));
}
/** 입력 이벤트 과다 호출 방지 */
function debounce(fn, ms = 200) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
