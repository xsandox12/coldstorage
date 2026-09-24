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
  // 보이는 버튼만 — 판매 새 모달은 탭 두 개가 한 모달 안에 있어, 숨은 탭의
  // 확인 버튼을 누르면 보고 있지도 않은 경로가 실행된다 (click 은 그래도 먹는다)
  const btns = [...modal.querySelectorAll('button')].filter(b => b.offsetParent !== null);
  const ok = btns[btns.length - 1];
  if (!ok || ok.disabled) return;
  e.preventDefault();
  ok.click();
});

/* 검색·기간 초기화 — 판매·구매·입금·A/S 네 화면이 같은 id(search/from/to)를
 * 쓰고 각자 applyFilters() 를 갖고 있어, 네 곳에 글자 하나까지 같은 사본이 있었다. */
function clearFilters() {
  for (const id of ['search','from','to']) { const el = document.getElementById(id); if (el) el.value = ''; }
  applyFilters();
}

/* ── 거래처 선택 ────────────────────────────────────────────────
 * 지금까지 새 판매 모달의 고객 칸은 <select> 였다. 목록에 없으면 "고객을
 * 선택하세요" 로 막혀 고객 화면으로 나갔다 와야 했고, 쓰던 내용은 날아갔다.
 * 실측으로 판매 15건 전부 고객이 연결돼 있지 않았다 — 아무도 안 쓴 것이다.
 *
 * 여기서는 입력하면 걸러지는 목록을 띄우고, 없으면 그 자리에서 만든다.
 *   customerPicker.mount('cust-box', { onPick })
 *   await customerPicker.resolve('cust-box')   // 고른 id 또는 새로 만든 id
 */
const customerPicker = (() => {
  const boxes = new Map();   // elId -> state

  const row = (c, active) => `
    <div class="cp-item px-3 py-2 text-sm cursor-pointer ${active ? 'bg-blue-50' : 'hover:bg-slate-50'}"
         data-id="${esc(c.id)}">
      ${esc(c.name)}${c.rep ? `<span class="text-xs text-slate-400"> · ${esc(c.rep)}</span>` : ''}
      ${c.business_no ? `<span class="text-xs text-slate-300"> · ${esc(c.business_no)}</span>` : ''}
    </div>`;

  function render(st) {
    const q = st.input.value.trim();
    const hit = st.list.filter(c => !q || `${c.name} ${c.rep||''} ${c.business_no||''}`.toLowerCase().includes(q.toLowerCase()));
    const exact = st.list.some(c => c.name === q);
    st.drop.innerHTML =
      hit.slice(0, 30).map(c => row(c, c.id === st.picked)).join('') +
      (q && !exact ? `<div class="cp-new px-3 py-2 text-sm cursor-pointer bg-emerald-50 text-emerald-700 hover:bg-emerald-100 border-t border-emerald-100">
           + "${esc(q)}" 새 거래처로 등록</div>` : '') +
      (!hit.length && !q ? `<div class="px-3 py-2 text-sm text-slate-400">등록된 거래처가 없습니다. 상호를 입력하세요.</div>` : '');
    st.drop.classList.remove('hidden');
  }

  function close(st) { st.drop.classList.add('hidden'); }

  /** 새 거래처 입력칸 펼치기 */
  function openNewFields(st, name) {
    st.picked = null;
    st.input.value = name;
    st.extra.classList.remove('hidden');
    st.extra.querySelector('.cp-rep').focus();
    close(st);
  }

  return {
    /** el 안에 픽커를 그린다. customers 목록은 mount 시점에 받는다. */
    mount(elId, { customers = [], placeholder = '상호로 검색하거나 새로 입력' } = {}) {
      const el = document.getElementById(elId);
      if (!el) return;
      el.innerHTML = `
        <div class="relative">
          <input class="cp-input w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-400"
                 placeholder="${esc(placeholder)}" autocomplete="off">
          <div class="cp-drop hidden absolute z-20 left-0 right-0 mt-1 bg-white border border-slate-200 rounded-lg shadow-lg max-h-56 overflow-y-auto"></div>
        </div>
        <div class="cp-extra hidden grid grid-cols-3 gap-2 mt-2">
          <input class="cp-rep border border-slate-200 rounded-lg px-2 py-1.5 text-xs" placeholder="대표자">
          <input class="cp-bno border border-slate-200 rounded-lg px-2 py-1.5 text-xs" placeholder="사업자번호">
          <input class="cp-phone border border-slate-200 rounded-lg px-2 py-1.5 text-xs" placeholder="전화">
          <div class="col-span-3 text-xs text-emerald-600">새 거래처로 등록됩니다. 나머지 정보는 나중에 채워도 됩니다.</div>
        </div>`;
      const st = {
        el,
        input: el.querySelector('.cp-input'),
        drop:  el.querySelector('.cp-drop'),
        extra: el.querySelector('.cp-extra'),
        list:  customers,
        picked: null,
      };
      boxes.set(elId, st);

      st.input.addEventListener('focus', () => render(st));
      st.input.addEventListener('input', () => { st.picked = null; st.extra.classList.add('hidden'); render(st); });
      st.drop.addEventListener('mousedown', e => {
        const item = e.target.closest('.cp-item');
        if (item) {
          st.picked = item.dataset.id;
          st.input.value = st.list.find(c => c.id === st.picked)?.name || '';
          st.extra.classList.add('hidden');
          close(st);
          return;
        }
        if (e.target.closest('.cp-new')) openNewFields(st, st.input.value.trim());
      });
      // 바깥을 누르면 닫는다. blur 로 닫으면 목록 클릭이 먹지 않는다.
      document.addEventListener('mousedown', e => { if (!el.contains(e.target)) close(st); });
      return st;
    },

    /** 목록 갱신 (거래처를 새로 만든 뒤 등) */
    setList(elId, customers) { const st = boxes.get(elId); if (st) st.list = customers; },

    /** 현재 입력값 */
    value(elId) {
      const st = boxes.get(elId);
      return st ? { id: st.picked, name: st.input.value.trim() } : { id: null, name: '' };
    },

    reset(elId) {
      const st = boxes.get(elId);
      if (!st) return;
      st.picked = null; st.input.value = '';
      st.extra.classList.add('hidden');
      st.extra.querySelectorAll('input').forEach(i => i.value = '');
      close(st);
    },

    /** 고른 거래처의 id 를 돌려준다. 새 상호면 그 자리에서 만들고 id 를 돌려준다.
     *  상호가 비어 있으면 null (호출부가 안내한다). */
    async resolve(elId) {
      const st = boxes.get(elId);
      if (!st) return null;
      if (st.picked) return st.picked;
      const name = st.input.value.trim();
      if (!name) return null;
      const same = st.list.find(c => c.name === name);
      if (same) { st.picked = same.id; return same.id; }

      const r = await api.post('/api/customers', {
        name,
        rep:         st.extra.querySelector('.cp-rep').value.trim(),
        business_no: st.extra.querySelector('.cp-bno').value.trim(),
        phone:       st.extra.querySelector('.cp-phone').value.trim(),
      });
      if (r?.similar?.length) {
        toast(`상호가 비슷한 거래처가 있습니다: ${r.similar.map(c => c.name).join(', ')}`, 'error');
      }
      st.picked = r.id;
      return r.id;
    },
  };
})();
