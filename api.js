/* ColdStorage Master — API 래퍼
 *
 * 기존에는 화면 전체 fetch 77곳에 res.ok 검사도 .catch 도 없었다. 그래서
 *  - 세션이 만료되면 화면이 빈 채로 멈추거나
 *  - 서버가 400/500 을 줘도 "저장됐습니다" 가 뜨고 새로고침하면 사라졌다.
 * 모든 호출을 여기로 통과시킨다.
 */

/** 서버가 돌려준 오류 메시지를 담는다 */
class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function apiFetch(path, options = {}) {
  let res;
  try {
    res = await fetch(path, options);
  } catch {
    throw new ApiError(0, '서버에 연결할 수 없습니다.');
  }

  if (res.status === 401) {
    // 세션 만료 — 조용히 실패하지 말고 로그인으로 보낸다
    location.href = '/login.html';
    throw new ApiError(401, '로그인이 필요합니다.');
  }

  const isJson = (res.headers.get('content-type') || '').includes('application/json');
  const data = isJson ? await res.json().catch(() => null) : null;

  if (!res.ok) {
    throw new ApiError(res.status, (data && data.error) || `요청이 실패했습니다. (${res.status})`);
  }
  // 서버가 200 과 함께 {ok:false} 를 주는 경로도 있다
  if (data && data.ok === false) {
    throw new ApiError(res.status, data.error || '요청이 실패했습니다.');
  }
  return data;
}

const api = {
  get:    path            => apiFetch(path),
  post:   (path, body)    => apiFetch(path, { method:'POST',   headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) }),
  put:    (path, body)    => apiFetch(path, { method:'PUT',    headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) }),
  patch:  (path, body)    => apiFetch(path, { method:'PATCH',  headers:{'Content-Type':'application/json'}, body: body === undefined ? undefined : JSON.stringify(body) }),
  del:    path            => apiFetch(path, { method:'DELETE' }),
};

/* 안전망 — api.* 는 실패 시 예외를 던진다. 그 덕에 뒤따르는 "저장됐습니다" 알림은
 * 실행되지 않지만, 잡아주는 곳이 없으면 사용자는 아무 반응도 못 본다.
 * 명시적으로 tryApi 로 감싸지 않은 호출도 최소한 오류를 보이게 한다. */
window.addEventListener('unhandledrejection', ev => {
  const e = ev.reason;
  if (e instanceof ApiError) {
    ev.preventDefault();
    if (e.status !== 401) toast(e.message, 'error');
  }
});

/** 실패를 토스트로 알리고 조용히 넘어간다. 성공 여부를 boolean 으로 돌려준다.
 *  사용: if (!await tryApi(() => api.post(...), '저장됐습니다.')) return; */
async function tryApi(fn, okMessage) {
  try {
    const r = await fn();
    if (okMessage) toast(okMessage, 'ok');
    return r === undefined ? true : (r ?? true);
  } catch (e) {
    if (e.status !== 401) toast(e.message, 'error');
    return false;
  }
}
