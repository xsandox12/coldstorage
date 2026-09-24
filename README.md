# ColdStorage Master

냉동창고 영업관리 — 견적 · 판매 · 구매 · 입금 · A/S · 도면.

Node.js 순수 `http` 모듈 + `better-sqlite3`. 프론트는 빌드 도구 없이 Tailwind CDN + 바닐라 JS라
파일을 고치고 새로고침하면 바로 반영된다.

## 실행

```bash
npm install
ADMIN_PASSWORD=원하는비밀번호 node server.js     # http://localhost:9000
```

데이터가 비어 있으면 첫 기동에 `ADMIN_USER`(기본 `admin`) 계정이 만들어진다.
**`ADMIN_PASSWORD` 를 주지 않으면 계정이 생기지 않아 아무도 로그인할 수 없다.**
계정이 한 번 만들어진 뒤에는 이 값이 무시되므로, 비밀번호는 `/account.html` 에서 바꾼다.

환경변수는 `.env.example` 참고. `PORT`, `DATA_DIR` 로 포트와 데이터 위치를 바꿀 수 있다.

## 테스트

```bash
bash test/smoke.sh        # 엔드포인트 단위 (201건)
bash test/scenarios.sh    # 실무 업무 흐름 (126건)
```

`smoke.sh` 는 API 하나하나를 보고, `scenarios.sh` 는 회사가 일하는 순서대로 이어서
밟는다 (수주→계약금→분할출고→잔금→완료, 되돌리기, 월말 마감,
견적 한 건을 화면을 떠나지 않고 끝까지 작성하는 흐름 등).

`BASE` 를 주지 않으면 임시 `DATA_DIR` 과 빈 포트로 서버를 직접 띄우므로 실제 데이터를
건드리지 않는다. 운영 중인 서버를 검사하려면 `BASE=https://... bash test/smoke.sh`.

## 배포

미니PC에서 Docker Compose + Cloudflare 터널로 `coldstorage.agonyang.com` 을 서비스한다.
컨테이너 포트는 `127.0.0.1:9000` 에만 묶여 있어 터널을 통해서만 도달한다.

```bash
cd ~/coldstorage && git pull && docker compose up -d --build
```

Compose 는 `.env` 가 비어 있을 때 `APP_PASSWORD` 기본값 `0000` 으로 최초 관리자를
만든다 — 아무도 로그인 못 하는 상태로 배포되는 것을 막기 위한 값이다.
**배포 직후 `/account.html` 에서 반드시 바꿀 것.**

**비밀번호는 커밋하지 않는다.** 공개 저장소이므로 실제 값은 서버의 `~/coldstorage/.env`
에만 두고, 바꿀 때도 그 파일을 고친 뒤 `docker compose up -d` 한다.

## 도면

도면 앱의 원본은 별도 저장소 `drawingtool` 이고, 이 저장소는 사본을 서빙한다.
같은 출처여야 `/api/drawings` 저장이 동작하기 때문이다 — `drawingtool.agonyang.com` 은
nginx 가 정적 파일만 서빙해 저장이 조용히 사라진다.

```bash
./tools/sync-drawing.sh            # 원본에서 복사
./tools/sync-drawing.sh --check    # 배포 전 드리프트 확인 (다르면 exit 1)
```

판매 상세의 "도면 연동" 으로 열면 `?mode=apply` 가 붙고, 도면에서 "견적서 생성" 을
누르면 BOM 이 품목으로 들어오며 `quotations.drawing_id` 에 도면이 연결된다.

## 구조

| | |
|---|---|
| `server.js` | 전체 API. 라우팅은 위에서부터 `pathname` 매칭 — 전용 라우트가 제네릭 `/api/:resource` 보다 **앞**에 있어야 한다 |
| `common.js` | 상태 라벨·이스케이프·날짜·페이지네이션 등 화면 공통 헬퍼 |
| `api.js` | `fetch` 래퍼. `res.ok` 검사와 401 → 로그인 이동을 여기서 한다 |
| `print.html` | 견적서 / 거래명세서 A4 인쇄 |
| `test/smoke.sh` | curl 기반 스모크 테스트 |

### 알아둘 점

- `quotations` 한 테이블이 견적과 판매를 겸한다. 구분은 `order_status`.
- `total` 은 **부가세 포함 합계**다. 미수금이 `total - total_paid` 이고 입금은 세포함으로
  들어오므로, 공급가액으로 두면 미수금이 전건 10% 어긋난다.
- 부가세는 행별이 아니라 **문서 단위로 한 번** 계산한다. 행별 합산은 세금계산서와
  거래명세서를 불일치시킨다.
- 판매·구매 번호는 **서버가 매긴다**. 화면에서 세면 다른 사람이 만든 건을 몰라 겹친다.
- 금액·상태 캐시 컬럼은 제네릭 `PUT`/`PATCH` 로 못 바꾼다. 전용 엔드포인트
  (`/status`, `/cancel`, `/uncomplete`, `/order_items/order/:id` …)를 쓴다.
- 품목 이름은 같은 물건이어도 띄어쓰기·괄호가 제각각이다 (`우레탄판넬 회색스타코` /
  `우레탄판넬 (회색스타코)`). 카탈로그 중복 검사와 단가 힌트는 `normItem` 으로
  정규화해 비교한다. 글자 그대로 비교하면 같은 품목이 계속 다시 등록된다.
- 할인은 **문서 단위**로 과세표준에서만 뺀다. 면세분은 건드리지 않는다.
- 견적 복사는 도면 연결을 가져오지 않는다. 같은 도면을 두 건이 함께 물면
  한쪽을 고칠 때 다른 쪽이 조용히 바뀐다.
