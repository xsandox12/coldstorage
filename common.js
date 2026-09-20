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

/* ── 로그인 사용자 ─────────────────────────────────────────── */
/** 현재 사용자. api.js 로드 후 자동으로 채워진다. */
let ME = null;
/** 사이드바에 이름을 띄운다. nav 는 7개 파일에 복붙돼 있어 HTML 을 고치면
 *  7곳을 고쳐야 하므로, 로그아웃 링크를 찾아 그 위에 끼워 넣는다. */
async function initNavUser() {
  try { ME = await api.get('/api/me'); } catch { return; }
  const logout = document.querySelector('a[href="/logout"]');
  if (!logout || document.getElementById('nav-me')) return;
  const el = document.createElement('a');
  el.id = 'nav-me';
  el.href = '/account.html';
  el.className = 'nav-link';
  el.title = '계정 설정';
  el.innerHTML = `<span>👤</span><span class="truncate">${esc(ME.name || ME.username)}</span>` +
                 (ME.role === 'admin' ? '<span class="text-[10px] text-blue-300 ml-auto">관리자</span>' : '');
  logout.parentNode.insertBefore(el, logout);
}
document.addEventListener('DOMContentLoaded', initNavUser);

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
/** 날짜 문자열이 [from, to] 안에 드는가. 빈 값은 제한 없음. */
function inRange(date, from, to) {
  const d = String(date || '');
  if (from && d < from) return false;
  if (to && d > to) return false;
  return true;
}

/* ── 점진 렌더 ─────────────────────────────────────────────
 * 목록 화면 4개가 전체 결과를 한 번에 innerHTML 로 그렸다. 건수가 쌓이면
 * 검색 입력 한 글자마다 수천 행을 다시 그리게 된다. 화면당 일정 개수만 그리고
 * "더 보기" 로 늘린다. */
const PAGE_SIZE = 60;
/** rows 중 앞에서 shown 개만 html 로 만들고, 남으면 "더 보기" 버튼을 붙인다 */
function pagedHtml(rows, shown, rowHtml, moreFn, emptyText = '항목 없음') {
  if (!rows.length) return `<div class="p-6 text-center text-slate-400 text-sm">${esc(emptyText)}</div>`;
  const slice = rows.slice(0, shown);
  const rest  = rows.length - slice.length;
  return slice.map(rowHtml).join('') + (rest > 0
    ? `<div class="p-3 text-center"><button onclick="${moreFn}()"
         class="text-xs px-4 py-1.5 border border-slate-200 rounded-lg hover:bg-slate-50 text-slate-600">
         ${rest}건 더 보기</button></div>`
    : `<div class="p-2 text-center text-xs text-slate-300">${rows.length}건</div>`);
}

/** CSV 내려받기 — 필터를 그대로 붙여 서버가 만든 파일을 받는다 */
function exportCsv(resource, params = {}) {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== '' && v != null));
  location.href = `/api/export/${resource}?${qs}`;
}

/* 모달에서 Enter 로 확인 — <form> 태그가 한 곳도 없어 지금까지 Enter 가
 * 아무 일도 하지 않았다. 입력 하나 치고 마우스로 버튼을 찾아야 했다.
 * 모달마다 마지막 버튼이 확인 동작이라는 규칙(전 화면 일치)을 그대로 쓴다. */
document.addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  if (e.isComposing || e.keyCode === 229) return;   // 한글 조합 확정용 Enter 는 제외
  const el = e.target;
  if (!el || el.tagName !== 'INPUT') return;        // textarea 는 줄바꿈이 맞다
  if (['checkbox','radio','button','submit'].includes(el.type)) return;
  const modal = el.closest('[id$="modal"]');
  if (!modal || modal.classList.contains('hidden')) return;
  const btns = modal.querySelectorAll('button');
  const ok = btns[btns.length - 1];
  if (!ok || ok.disabled) return;
  e.preventDefault();
  ok.click();
});
