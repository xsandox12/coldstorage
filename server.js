// ColdStorage Master — SQLite 백엔드
// node server.js  |  http://localhost:9000

const http     = require('http');
const fs       = require('fs');
const path     = require('path');
const url      = require('url');
const crypto   = require('crypto');
const Database = require('better-sqlite3');

const PORT     = Number(process.env.PORT) || 9000;
const ROOT     = __dirname;
// 테스트가 실 데이터를 건드리지 못하도록 DB 위치를 분리할 수 있게 한다
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ─── DB 초기화 ──────────────────────────────────────────────
const db = new Database(path.join(DATA_DIR, 'coldstorage.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS customers (
    id TEXT PRIMARY KEY,
    name TEXT DEFAULT '', rep TEXT DEFAULT '',
    business_no TEXT DEFAULT '', phone TEXT DEFAULT '',
    email TEXT DEFAULT '', address_post TEXT DEFAULT '',
    address_base TEXT DEFAULT '', address_detail TEXT DEFAULT '',
    status TEXT DEFAULT 'NORMAL', price_group TEXT DEFAULT 'A',
    -- 아래 둘은 갱신하는 코드가 없다. 고객 화면의 거래액·최근활동은 quotations
    -- 에서 집계해 그린다. 기존 데이터가 있어 남겨 두지만 쓰지 않는다.
    total_amount INTEGER DEFAULT 0, last_activity TEXT DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS quotations (
    id INTEGER PRIMARY KEY,
    no TEXT DEFAULT '', customer TEXT DEFAULT '',
    -- items 는 이름과 달리 품목이 아니라 한 줄 메모다 (품목은 order_items).
    -- 운영 데이터가 들어 있어 이름만 고치려고 옮기지 않는다.
    items TEXT DEFAULT '', total INTEGER DEFAULT 0,
    payment TEXT DEFAULT '', drawing INTEGER DEFAULT 0,
    accounting INTEGER DEFAULT 0, printed INTEGER DEFAULT 0,
    ref TEXT DEFAULT '', date TEXT DEFAULT '', status TEXT DEFAULT '진행중',
    customer_id TEXT DEFAULT '', drawing_id TEXT DEFAULT '',
    order_status TEXT DEFAULT 'draft', total_paid INTEGER DEFAULT 0,
    -- items_json / status / printed / payment / accounting 은 order_items 와
    -- order_status 로 대체된 옛 컬럼이다. 읽는 코드가 없다.
    items_json TEXT DEFAULT '[]'
  );
  CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER REFERENCES quotations(id) ON DELETE CASCADE,
    name TEXT DEFAULT '', spec TEXT DEFAULT '',
    unit TEXT DEFAULT 'EA', qty REAL DEFAULT 0,
    unit_price INTEGER DEFAULT 0, shipped_qty REAL DEFAULT 0,
    note TEXT DEFAULT '',
    sort_order INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER REFERENCES quotations(id) ON DELETE CASCADE,
    amount INTEGER NOT NULL,
    paid_at TEXT DEFAULT '',
    note TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS shipments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER REFERENCES quotations(id) ON DELETE CASCADE,
    item_id INTEGER REFERENCES order_items(id),
    qty REAL NOT NULL,
    shipped_at TEXT DEFAULT '',
    note TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS as_records (
    id TEXT PRIMARY KEY,
    -- proj_id 는 가리키는 테이블이 없다 (projects 테이블은 존재한 적이 없다)
    proj_id TEXT DEFAULT '', cust_id TEXT DEFAULT '',
    cust_name TEXT DEFAULT '', phone TEXT DEFAULT '',
    type TEXT DEFAULT 'NORMAL', issue TEXT DEFAULT '',
    desc TEXT DEFAULT '', status TEXT DEFAULT 'OPEN', date TEXT DEFAULT '',
    urgency TEXT DEFAULT 'NORMAL', assignee TEXT DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS drawings (
    id TEXT PRIMARY KEY,
    starred INTEGER DEFAULT 0,
    data TEXT DEFAULT '{}'
  );
  CREATE TABLE IF NOT EXISTS blobs (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cat1 TEXT DEFAULT '',
    cat2 TEXT DEFAULT '',
    cat3 TEXT DEFAULT '',
    cat4 TEXT DEFAULT '',
    name TEXT DEFAULT '',
    unit TEXT DEFAULT '',
    price INTEGER DEFAULT 0,
    note TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS purchases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    no TEXT DEFAULT '',
    vendor TEXT DEFAULT '',
    vendor_id TEXT DEFAULT '',
    items TEXT DEFAULT '',
    total INTEGER DEFAULT 0,
    total_paid INTEGER DEFAULT 0,
    purchase_status TEXT DEFAULT 'draft',
    date TEXT DEFAULT '',
    memo TEXT DEFAULT '',
    status TEXT DEFAULT '진행중'
  );
  CREATE TABLE IF NOT EXISTS purchase_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    purchase_id INTEGER REFERENCES purchases(id) ON DELETE CASCADE,
    name TEXT DEFAULT '',
    spec TEXT DEFAULT '',
    unit TEXT DEFAULT 'EA',
    qty REAL DEFAULT 0,
    unit_price INTEGER DEFAULT 0,
    received_qty REAL DEFAULT 0,
    note TEXT DEFAULT '',
    sort_order INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS purchase_payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    purchase_id INTEGER REFERENCES purchases(id) ON DELETE CASCADE,
    amount INTEGER NOT NULL,
    paid_at TEXT DEFAULT '',
    note TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS purchase_receipts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    purchase_id INTEGER REFERENCES purchases(id) ON DELETE CASCADE,
    item_id INTEGER REFERENCES purchase_items(id),
    qty REAL NOT NULL,
    received_at TEXT DEFAULT '',
    note TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// ─── 신규 테이블 ────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS shipment_batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_no TEXT UNIQUE NOT NULL,
    shipped_at TEXT DEFAULT '',
    note TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS completion_batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_no TEXT UNIQUE NOT NULL,
    completed_at TEXT DEFAULT '',
    note TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS status_changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER,
    from_status TEXT DEFAULT '',
    to_status TEXT DEFAULT '',
    changed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    reason TEXT DEFAULT ''
  );
  -- 자주 나가는 품목 묶음. blobs.templates 는 도면 쪽 슬롯이라 섞지 않는다.
  CREATE TABLE IF NOT EXISTS item_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT DEFAULT '',
    items_json TEXT DEFAULT '[]',
    created_by TEXT DEFAULT '',
    created_at TEXT DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS quotation_sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER,
    source_quotation_id INTEGER,
    source_item_ids TEXT DEFAULT '[]'
  );
  -- 사내 계정. TABLES 에 등록하지 않는다 — 제네릭 CRUD 가 열리면
  -- GET /api/users 로 password_hash 가 그대로 나가고 POST 로 관리자를 만들 수 있다.
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    name TEXT DEFAULT '',
    role TEXT DEFAULT 'staff',
    active INTEGER DEFAULT 1,
    token_version INTEGER DEFAULT 1,   -- 퇴사·비밀번호 변경 시 +1 → 발급된 토큰 전부 무효화
    created_at TEXT DEFAULT '',
    last_login_at TEXT DEFAULT ''
  );
`);

// ─── 마이그레이션 ────────────────────────────────────────────
// 기존 테이블 컬럼 추가 (없을 때만)
for (const sql of [
  `ALTER TABLE quotations ADD COLUMN customer_id TEXT DEFAULT ''`,
  `ALTER TABLE quotations ADD COLUMN drawing_id TEXT DEFAULT ''`,
  `ALTER TABLE quotations ADD COLUMN order_status TEXT DEFAULT 'draft'`,
  `ALTER TABLE quotations ADD COLUMN total_paid INTEGER DEFAULT 0`,
  `ALTER TABLE quotations ADD COLUMN items_json TEXT DEFAULT '[]'`,
  `ALTER TABLE quotations ADD COLUMN memo_customer TEXT DEFAULT ''`,
  `ALTER TABLE quotations ADD COLUMN memo_internal TEXT DEFAULT ''`,
  `ALTER TABLE quotations ADD COLUMN cancelled_at TEXT DEFAULT ''`,
  `ALTER TABLE quotations ADD COLUMN cancelled_reason TEXT DEFAULT ''`,
  `ALTER TABLE quotations ADD COLUMN completion_batch_id INTEGER`,
  `ALTER TABLE shipments ADD COLUMN batch_id INTEGER`,
  `ALTER TABLE as_records ADD COLUMN urgency TEXT DEFAULT 'NORMAL'`,
  `ALTER TABLE as_records ADD COLUMN assignee TEXT DEFAULT ''`,
  // 행위자 기록 — 지금까지 어떤 엔드포인트도 "누가 했는지" 를 몰랐다
  `ALTER TABLE status_changes ADD COLUMN user_id INTEGER`,
  `ALTER TABLE status_changes ADD COLUMN user_name TEXT DEFAULT ''`,
  `ALTER TABLE quotations ADD COLUMN created_by TEXT DEFAULT ''`,
  `ALTER TABLE purchases ADD COLUMN created_by TEXT DEFAULT ''`,
  `ALTER TABLE as_records ADD COLUMN created_by TEXT DEFAULT ''`,
  `ALTER TABLE as_records ADD COLUMN assignee_id INTEGER`,
  /* 견적 문서용 항목. 지금까지 현장명·납기·결제조건은 자유 메모에 섞여 들어가
   * 문서에 정형으로 찍히지 않았고, 유효기간은 인쇄 화면에 30일로 박혀 있었다. */
  `ALTER TABLE quotations ADD COLUMN site_name TEXT DEFAULT ''`,
  `ALTER TABLE quotations ADD COLUMN valid_until TEXT DEFAULT ''`,
  `ALTER TABLE quotations ADD COLUMN delivery_terms TEXT DEFAULT ''`,
  `ALTER TABLE quotations ADD COLUMN payment_terms TEXT DEFAULT ''`,
  `ALTER TABLE quotations ADD COLUMN discount INTEGER DEFAULT 0`,
  // 구매 취소 — 판매와 대칭. 해제 시 돌아갈 상태를 직접 들고 있는다
  // (판매는 status_changes 에서 읽지만 구매에는 이력 테이블이 없다)
  `ALTER TABLE purchases ADD COLUMN cancelled_at TEXT DEFAULT ''`,
  `ALTER TABLE purchases ADD COLUMN cancelled_reason TEXT DEFAULT ''`,
  `ALTER TABLE purchases ADD COLUMN cancelled_from TEXT DEFAULT ''`,
  /* 부가세 — total 은 "부가세 포함 합계" 로 확정한다.
   * 미수금이 total - total_paid 이고 total_paid 는 실입금액(세포함)이므로
   * total 을 공급가액으로 두면 미수금이 전건 10% 어긋난다. */
  `ALTER TABLE quotations ADD COLUMN supply_amount INTEGER DEFAULT 0`,
  `ALTER TABLE quotations ADD COLUMN exempt_amount INTEGER DEFAULT 0`,
  `ALTER TABLE quotations ADD COLUMN vat_amount    INTEGER DEFAULT 0`,
  `ALTER TABLE quotations ADD COLUMN vat_mode      TEXT DEFAULT 'EXCLUSIVE'`,
  `ALTER TABLE quotations ADD COLUMN vat_rate      REAL DEFAULT 0.1`,
  `ALTER TABLE purchases  ADD COLUMN supply_amount INTEGER DEFAULT 0`,
  `ALTER TABLE purchases  ADD COLUMN exempt_amount INTEGER DEFAULT 0`,
  `ALTER TABLE purchases  ADD COLUMN vat_amount    INTEGER DEFAULT 0`,
  `ALTER TABLE purchases  ADD COLUMN vat_mode      TEXT DEFAULT 'EXCLUSIVE'`,
  `ALTER TABLE purchases  ADD COLUMN vat_rate      REAL DEFAULT 0.1`,
  // 행 금액을 정수로 확정해 둔다. qty 가 REAL 이라 SUM(qty*unit_price) 는
  // INTEGER 컬럼에 REAL 로 들어가고, 거기서 뽑은 세액은 처음부터 틀린다.
  `ALTER TABLE order_items    ADD COLUMN amount   INTEGER DEFAULT 0`,
  `ALTER TABLE order_items    ADD COLUMN tax_free INTEGER DEFAULT 0`,
  `ALTER TABLE purchase_items ADD COLUMN amount   INTEGER DEFAULT 0`,
  `ALTER TABLE purchase_items ADD COLUMN tax_free INTEGER DEFAULT 0`,
]) { try { db.exec(sql) } catch {} }

// 인덱스 — PK/UNIQUE 외에 하나도 없어 목록·조인이 전부 full scan 이었다
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_order_items_order    ON order_items(order_id);
  CREATE INDEX IF NOT EXISTS idx_payments_order       ON payments(order_id);
  CREATE INDEX IF NOT EXISTS idx_shipments_order      ON shipments(order_id);
  CREATE INDEX IF NOT EXISTS idx_shipments_item       ON shipments(item_id);
  CREATE INDEX IF NOT EXISTS idx_shipments_batch      ON shipments(batch_id);
  CREATE INDEX IF NOT EXISTS idx_quotations_customer  ON quotations(customer_id);
  CREATE INDEX IF NOT EXISTS idx_quotations_status    ON quotations(order_status);
  CREATE INDEX IF NOT EXISTS idx_quotations_date      ON quotations(date);
  CREATE INDEX IF NOT EXISTS idx_purchase_items_p     ON purchase_items(purchase_id);
  CREATE INDEX IF NOT EXISTS idx_purchase_pay_p       ON purchase_payments(purchase_id);
  CREATE INDEX IF NOT EXISTS idx_purchase_recv_p      ON purchase_receipts(purchase_id);
  CREATE INDEX IF NOT EXISTS idx_purchase_recv_item   ON purchase_receipts(item_id);
  CREATE INDEX IF NOT EXISTS idx_status_changes_order ON status_changes(order_id);
  CREATE INDEX IF NOT EXISTS idx_as_status            ON as_records(status);
`);

// 이미 쌓인 고아 이력 정리 — 삭제된 주문의 이력이 남아 있다가 재사용된 id 로
// 새 주문에 달라붙는다 (deleteOne 의 ORPHAN_CHILDREN 참고)
db.exec(`
  DELETE FROM status_changes    WHERE order_id NOT IN (SELECT id FROM quotations);
  DELETE FROM quotation_sources WHERE order_id NOT IN (SELECT id FROM quotations);
`);

/* 판매번호 중복 방지. COUNT 기반 채번이 이미 운영에 나가 있어 기존 데이터에
 * 중복이 있을 수 있다 — 인덱스 생성 실패로 서버가 못 뜨는 일이 없도록 감싼다. */
try {
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_quotations_no ON quotations(no)`);
} catch (e) {
  const dups = db.prepare(`SELECT no FROM quotations GROUP BY no HAVING COUNT(*) > 1`).all();
  console.error('판매번호 중복이 있어 UNIQUE 인덱스를 만들지 못했습니다:', dups.map(d => d.no).join(', '));
}

// 숫자로 들어와 "…​.0" 으로 저장돼 버린 도면 id 를 정상화한다 (drawingId 참고).
// 이미 정상 id 가 따로 있으면 PK 가 충돌하므로 건드리지 않는다. 멱등.
db.exec(`
  UPDATE drawings SET id = rtrim(rtrim(id, '0'), '.')
   WHERE id LIKE '%.0'
     AND rtrim(rtrim(id, '0'), '.') NOT IN (SELECT id FROM drawings);
`);

/* 거래처 id 는 지금까지 화면에서 Date.now() 로 만들었다. 서버가 매기면 번호가
 * 이어져 읽기 쉽고, 마이그레이션처럼 한 번에 여러 건을 만들 때도 겹치지 않는다. */
function nextCustomerId() {
  const row = db.prepare(`SELECT MAX(CAST(substr(id, 6) AS INTEGER)) AS m FROM customers WHERE id LIKE 'CUST-%'`).get();
  return 'CUST-' + String((row?.m || 0) + 1).padStart(4, '0');
}

/* 상호 비교용 정규화 — "주식회사 명일", "(주)명일", "명일" 을 같게 본다.
 * 자동으로 합치지는 않는다. 사람이 판단할 일이라 알려주기만 한다. */
const normName = s => String(s || '')
  .replace(/주식회사|\(주\)|㈜|\(유\)|유한회사/g, '')
  .replace(/\s+/g, '')
  .toLowerCase();

/* 품목 비교용 정규화. 실제 입력을 보면 같은 물건이 "우레탄판넬 회색스타코",
 * "우레탄판넬 (회색스타코)", "우레탄판넬(회색스타코)" 세 가지로 적혀 있다.
 * 글자 그대로 비교하면 카탈로그에 이미 있는 품목을 계속 다시 등록한다. */
const normItem = (name, spec) => (String(name || '') + '|' + String(spec || ''))
  .replace(/[\s()[\]{}·・,\-_/]/g, '')
  .toLowerCase();

/** 정규화하면 같아지는 거래처 묶음 (2곳 이상인 것만) */
function similarGroups() {
  const by = new Map();
  for (const c of db.prepare('SELECT id,name FROM customers').all()) {
    const k = normName(c.name);
    if (!k) continue;
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(c.name);
  }
  return [...by.values()].filter(g => g.length > 1);
}

/* 일회성 데이터 마이그레이션. ALTER 는 재적용해도 안전하지만 값 채우기는 아니다
 * — 두 번 돌면 사용자가 바꿔 둔 과세구분을 덮어쓴다. user_version 으로 한 번만. */
const SCHEMA_VERSION = 2;
const schemaVer = db.pragma('user_version', { simple: true }) || 0;
if (schemaVer < 1) {
  db.transaction(() => {
    // 기존 행 금액을 정수로 확정
    for (const t of ['order_items', 'purchase_items']) {
      db.exec(`UPDATE ${t} SET amount = CAST(ROUND(qty * unit_price) AS INTEGER) WHERE amount = 0`);
    }
    /* 기존 주문·구매의 total 이 세전인지 세후인지는 기록이 없다. total 을 그대로
     * 보존하는 쪽을 택한다 — 미수금(total - total_paid)이 어긋나면 안 된다.
     * 세포함으로 보고 공급가액을 역산하고, 부가세는 반드시 차액으로 구한다
     * (따로 계산하면 supply + vat != total 이 되어 1원씩 깨진다). */
    for (const t of ['quotations', 'purchases']) {
      db.exec(`UPDATE ${t} SET
                 vat_mode      = 'INCLUSIVE',
                 vat_rate      = 0.1,
                 supply_amount = CAST(ROUND(total / 1.1) AS INTEGER),
                 vat_amount    = total - CAST(ROUND(total / 1.1) AS INTEGER),
                 exempt_amount = 0
               WHERE total > 0 AND supply_amount = 0 AND vat_amount = 0 AND exempt_amount = 0`);
    }
  })();
  console.log('부가세 컬럼 마이그레이션 완료 (기존 금액은 세포함으로 보존).');
}

/* v2 — 판매의 customer 텍스트를 실제 거래처로 승격한다.
 * 지금까지 고객 선택이 화면을 떠나야 하는 일이라 아무도 등록하지 않았고, 그 결과
 * 견적서 공급받는자 칸의 사업자번호·연락처·주소가 전 건에서 빈칸으로 나갔다.
 * 상호만 채운 거래처를 만들어 연결한다 — 나머지는 쓰면서 채워 넣으면 된다.
 * 금액은 건드리지 않는다. */
if (schemaVer < 2) {
  const made = [], linked = [];
  db.transaction(() => {
    const rows = db.prepare(`SELECT DISTINCT customer FROM quotations
                             WHERE IFNULL(customer,'') != '' AND IFNULL(customer_id,'') = ''`).all();
    for (const { customer } of rows) {
      let c = db.prepare('SELECT id FROM customers WHERE name = ?').get(customer);
      if (!c) {
        const id = nextCustomerId();
        db.prepare('INSERT INTO customers (id,name) VALUES (?,?)').run(id, customer);
        c = { id };
        made.push(`${customer}(${id})`);
      }
      const n = db.prepare(`UPDATE quotations SET customer_id = ?
                            WHERE customer = ? AND IFNULL(customer_id,'') = ''`).run(c.id, customer).changes;
      linked.push(n);
    }
  })();
  if (made.length || linked.length) {
    console.log(`거래처 연결: 신규 ${made.length}곳 / 판매 ${linked.reduce((a,b)=>a+b,0)}건`);
    // 상호 표기만 다른 같은 회사가 따로 등록됐을 수 있다 — 지우지 않고 알리기만 한다
    const dup = similarGroups();
    if (dup.length) console.log('  상호가 비슷한 거래처가 있습니다(확인 필요):', dup.map(g => g.join(' / ')).join(' | '));
  }
}
db.pragma(`user_version = ${SCHEMA_VERSION}`);

// JSON → SQLite 최초 마이그레이션
(function migrate() {
  const dir = path.join(ROOT, 'db');
  if (!fs.existsSync(dir)) return;
  const load = f => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return null; } };
  const empty = tbl => db.prepare(`SELECT COUNT(*) as n FROM ${tbl}`).get().n === 0;

  if (empty('customers')) {
    const ins = db.prepare('INSERT OR IGNORE INTO customers VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
    db.transaction(() => (load('customers.json') || []).forEach(c =>
      ins.run(c.id, c.name||'', c.rep||'', c.business_no||'', c.phone||'', c.email||'',
        c.address_post||'', c.address_base||'', c.address_detail||'',
        c.status||'NORMAL', c.price_group||'A', c.total_amount||0, c.last_activity||'')
    ))();
  }

  if (empty('quotations')) {
    const ins = db.prepare(`INSERT OR IGNORE INTO quotations
      (id,no,customer,items,total,payment,drawing,accounting,printed,ref,date,status,customer_id,drawing_id,order_status,total_paid,items_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    db.transaction(() => (load('quotations.json') || []).forEach(q =>
      ins.run(q.id, q.no||'', q.customer||'', q.items||'', q.total||0, q.payment||'',
        q.drawing?1:0, q.accounting?1:0, q.printed?1:0, q.ref||'', q.date||'', q.status||'완료',
        '', '', 'done', 0, '[]')
    ))();
  }

  for (const [key, file] of [['inventory','inventory.json'],['templates','templates.json'],['settings','user_settings.json']]) {
    if (!db.prepare('SELECT 1 FROM blobs WHERE key=?').get(key)) {
      try { db.prepare('INSERT OR IGNORE INTO blobs(key,value) VALUES(?,?)').run(key, fs.readFileSync(path.join(dir, file), 'utf8')); } catch {}
    }
  }
})();

// ─── 리소스 설정 ─────────────────────────────────────────────
/* settings 는 공급자 정보·도면 설정으로 쓰인다(print.html, companyName).
 * inventory / templates 는 읽는 화면이 아직 없다 — 재고 기능은 미구현이고
 * 판매·구매 어느 쪽도 재고를 증감시키지 않는다. 데이터가 들어 있어 남겨 둔다. */
const BLOB_KEYS = new Set(['inventory', 'templates', 'settings']);
const TABLES = {
  customers:   { table: 'customers',   int: false },
  quotations:  { table: 'quotations',  int: true  },
  as_records:  { table: 'as_records',  int: false },
  drawings:    { table: 'drawings',    int: false },
  order_items: { table: 'order_items', int: true  },
  products:       { table: 'products',       int: true  },
  purchases:      { table: 'purchases',      int: true  },
  purchase_items: { table: 'purchase_items', int: true  },
};

// ─── 직렬화 / 역직렬화 ──────────────────────────────────────
// 도면 id 는 TEXT PK 인데 도면 앱은 Date.now() 를 숫자로 보낸다. SQLite 가 REAL 을
// 거쳐 "1789911856476.0" 으로 저장해 버리면 "1789911856476" 으로 조회하는
// 삭제·즐겨찾기가 영영 맞지 않는다. 저장과 조회 양쪽을 같은 규칙으로 맞춘다.
const drawingId = v => String(v).replace(/\.0+$/, '');

function rowOut(table, row) {
  if (!row) return null;
  if (table === 'quotations') return { ...row, drawing: !!row.drawing, accounting: !!row.accounting, printed: !!row.printed };
  if (table === 'drawings') {
    const { id, starred, data } = row;
    return { id, starred: !!starred, ...JSON.parse(data || '{}') };
  }
  return row;
}

function rowIn(table, item) {
  if (table === 'quotations') return { ...item, drawing: item.drawing?1:0, accounting: item.accounting?1:0, printed: item.printed?1:0 };
  if (table === 'drawings') {
    const { id, starred, ...rest } = item;
    // drawings.id 는 TEXT 인데 도면 앱이 Date.now() 숫자를 보낸다. 그대로 넣으면
    // SQLite 가 REAL→TEXT 로 바꿔 "1789911856476.0" 이 되고, 삭제·즐겨찾기는
    // "1789911856476" 으로 조회해 영영 맞지 않는다. 문자열로 확정한다.
    return { id: drawingId(id), starred: starred?1:0, data: JSON.stringify(rest) };
  }
  return item;
}

// ─── CRUD 헬퍼 ───────────────────────────────────────────────
// ORDER BY 가 없으면 목록 순서가 DB 물리 순서라 불확정이다
const TABLE_ORDER = {
  quotations: 'id DESC', purchases: 'id DESC', as_records: 'date DESC, id DESC',
  customers: 'name', products: 'cat1, cat2, name', drawings: 'id DESC',
  order_items: 'sort_order, id', purchase_items: 'sort_order, id',
};
function getAll(cfg) {
  const order = TABLE_ORDER[cfg.table] ? ` ORDER BY ${TABLE_ORDER[cfg.table]}` : '';
  return db.prepare(`SELECT * FROM ${cfg.table}${order}`).all().map(r => rowOut(cfg.table, r));
}

/* ─── 목록 검색·필터·페이지네이션 ────────────────────────────
 * 그동안 서버는 쿼리스트링을 통째로 버렸고 LIMIT 도 없었다. 목록 화면 4개는
 * 검색 수단이 아예 없어 고객명으로 건을 찾을 방법이 없었다.
 *
 * 컬럼명은 아래 설정에서만 온다(클라이언트 값이 SQL 에 들어가지 않는다).
 * 값은 전부 바인딩한다. */
const LIST_QUERY = {
  quotations: { cols: ['no','customer','items','memo_customer','created_by'], status:'order_status',    date:'date' },
  purchases:  { cols: ['no','vendor','items','memo','created_by'],            status:'purchase_status', date:'date' },
  as_records: { cols: ['cust_name','issue','desc','phone','assignee'],        status:'status',          date:'date' },
  customers:  { cols: ['name','rep','business_no','phone','email'] },
  products:   { cols: ['name','cat1','cat2','cat3','cat4','note'] },
  payments:   { cols: ['note'], date:'paid_at' },
};
// 정렬 가능한 컬럼 — 클라이언트가 임의 문자열을 넣지 못하게 화이트리스트로
const SORTABLE = {
  quotations: ['id','date','total','no','order_status'],
  purchases:  ['id','date','total','no','purchase_status'],
  as_records: ['id','date','status','urgency'],
  customers:  ['name','id'],
  products:   ['name','price','id'],
  payments:   ['id','paid_at','amount'],
};
const LIST_LIMIT_MAX = 500;

/* CSV 내보내기 — 내보낼 컬럼과 머리글을 여기서만 정한다.
 * 내부 메모(memo_internal)처럼 나가면 안 되는 컬럼은 애초에 넣지 않는다. */
const SALES_ST  = { draft:'견적', ordered:'주문', partial:'부분출고', shipped:'출고', done:'완료', cancelled:'취소' };
const PUR_ST    = { draft:'작성중', ordered:'발주', partial:'부분입고', received:'입고완료', done:'정산완료' };
const AS_ST     = { OPEN:'미처리', IN_PROGRESS:'처리중', DONE:'완료', CLOSED:'종료' };
const VAT_MODE  = { EXCLUSIVE:'부가세 별도', INCLUSIVE:'부가세 포함' };
const EXPORT_COLUMNS = {
  quotations: [
    { label:'판매번호', key:'no' }, { label:'일자', key:'date' },
    { label:'고객', key:'customer' },
    { label:'상태', get:r => SALES_ST[r.order_status] || r.order_status },
    { label:'공급가액', key:'supply_amount' }, { label:'면세', key:'exempt_amount' },
    { label:'부가세', key:'vat_amount' }, { label:'합계', key:'total' },
    { label:'입금', key:'total_paid' },
    { label:'미수금', get:r => (r.total||0) - (r.total_paid||0) },
    { label:'과세방식', get:r => VAT_MODE[r.vat_mode] || r.vat_mode },
    { label:'작성자', key:'created_by' }, { label:'비고', key:'items' },
  ],
  purchases: [
    { label:'구매번호', key:'no' }, { label:'일자', key:'date' },
    { label:'공급업체', key:'vendor' },
    { label:'상태', get:r => PUR_ST[r.purchase_status] || r.purchase_status },
    { label:'공급가액', key:'supply_amount' }, { label:'면세', key:'exempt_amount' },
    { label:'부가세', key:'vat_amount' }, { label:'합계', key:'total' },
    { label:'결제', key:'total_paid' },
    { label:'미지급', get:r => (r.total||0) - (r.total_paid||0) },
    { label:'작성자', key:'created_by' }, { label:'비고', key:'items' },
  ],
  as_records: [
    { label:'접수일', key:'date' }, { label:'고객', key:'cust_name' },
    { label:'연락처', key:'phone' },
    { label:'상태', get:r => AS_ST[r.status] || r.status },
    { label:'긴급', get:r => r.urgency === 'EMERGENCY' ? '긴급' : '일반' },
    { label:'담당자', key:'assignee' },
    { label:'증상', key:'issue' }, { label:'메모', key:'desc' },
  ],
  customers: [
    { label:'상호명', key:'name' }, { label:'대표자', key:'rep' },
    { label:'사업자번호', key:'business_no' }, { label:'전화', key:'phone' },
    { label:'이메일', key:'email' },
    { label:'주소', get:r => `${r.address_base||''} ${r.address_detail||''}`.trim() },
    { label:'등급', key:'status' }, { label:'단가그룹', key:'price_group' },
  ],
  products: [
    { label:'대분류', key:'cat1' }, { label:'중분류', key:'cat2' },
    { label:'소분류', key:'cat3' }, { label:'세부', key:'cat4' },
    { label:'품목명', key:'name' }, { label:'단위', key:'unit' },
    { label:'단가', key:'price' }, { label:'비고', key:'note' },
  ],
  payments: [
    { label:'입금일', key:'paid_at' }, { label:'주문ID', key:'order_id' },
    { label:'금액', key:'amount' }, { label:'메모', key:'note' },
  ],
};

/** 쿼리 파라미터로 목록을 조회한다. { rows, total, limit, offset } */
function queryList(cfg, qs) {
  const t = cfg.table;
  const conf = LIST_QUERY[t] || { cols: [] };
  const where = [], args = [];

  const q = String(qs.q ?? '').trim();
  if (q && conf.cols.length) {
    // 공백으로 나눈 모든 토큰이 어느 컬럼엔가 포함돼야 한다
    for (const tok of q.split(/\s+/).slice(0, 5)) {
      where.push('(' + conf.cols.map(c => `IFNULL(${c},'') LIKE ?`).join(' OR ') + ')');
      for (const _ of conf.cols) args.push(`%${tok}%`);
    }
  }
  if (qs.status && conf.status) {
    const list = String(qs.status).split(',').map(s => s.trim()).filter(Boolean).slice(0, 10);
    if (list.length) { where.push(`${conf.status} IN (${list.map(()=>'?').join(',')})`); args.push(...list); }
  }
  if (qs.from && conf.date) { where.push(`${conf.date} >= ?`); args.push(String(qs.from)); }
  if (qs.to   && conf.date) { where.push(`${conf.date} <= ?`); args.push(String(qs.to)); }

  const sql = where.length ? ' WHERE ' + where.join(' AND ') : '';
  const total = db.prepare(`SELECT COUNT(*) as n FROM ${t}${sql}`).get(...args).n;

  const sortCol = (SORTABLE[t] || []).includes(String(qs.sort)) ? String(qs.sort) : null;
  const dir = String(qs.dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const order = sortCol ? ` ORDER BY ${sortCol} ${dir}`
              : TABLE_ORDER[t] ? ` ORDER BY ${TABLE_ORDER[t]}` : '';

  let limit = parseInt(qs.limit, 10);
  limit = Number.isFinite(limit) && limit > 0 ? Math.min(limit, LIST_LIMIT_MAX) : 50;
  let offset = parseInt(qs.offset, 10);
  offset = Number.isFinite(offset) && offset > 0 ? offset : 0;

  const rows = db.prepare(`SELECT * FROM ${t}${sql}${order} LIMIT ? OFFSET ?`)
                 .all(...args, limit, offset).map(r => rowOut(t, r));
  return { rows, total, limit, offset };
}
function getOne(cfg, id) {
  return rowOut(cfg.table, db.prepare(`SELECT * FROM ${cfg.table} WHERE id = ?`).get(id));
}
function upsert(cfg, item) {
  const row  = pickColumns(cfg.table, rowIn(cfg.table, item));
  const keys = Object.keys(row);
  if (!keys.length) return;
  const vals = keys.map(k => row[k] ?? null);
  const ph   = keys.map(() => '?').join(', ');
  const upd  = keys.filter(k => k !== 'id').map(k => `${k} = excluded.${k}`).join(', ');
  db.prepare(`INSERT INTO ${cfg.table} (${keys.join(', ')}) VALUES (${ph}) ON CONFLICT(id) DO UPDATE SET ${upd}`).run(...vals);
}
/* 클라이언트가 보낸 키가 그대로 컬럼명에 문자열 보간되고 있었다.
 * 모르는 키는 SQL 오류(= 500)를 내고, 따옴표가 섞이면 컬럼명 인젝션이 된다.
 * 실제 스키마에서 컬럼을 읽어 거른다 — 손으로 적은 목록은 스키마와 어긋난다. */
const columnCache = new Map();
function columnsOf(table) {
  if (!columnCache.has(table)) {
    columnCache.set(table, new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name)));
  }
  return columnCache.get(table);
}
/** 스키마에 있는 컬럼만, 그리고 바인딩 가능한 값만 남긴다 */
function pickColumns(table, row) {
  const cols = columnsOf(table);
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (!cols.has(k)) continue;
    if (v !== null && typeof v === 'object') continue;   // 배열·객체는 바인딩 불가
    out[k] = v;
  }
  return out;
}

function updateOne(cfg, id, patch) {
  const row  = pickColumns(cfg.table, rowIn(cfg.table, { id, ...patch }));
  const keys = Object.keys(row).filter(k => k !== 'id');
  if (!keys.length) return false;
  const vals = keys.map(k => row[k] ?? null);
  return db.prepare(`UPDATE ${cfg.table} SET ${keys.map(k=>`${k}=?`).join(',')} WHERE id=?`).run(...vals, id).changes > 0;
}
/* status_changes / quotation_sources 는 FK 가 없어 주문을 지워도 남는다.
 * quotations.id 는 AUTOINCREMENT 가 아니라 삭제 후 같은 id 가 재사용되므로,
 * 새 주문이 지워진 주문의 이력을 물려받아 "내가 하지 않은 변경" 이 이력 탭에 뜬다
 * (실제로 관측됨). 자식 테이블을 명시적으로 지운다. */
const ORPHAN_CHILDREN = {
  quotations: ['DELETE FROM status_changes WHERE order_id=?', 'DELETE FROM quotation_sources WHERE order_id=?'],
  /* 구매는 자식이 ON DELETE CASCADE 지만 purchase_receipts.item_id 는 purchase_items 를
   * 가리키면서 ON DELETE 가 없다. 캐스케이드 순서에 기대면 FK 오류가 날 수 있으므로
   * 입고 → 품목 순으로 직접 지운다. */
  purchases: ['DELETE FROM purchase_receipts WHERE purchase_id=?',
              'DELETE FROM purchase_payments WHERE purchase_id=?',
              'DELETE FROM purchase_items WHERE purchase_id=?'],
};
function deleteOne(cfg, id) {
  db.transaction(() => {
    for (const sql of ORPHAN_CHILDREN[cfg.table] || []) db.prepare(sql).run(id);
    db.prepare(`DELETE FROM ${cfg.table} WHERE id=?`).run(id);
  })();
}
// 금액·상태 캐시 컬럼을 클라이언트가 직접 덮어쓰지 못하도록 — 이 테이블들은
// 전용 엔드포인트(/status, /cancel, /memo, /order_items/order/:id)로만 수정한다.
const GENERIC_WRITE_BLOCKED = new Set(['quotations', 'purchases', 'order_items', 'purchase_items']);
// 작성자를 세션에서 채워 넣는 테이블
const CREATED_BY_TABLES = new Set(['quotations', 'purchases', 'as_records']);
/** 방금 INSERT 된 행의 id — 생성 응답에 담아 클라이언트가 재조회하지 않게 한다 */
const lastRowId = table => db.prepare(`SELECT MAX(id) as id FROM ${table}`).get()?.id ?? null;

// ─── 전문 쿼리 ───────────────────────────────────────────────
function recalcPaid(orderId) {
  const row = db.prepare('SELECT COALESCE(SUM(amount),0) as s FROM payments WHERE order_id=?').get(orderId);
  db.prepare('UPDATE quotations SET total_paid=? WHERE id=?').run(row.s, orderId);
}

// 판매(출고)와 구매(입고)는 구조가 같아 하나의 설정으로 처리한다.
const LINE_ITEM = {
  sales: {
    items: 'order_items', parentCol: 'order_id', parent: 'quotations',
    ledger: 'shipments',  doneCol: 'shipped_qty', word: '출고',
    after: id => autoStatus(id),
  },
  purchase: {
    items: 'purchase_items', parentCol: 'purchase_id', parent: 'purchases',
    ledger: 'purchase_receipts', doneCol: 'received_qty', word: '입고',
    after: id => autoReceiveStatus(id),
  },
};

/* 부모의 금액을 품목에서 재계산한다 (캐시 컬럼 드리프트 방지).
 *
 * 반올림 규칙 — 행 금액은 행 단위 반올림, 부가세는 문서 단위로 한 번만.
 * 행별 세액을 합산하면 세금계산서와 거래명세서가 1원씩 어긋난다.
 * 면세 행(tax_free=1)은 과세표준에서 제외한다. 영세율은 vat_rate=0 으로 흡수한다.
 *
 * total 은 항상 "부가세 포함 합계" 다. total_paid 는 실입금액(세포함)이므로
 * total 을 공급가액으로 두면 미수금이 전건 어긋난다. */
function recalcTotal(cfg, parentId) {
  const p = db.prepare(`SELECT vat_mode, vat_rate FROM ${cfg.parent} WHERE id=?`).get(parentId);
  if (!p) return;
  const rate = Number(p.vat_rate);
  const vatRate = Number.isFinite(rate) && rate >= 0 ? rate : 0.1;
  const inclusive = p.vat_mode === 'INCLUSIVE';

  const r = db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN tax_free=1 THEN 0 ELSE amount END),0) AS taxable,
      COALESCE(SUM(CASE WHEN tax_free=1 THEN amount ELSE 0 END),0) AS exempt
    FROM ${cfg.items} WHERE ${cfg.parentCol}=?`).get(parentId);

  /* 할인은 문서 단위로 과세표준에서만 뺀다. 행마다 배분하면 세금계산서와
   * 거래명세서가 어긋난다. 면세분은 건드리지 않고, 과세분보다 크게는 못 깎는다. */
  const discount = columnsOf(cfg.parent).has('discount')
    ? Math.min(Math.max(0, db.prepare(`SELECT discount FROM ${cfg.parent} WHERE id=?`).get(parentId)?.discount || 0), r.taxable)
    : 0;
  const taxable = r.taxable - discount;

  let supply, vat, total;
  if (inclusive) {
    // 입력 단가가 세포함. 공급가액을 역산하고 부가세는 반드시 차액으로 —
    // 따로 구하면 supply + vat != 입력합계 가 되어 1원씩 깨진다.
    supply = Math.round(taxable / (1 + vatRate));
    vat    = taxable - supply;
    total  = taxable + r.exempt;
  } else {
    supply = taxable;
    vat    = Math.floor(supply * vatRate);
    total  = supply + r.exempt + vat;
  }
  db.prepare(`UPDATE ${cfg.parent}
              SET total=?, supply_amount=?, vat_amount=?, exempt_amount=? WHERE id=?`)
    .run(total, supply, vat, r.exempt, parentId);
}

// 원장에서 출고/입고 수량을 다시 계산한다. 클라이언트가 보낸 값을 믿지 않는다.
function recalcLedgerQty(cfg, parentId) {
  db.prepare(`UPDATE ${cfg.items} SET ${cfg.doneCol} = COALESCE(
                (SELECT SUM(l.qty) FROM ${cfg.ledger} l WHERE l.item_id = ${cfg.items}.id), 0)
              WHERE ${cfg.parentCol} = ?`).run(parentId);
}

// 품목 저장 — DELETE 후 재INSERT 하면 id 가 바뀌어 원장의 item_id 가 끊기고
// FK 위반으로 요청이 실패한다(그리고 예전엔 서버가 죽었다).
// 그래서 id 를 보존하는 diff 방식으로 처리한다.
// 반환: 오류 메시지(문자열) 또는 null
function saveLineItems(cfg, parentId, items) {
  const existing = db.prepare(`SELECT id,qty,${cfg.doneCol} as done FROM ${cfg.items} WHERE ${cfg.parentCol}=?`).all(parentId);
  const byId = new Map(existing.map(r => [r.id, r]));
  const keep = new Set();

  for (const item of items) {
    const qty = Number(item.qty) || 0;
    if (qty < 0 || (Number(item.unit_price) || 0) < 0) return '수량·단가는 음수일 수 없습니다.';
    const id = Number(item.id);
    if (byId.has(id)) {
      const cur = byId.get(id);
      if (qty < cur.done) {
        return `이미 ${cur.done} ${cfg.word}된 품목의 수량을 ${qty} 로 줄일 수 없습니다.`;
      }
      keep.add(id);
    }
  }
  for (const row of existing) {
    if (!keep.has(row.id) && row.done > 0) {
      return `${cfg.word} 이력이 있는 품목은 삭제할 수 없습니다.`;
    }
  }

  db.transaction(() => {
    const del = db.prepare(`DELETE FROM ${cfg.items} WHERE id=?`);
    for (const row of existing) if (!keep.has(row.id)) del.run(row.id);

    const upd = db.prepare(`UPDATE ${cfg.items} SET name=?,spec=?,unit=?,qty=?,unit_price=?,note=?,sort_order=?,amount=?,tax_free=? WHERE id=?`);
    const ins = db.prepare(`INSERT INTO ${cfg.items} (${cfg.parentCol},name,spec,unit,qty,unit_price,${cfg.doneCol},note,sort_order,amount,tax_free)
                            VALUES (?,?,?,?,?,?,0,?,?,?,?)`);
    items.forEach((item, i) => {
      const q = Number(item.qty) || 0, up = Number(item.unit_price) || 0;
      // 행 금액은 여기서 정수로 확정한다. qty 가 REAL 이라 SQL 에서 SUM(qty*unit_price)
      // 하면 INTEGER 컬럼에 REAL 이 들어가고 거기서 뽑은 세액이 처음부터 틀린다.
      const vals = [item.name||'', item.spec||'', item.unit||'EA', q, up, item.note||'', i,
                    Math.round(q * up), item.tax_free ? 1 : 0];
      const id = Number(item.id);
      if (keep.has(id)) upd.run(...vals, id);
      else ins.run(parentId, ...vals);
    });

    recalcLedgerQty(cfg, parentId);
    recalcTotal(cfg, parentId);
    cfg.after(parentId);
  })();
  return null;
}

// 원장 등록(출고/입고) 공통 검증 — 오류 메시지 또는 null
function validateLedgerEntry(cfg, parentId, itemId, qty, blockedStatuses, statusCol) {
  if (!Number.isFinite(qty) || qty <= 0) return `${cfg.word} 수량은 0보다 커야 합니다.`;
  const parent = db.prepare(`SELECT ${statusCol} as st FROM ${cfg.parent} WHERE id=?`).get(parentId);
  if (!parent) return '대상을 찾을 수 없습니다.';
  if (blockedStatuses.includes(parent.st)) return `완료·취소된 건에는 ${cfg.word}를 등록할 수 없습니다.`;
  const item = db.prepare(`SELECT qty,${cfg.doneCol} as done FROM ${cfg.items} WHERE id=? AND ${cfg.parentCol}=?`).get(itemId, parentId);
  if (!item) return '해당 건의 품목이 아닙니다.';
  const remain = item.qty - item.done;
  if (qty > remain + 1e-9) return `잔여 수량(${remain})을 초과할 수 없습니다.`;
  return null;
}

// 로컬 시간 기준 YYYY-MM-DD. toISOString() 은 UTC 라 KST 새벽에 전날이 찍힌다.
function today() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// 판매 상태 전이 규칙 — 구매(purchase_status)의 화이트리스트 방식과 맞춘다.
// cancelled 는 아래 canTransit 에서 별도로 허용한다(완료 건 제외).
const ORDER_STATUSES = ['draft','ordered','partial','shipped','done','cancelled'];
const ORDER_FLOW = {
  draft:     ['ordered','cancelled'],
  ordered:   ['draft','partial','shipped','done','cancelled'],
  partial:   ['ordered','shipped','done','cancelled'],
  shipped:   ['partial','done','cancelled'],
  done:      [],           // 완료 건은 되돌릴 수 없다
  cancelled: ['draft'],    // 취소 해제는 초안으로만
};
const canTransit = (from, to) => from === to || (ORDER_FLOW[from] || []).includes(to);

// 구매도 같은 규칙으로 — 지금까지 구매는 화이트리스트만 있고 전이표가 없어
// 정산 완료된 발주를 작성중으로 되돌릴 수 있었다.
const PURCHASE_STATUSES = ['draft','ordered','partial','received','done','cancelled'];
const PURCHASE_FLOW = {
  draft:     ['ordered','cancelled'],
  ordered:   ['draft','partial','received','done','cancelled'],
  partial:   ['ordered','received','done','cancelled'],
  received:  ['partial','done','cancelled'],
  done:      [],
  cancelled: ['draft'],
};
const canTransitPurchase = (from, to) => from === to || (PURCHASE_FLOW[from] || []).includes(to);

/** 오늘 날짜 기준 다음 발주번호. PO-YYMMDD-N */
function nextPurchaseNo(now = new Date()) {
  const ds = `${String(now.getFullYear()).slice(2)}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}`;
  const prefix = `PO-${ds}-`;
  return `${prefix}${nextSeq('purchases', 'no', prefix)}`;
}

/* 채번은 COUNT 가 아니라 MAX 로 한다. COUNT 기반은 중간 건이 삭제되면 번호가
 * 되돌아가 직전 번호와 그대로 겹친다 — 오늘 주문 2건을 만들고 1건을 지우면
 * 다음 주문이 다시 -2 가 된다. 출고·완료 묶음도 삭제 API 가 생겨 같은 경로다. */
function nextSeq(table, col, prefix) {
  const row = db.prepare(
    `SELECT MAX(CAST(substr(${col}, ?) AS INTEGER)) AS m FROM ${table} WHERE ${col} LIKE ?`
  ).get(prefix.length + 1, `${prefix}%`);
  return (row?.m || 0) + 1;
}

/** 오늘 날짜 기준 다음 판매번호. YY/MM/DD-N */
function nextOrderNo(now = new Date()) {
  const mm = String(now.getMonth()+1).padStart(2,'0');
  const dd = String(now.getDate()).padStart(2,'0');
  const prefix = `${String(now.getFullYear()).slice(2)}/${mm}/${dd}-`;
  return `${prefix}${nextSeq('quotations', 'no', prefix)}`;
}

/** blobs 의 settings. 공급자(자사) 정보가 여기 있다 — 코드에 상호를 박지 않는다. */
function settingsBlob() {
  try { return JSON.parse(db.prepare(`SELECT value FROM blobs WHERE key='settings'`).get()?.value || '{}'); }
  catch { return {}; }
}
const companyName = () => settingsBlob().company?.name || '';

/** 견적 유효기한. settings.quotation.validity_days 를 쓴다 (기본 15일). */
function defaultValidUntil(fromDate) {
  const days = Number(settingsBlob().quotation?.validity_days);
  if (!Number.isFinite(days) || days <= 0) return '';
  const d = new Date(`${fromDate}T00:00:00`);
  if (isNaN(d)) return '';
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function recordStatusChange(orderId, fromStatus, toStatus, reason, user) {
  // user_name 을 함께 박아둔다 — 계정을 지워도 이력에 누가 했는지는 남아야 한다
  db.prepare('INSERT INTO status_changes (order_id,from_status,to_status,reason,user_id,user_name) VALUES (?,?,?,?,?,?)')
    .run(orderId, fromStatus||'', toStatus||'', reason||'', user?.id ?? null, user ? (user.name || user.username) : '');
}

/** 완료(done)를 풀고 출고 원장에서 상태를 다시 계산한다.
 *  고정값으로 되돌리면 출고가 덜 된 채 완료됐던 주문이 잘못된 상태로 남는다. */
function uncompleteOrder(order, reason, user) {
  const items = db.prepare('SELECT qty,shipped_qty FROM order_items WHERE order_id=?').all(order.id);
  const restored = !items.length                              ? 'draft'
                 : items.every(i => i.shipped_qty >= i.qty)   ? 'shipped'
                 : items.some(i => i.shipped_qty > 0)         ? 'partial'
                 :                                              'ordered';
  db.prepare('UPDATE quotations SET order_status=?,completion_batch_id=NULL WHERE id=?').run(restored, order.id);
  recordStatusChange(order.id, order.order_status, restored, reason, user);
  return restored;
}

function autoStatus(orderId) {
  const order = db.prepare('SELECT * FROM quotations WHERE id=?').get(orderId);
  if (!order || ['done','cancelled'].includes(order.order_status)) return;
  const items = db.prepare('SELECT * FROM order_items WHERE order_id=?').all(orderId);
  if (!items.length) return;
  const allShipped = items.every(i => i.shipped_qty >= i.qty);
  const anyShipped = items.some(i => i.shipped_qty > 0);
  if (allShipped) db.prepare('UPDATE quotations SET order_status=? WHERE id=?').run('shipped', orderId);
  else if (anyShipped) db.prepare('UPDATE quotations SET order_status=? WHERE id=?').run('partial', orderId);
}

function recalcPurchasePaid(purchaseId) {
  const row = db.prepare('SELECT COALESCE(SUM(amount),0) as s FROM purchase_payments WHERE purchase_id=?').get(purchaseId);
  db.prepare('UPDATE purchases SET total_paid=? WHERE id=?').run(row.s, purchaseId);
}

function autoReceiveStatus(purchaseId) {
  const purchase = db.prepare('SELECT * FROM purchases WHERE id=?').get(purchaseId);
  if (!purchase || ['done','cancelled'].includes(purchase.purchase_status)) return;
  const items = db.prepare('SELECT * FROM purchase_items WHERE purchase_id=?').all(purchaseId);
  if (!items.length) return;
  const allReceived = items.every(i => i.received_qty >= i.qty);
  const anyReceived = items.some(i => i.received_qty > 0);
  if (allReceived) db.prepare('UPDATE purchases SET purchase_status=? WHERE id=?').run('received', purchaseId);
  else if (anyReceived) db.prepare('UPDATE purchases SET purchase_status=? WHERE id=?').run('partial', purchaseId);
}

// ─── MIME ────────────────────────────────────────────────────
const MIME = {
  '.html':'text/html; charset=utf-8', '.js':'application/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8',   '.json':'application/json; charset=utf-8',
  '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg',
  '.svg':'image/svg+xml', '.ico':'image/x-icon',
};

const json = (res, status, data) => {
  res.writeHead(status, { 'Content-Type':'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
};
const BODY_LIMIT = 1024 * 1024;   // 1MB
const parseBody = req => new Promise((resolve, reject) => {
  let body = '';
  let over = false;
  req.on('data', c => {
    if (over) return;
    body += c;
    if (body.length > BODY_LIMIT) { over = true; body = ''; req.destroy(); }
  });
  req.on('end', () => {
    if (over) return resolve(null);
    try { resolve(JSON.parse(body || 'null')); } catch { resolve(null); }
  });
  req.on('error', reject);
});

// 정적 파일로 내보내도 되는 확장자만 — DB·시크릿·서버 소스 유출 방지
const STATIC_EXT = new Set(Object.keys(MIME));
// 확장자는 허용 목록에 있지만 내보내면 안 되는 파일
const STATIC_DENY = new Set(['server.js', 'package.json', 'package-lock.json']);
const serveStatic = (req, res, pathname) => {
  if (pathname === '/') pathname = '/index.html';
  const fp = path.resolve(ROOT, '.' + pathname);
  // ROOT 밖 / data 디렉토리 / dot 으로 시작하는 파일·디렉토리 차단
  const rel = path.relative(ROOT, fp);
  if (rel.startsWith('..') || path.isAbsolute(rel) ||
      rel.split(/[\\/]/).some(seg => seg.startsWith('.')) ||
      fp === DATA_DIR || fp.startsWith(DATA_DIR + path.sep)) {
    res.writeHead(403, {'Content-Type':'text/plain'}); res.end('Forbidden'); return;
  }
  if (!STATIC_EXT.has(path.extname(fp).toLowerCase()) || STATIC_DENY.has(rel.toLowerCase())) {
    res.writeHead(404, {'Content-Type':'text/plain'}); res.end('Not Found'); return;
  }
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404, {'Content-Type':'text/plain'}); res.end('Not Found'); return; }
    res.writeHead(200, {'Content-Type': MIME[path.extname(fp).toLowerCase()]});
    res.end(data);
  });
};

// ─── 인증 (아이디 + 비밀번호 계정) ───────────────────────────
const SESSION_MAX = 7 * 24 * 60 * 60 * 1000;   // 7일
const COOKIE_NAME = 'cs_session';

// 세션 서명키 — data/ 에 보관해 재시작해도 로그인이 유지된다
const SECRET = (() => {
  const fp = path.join(DATA_DIR, '.session-secret');
  try { return fs.readFileSync(fp, 'utf8').trim(); } catch {}
  const s = crypto.randomBytes(32).toString('hex');
  try { fs.writeFileSync(fp, s, { mode: 0o600 }); } catch {}
  return s;
})();

const sign = v => crypto.createHmac('sha256', SECRET).update(String(v)).digest('hex');
const safeEq = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/* 비밀번호 해시 — scrypt 는 Node 내장이라 의존성이 늘지 않는다 */
const hashPassword = (pw, salt) => crypto.scryptSync(String(pw), salt, 32).toString('hex');
const makeSalt = () => crypto.randomBytes(16).toString('hex');

/* 토큰에 사용자를 담는다. 종전 `exp.mac` 은 행위자를 알 수 없어
 * 어떤 엔드포인트도 "누가 했는지" 를 기록할 수 없었다. */
const makeToken = uid => {
  const u = db.prepare('SELECT token_version FROM users WHERE id=?').get(uid);
  const exp = Date.now() + SESSION_MAX;
  const payload = `${uid}.${u?.token_version ?? 1}.${exp}`;
  return `${payload}.${sign(payload)}`;
};
/** 유효하면 사용자 행을, 아니면 null */
const authUser = token => {
  if (!token) return null;
  const parts = String(token).split('.');
  if (parts.length !== 4) return null;
  const [uid, ver, exp, mac] = parts;
  if (!safeEq(mac, sign(`${uid}.${ver}.${exp}`))) return null;
  if (!(Number(exp) > Date.now())) return null;
  const u = db.prepare('SELECT id,username,name,role,active,token_version FROM users WHERE id=?').get(Number(uid));
  // 퇴사·비밀번호 변경으로 token_version 이 오르면 기존 토큰은 전부 무효
  if (!u || !u.active || String(u.token_version) !== String(ver)) return null;
  return u;
};

/* 로그인 시도 제한 — 무인증 경로라 온라인 무차별 대입을 막아야 한다.
 * 프로세스 메모리면 충분하다(단일 인스턴스). */
const LOGIN_MAX = 10, LOGIN_WINDOW = 10 * 60 * 1000;
const loginHits = new Map();
function loginAllowed(key) {
  const now = Date.now();
  const hits = (loginHits.get(key) || []).filter(t => now - t < LOGIN_WINDOW);
  if (hits.length >= LOGIN_MAX) { loginHits.set(key, hits); return false; }
  hits.push(now); loginHits.set(key, hits);
  if (loginHits.size > 1000) for (const [k, v] of loginHits) if (!v.some(t => now - t < LOGIN_WINDOW)) loginHits.delete(k);
  return true;
}

/* 최초 계정 — 계정이 하나도 없으면 env 로 관리자 1개를 만든다.
 * 공개 저장소이므로 비밀번호 기본값은 코드에 두지 않는다. 서버의 .env 에서만 온다.
 * APP_PASSWORD 는 공용 비밀번호 시절의 값으로, 마이그레이션 동안만 받아준다. */
(function seedAdmin() {
  if (db.prepare('SELECT COUNT(*) as n FROM users').get().n > 0) return;
  const username = process.env.ADMIN_USER || 'admin';
  const password = process.env.ADMIN_PASSWORD || process.env.APP_PASSWORD;
  if (!password) {
    console.error('계정이 없습니다. .env 에 ADMIN_USER / ADMIN_PASSWORD 를 설정하고 다시 시작하세요.');
    return;
  }
  const salt = makeSalt();
  db.prepare(`INSERT INTO users (username,password_hash,salt,name,role,created_at)
              VALUES (?,?,?,?,'admin',?)`)
    .run(username, hashPassword(password, salt), salt, process.env.ADMIN_NAME || '관리자', today());
  console.log(`최초 관리자 계정 '${username}' 을 생성했습니다.`);
})();
const readCookie = (req, name) => {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
};

// 로그인 없이 접근 가능한 경로
const PUBLIC_PATHS = new Set(['/login.html', '/api/login', '/logout']);
// 터널(HTTPS) 뒤에서만 Secure 를 붙인다 — 로컬 http 개발에서 쿠키가 막히면 안 된다
const SECURE_COOKIE = process.env.COOKIE_SECURE === '1' ? 'Secure; ' : '';

// ─── HTTP 서버 ──────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  try {
    await handle(req, res);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] ${req.method} ${req.url}\n`, err);
    if (!res.headersSent) json(res, 500, { ok:false, error:'서버 오류가 발생했습니다.' });
    else res.end();
  }
});

async function handle(req, res) {
  // 그동안 pathname 만 꺼내 쿼리스트링을 통째로 버렸다. 검색·필터·페이지네이션
  // 파라미터를 받을 지점 자체가 없었다.
  const { pathname: rawPath, query: rawQuery } = url.parse(req.url, true);
  req.query = rawQuery || {};
  // 잘못된 퍼센트 인코딩(예: GET /%)이 프로세스를 죽이지 않도록
  let pathname;
  try { pathname = decodeURIComponent(rawPath); }
  catch { return json(res, 400, { ok:false, error:'잘못된 경로입니다.' }); }
  const method   = req.method.toUpperCase();

  if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── 로그인 / 로그아웃 ────────────────────────────────────────
  if (pathname === '/api/login' && method === 'POST') {
    const body = await parseBody(req);
    const username = String(body?.username ?? '').trim();
    // 터널(cloudflared) 뒤에서는 모든 요청이 같은 소켓 IP 로 들어온다. IP 만으로
    // 세면 한 사람의 오타 10번이 사무실 전체를 10분간 잠근다. 아이디까지 넣는다.
    const who = `${req.headers['cf-connecting-ip'] || req.socket.remoteAddress || '?'}:${username}`;
    if (!loginAllowed(who)) return json(res, 429, { error: '로그인 시도가 너무 많습니다. 잠시 후 다시 시도하세요.' });
    const u = username && db.prepare('SELECT * FROM users WHERE username=?').get(username);
    // 아이디가 없어도 같은 비용을 치러 사용자 존재 여부가 응답 시간으로 새지 않게 한다
    const salt = u ? u.salt : 'none';
    const hash = hashPassword(body?.password ?? '', salt);
    if (!u || !u.active || !safeEq(hash, u.password_hash)) {
      return json(res, 401, { error: '아이디 또는 비밀번호가 올바르지 않습니다.' });
    }
    db.prepare('UPDATE users SET last_login_at=? WHERE id=?').run(new Date().toISOString(), u.id);
    loginHits.delete(who);
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': `${COOKIE_NAME}=${makeToken(u.id)}; Path=/; HttpOnly; SameSite=Strict; ${SECURE_COOKIE}Max-Age=${SESSION_MAX / 1000}`,
    });
    return res.end(JSON.stringify({ ok: true, name: u.name || u.username, role: u.role }));
  }
  if (pathname === '/logout') {
    res.writeHead(302, {
      'Location': '/login.html',
      'Set-Cookie': `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; ${SECURE_COOKIE}Max-Age=0`,
    });
    return res.end();
  }

  // ── 인증 게이트 ─────────────────────────────────────────────
  // req.user 를 채워 이후 핸들러가 행위자를 기록할 수 있게 한다
  req.user = authUser(readCookie(req, COOKIE_NAME));
  if (!PUBLIC_PATHS.has(pathname) && !req.user) {
    if (pathname.startsWith('/api/')) return json(res, 401, { error: '로그인이 필요합니다.' });
    res.writeHead(302, { 'Location': '/login.html' });
    return res.end();
  }

  // ── 인쇄용 데이터 (견적서 / 거래명세서) ─────────────────────
  // 한 화면에 필요한 것을 한 번에 내려준다. 공급자 정보는 blobs 의 settings 에 있다.
  const mPrint = pathname.match(/^\/api\/print\/quotations\/(\d+)$/);
  if (mPrint && method === 'GET') {
    const id = parseInt(mPrint[1]);
    const order = db.prepare(`SELECT q.*, c.name as cust_name, c.rep as cust_rep, c.business_no as cust_business_no,
                                     c.phone as cust_phone, c.address_base, c.address_detail
                              FROM quotations q LEFT JOIN customers c ON q.customer_id=c.id
                              WHERE q.id=?`).get(id);
    if (!order) return json(res, 404, { ok:false, error:'주문을 찾을 수 없습니다.' });
    delete order.memo_internal;   // 내부 메모는 고객에게 나가는 문서에 넣지 않는다
    const settings = settingsBlob();
    return json(res, 200, {
      order,
      items: db.prepare('SELECT * FROM order_items WHERE order_id=? ORDER BY sort_order,id').all(id),
      shipments: db.prepare(`SELECT s.*, oi.name as item_name, oi.spec, oi.unit
                             FROM shipments s LEFT JOIN order_items oi ON s.item_id=oi.id
                             WHERE s.order_id=? ORDER BY s.shipped_at, s.id`).all(id),
      payments: db.prepare('SELECT * FROM payments WHERE order_id=? ORDER BY paid_at,id').all(id),
      company: settings.company || {},
      // 유효기간·기본 문구는 설정에 있는데 인쇄가 읽지 않아 "30일" 이 박혀 나갔다
      quotation: settings.quotation || {},
    });
  }

  // ── CSV 내보내기 ────────────────────────────────────────────
  const mExport = pathname.match(/^\/api\/export\/([a-z_]+)$/);
  if (mExport && method === 'GET') {
    const cfg = TABLES[mExport[1]];
    if (!cfg || !EXPORT_COLUMNS[cfg.table]) return json(res, 404, { ok:false, error:'내보낼 수 없는 리소스입니다.' });
    const spec = EXPORT_COLUMNS[cfg.table];
    // 화면에 보이는 것과 같은 필터를 적용한다. 상한을 넉넉히 두되 무제한은 아니다.
    const { rows } = queryList(cfg, { ...req.query, limit: LIST_LIMIT_MAX, offset: 0 });
    const esc = v => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const body = [spec.map(c => c.label).join(',')]
      .concat(rows.map(r => spec.map(c => esc(c.get ? c.get(r) : r[c.key])).join(',')))
      .join('\r\n');
    const stamp = today();
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${cfg.table}-${stamp}.csv"; filename*=UTF-8''${encodeURIComponent(cfg.table + '-' + stamp + '.csv')}`,
    });
    // BOM 이 없으면 엑셀이 UTF-8 로 인식하지 못해 한글이 전부 깨진다
    return res.end('﻿' + body, 'utf8');
  }

  // ── 계정 ────────────────────────────────────────────────────
  // users 는 TABLES 에 없다. 제네릭 CRUD 로 password_hash 가 나가면 안 되므로
  // 필요한 컬럼만 내보내는 전용 경로만 연다.
  if (pathname === '/api/me' && method === 'GET') {
    return json(res, 200, { id:req.user.id, username:req.user.username, name:req.user.name, role:req.user.role });
  }
  if (pathname === '/api/users' && method === 'GET') {
    // 담당자 선택용 — 비활성 계정은 목록에서 뺀다
    return json(res, 200, db.prepare(
      `SELECT id,username,name,role FROM users WHERE active=1 ORDER BY name, username`).all());
  }
  if (pathname === '/api/users' && method === 'POST') {
    if (req.user.role !== 'admin') return json(res, 403, { ok:false, error:'관리자만 계정을 만들 수 있습니다.' });
    const body = await parseBody(req);
    const username = String(body?.username ?? '').trim();
    const password = String(body?.password ?? '');
    if (!/^[A-Za-z0-9._-]{3,32}$/.test(username)) {
      return json(res, 400, { ok:false, error:'아이디는 영문·숫자·._- 조합 3~32자여야 합니다.' });
    }
    if (password.length < 4) return json(res, 400, { ok:false, error:'비밀번호는 4자 이상이어야 합니다.' });
    if (db.prepare('SELECT 1 FROM users WHERE username=?').get(username)) {
      return json(res, 409, { ok:false, error:'이미 있는 아이디입니다.' });
    }
    const salt = makeSalt();
    const info = db.prepare(`INSERT INTO users (username,password_hash,salt,name,role,created_at)
                             VALUES (?,?,?,?,?,?)`)
      .run(username, hashPassword(password, salt), salt,
           String(body?.name ?? '').trim(), body?.role === 'admin' ? 'admin' : 'staff', today());
    return json(res, 200, { ok:true, id: info.lastInsertRowid });
  }
  const mUserPw = pathname.match(/^\/api\/users\/(\d+)\/password$/);
  if (mUserPw && method === 'PATCH') {
    const uid  = parseInt(mUserPw[1]);
    const body = await parseBody(req);
    const target = db.prepare('SELECT * FROM users WHERE id=?').get(uid);
    if (!target) return json(res, 404, { ok:false, error:'계정을 찾을 수 없습니다.' });
    const self = req.user.id === uid;
    if (!self && req.user.role !== 'admin') return json(res, 403, { ok:false, error:'권한이 없습니다.' });
    // 본인 변경은 현재 비밀번호를 확인한다 (자리를 비운 사이 탈취 방지)
    if (self && !safeEq(hashPassword(body?.current ?? '', target.salt), target.password_hash)) {
      return json(res, 400, { ok:false, error:'현재 비밀번호가 올바르지 않습니다.' });
    }
    const next = String(body?.password ?? '');
    if (next.length < 4) return json(res, 400, { ok:false, error:'비밀번호는 4자 이상이어야 합니다.' });
    const salt = makeSalt();
    // token_version 을 올려 기존 세션을 전부 끊는다
    db.prepare('UPDATE users SET password_hash=?,salt=?,token_version=token_version+1 WHERE id=?')
      .run(hashPassword(next, salt), salt, uid);
    if (self) {
      res.writeHead(200, { 'Content-Type':'application/json; charset=utf-8',
        'Set-Cookie': `${COOKIE_NAME}=${makeToken(uid)}; Path=/; HttpOnly; SameSite=Strict; ${SECURE_COOKIE}Max-Age=${SESSION_MAX / 1000}` });
      return res.end(JSON.stringify({ ok:true }));
    }
    return json(res, 200, { ok:true });
  }
  const mUserAct = pathname.match(/^\/api\/users\/(\d+)\/active$/);
  if (mUserAct && method === 'PATCH') {
    if (req.user.role !== 'admin') return json(res, 403, { ok:false, error:'관리자만 계정을 비활성화할 수 있습니다.' });
    const uid = parseInt(mUserAct[1]);
    if (uid === req.user.id) return json(res, 400, { ok:false, error:'자기 계정은 비활성화할 수 없습니다.' });
    const body = await parseBody(req);
    const active = body?.active ? 1 : 0;
    // 비활성화 시 token_version 을 올려 이미 발급된 세션도 즉시 끊는다
    const r = db.prepare('UPDATE users SET active=?, token_version=token_version+1 WHERE id=?').run(active, uid);
    if (!r.changes) return json(res, 404, { ok:false, error:'계정을 찾을 수 없습니다.' });
    return json(res, 200, { ok:true });
  }

  // ── /api/dashboard ──────────────────────────────────────────
  if (pathname === '/api/dashboard' && method === 'GET') {
    const now = new Date();
    const ym  = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
    const kpi = {
      thisMonthDraft:   db.prepare(`SELECT COUNT(*) as n FROM quotations WHERE order_status='draft' AND date LIKE ?`).get(`${ym}%`).n,
      // shipped 포함 — 출고는 끝났지만 완료 묶음 전인 주문도 진행중이다
      inProgress:       db.prepare(`SELECT COUNT(*) as n FROM quotations WHERE order_status IN ('ordered','partial','shipped')`).get().n,
      // done 포함 — 납품이 끝났는데 못 받은 돈이야말로 미수금이다. draft·cancelled 만 제외
      totalUnpaid:      db.prepare(`SELECT COALESCE(SUM(total - total_paid),0) as s FROM quotations
                                    WHERE order_status NOT IN ('draft','cancelled') AND total > total_paid`).get().s,
      openAS:           db.prepare(`SELECT COUNT(*) as n FROM as_records WHERE status='OPEN'`).get().n,
    };
    // 부분출고 건이 미수금 목록에도 걸려 두 번 뜨던 문제 → 부분출고를 우선 태그로 잡고
    // 미수금 목록에서는 제외한다. 정렬은 최신순(오름차순이면 오래된 건만 남는다).
    const partials = db.prepare(`SELECT id,no,customer,date,'부분출고' as tag FROM quotations
                                 WHERE order_status='partial' ORDER BY date DESC LIMIT 5`).all();
    const partialIds = new Set(partials.map(r => r.id));
    const unpaid = db.prepare(`SELECT id,no,customer,total,total_paid,date,'미수금' as tag FROM quotations
                               WHERE total > total_paid AND order_status NOT IN ('draft','cancelled')
                               ORDER BY date DESC LIMIT 10`).all().filter(r => !partialIds.has(r.id));
    const asItems = db.prepare(`SELECT id,cust_name as customer,issue,date,urgency,'AS' as tag FROM as_records
                                WHERE status='OPEN' ORDER BY date DESC LIMIT 5`).all();
    // id 가 서로 다른 테이블 것이라 그대로 합치면 충돌한다 → 태그를 붙인 키를 준다
    const workqueue = [...partials, ...unpaid, ...asItems].map(r => ({ ...r, key: `${r.tag}-${r.id}` }));
    // q.* 는 내부 메모(memo_internal)까지 내보내므로 필요한 컬럼만 고른다
    const recent = db.prepare(`SELECT q.id,q.no,q.customer,q.date,q.total,q.total_paid,q.order_status,c.name as cust_name
                               FROM quotations q LEFT JOIN customers c ON q.customer_id=c.id
                               ORDER BY q.id DESC LIMIT 10`).all();
    return json(res, 200, { kpi, workqueue, recent });
  }

  // ── /api/payments ────────────────────────────────────────────
  if (pathname === '/api/payments') {
    if (method === 'GET') {
      const rows = db.prepare(`SELECT p.*,q.no,q.customer FROM payments p LEFT JOIN quotations q ON p.order_id=q.id ORDER BY p.created_at DESC`).all();
      return json(res, 200, rows);
    }
    if (method === 'POST') {
      const body = await parseBody(req);
      if (!body || !body.order_id) return json(res, 400, { ok:false, error:'order_id, amount 필수' });
      const amount = Number(body.amount);
      if (!Number.isFinite(amount) || amount <= 0) return json(res, 400, { ok:false, error:'입금액은 0보다 커야 합니다.' });
      const order = db.prepare('SELECT order_status FROM quotations WHERE id=?').get(body.order_id);
      if (!order) return json(res, 400, { ok:false, error:'주문을 찾을 수 없습니다.' });
      if (order.order_status === 'cancelled') return json(res, 400, { ok:false, error:'취소된 주문에는 입금을 등록할 수 없습니다.' });
      let id;
      db.transaction(() => {
        id = db.prepare('INSERT INTO payments (order_id,amount,paid_at,note) VALUES (?,?,?,?)')
               .run(body.order_id, Math.round(amount), body.paid_at||today(), body.note||'').lastInsertRowid;
        recalcPaid(body.order_id);
      })();
      return json(res, 200, { ok:true, id });
    }
  }

  // ── /api/payments/order/:orderId ─────────────────────────────
  const mPayOrder = pathname.match(/^\/api\/payments\/order\/(\d+)$/);
  if (mPayOrder) {
    const orderId = parseInt(mPayOrder[1]);
    if (method === 'GET') return json(res, 200, db.prepare('SELECT * FROM payments WHERE order_id=? ORDER BY paid_at').all(orderId));
  }

  // ── /api/payments/:id ────────────────────────────────────────
  const mPayId = pathname.match(/^\/api\/payments\/(\d+)$/);
  if (mPayId) {
    const id = parseInt(mPayId[1]);
    if (method === 'DELETE') {
      const row = db.prepare('SELECT order_id FROM payments WHERE id=?').get(id);
      db.prepare('DELETE FROM payments WHERE id=?').run(id);
      if (row) recalcPaid(row.order_id);
      return json(res, 200, { ok:true });
    }
  }

  // ── /api/shipments ───────────────────────────────────────────
  if (pathname === '/api/shipments' && method === 'POST') {
    const body = await parseBody(req);
    if (!body || !body.order_id || !body.item_id) return json(res, 400, { ok:false, error:'order_id, item_id, qty 필수' });
    const qty = Number(body.qty);
    const err = validateLedgerEntry(LINE_ITEM.sales, body.order_id, body.item_id, qty,
                                    ['done','cancelled'], 'order_status');
    if (err) return json(res, 400, { ok:false, error: err });

    db.transaction(() => {
      db.prepare('INSERT INTO shipments (order_id,item_id,qty,shipped_at,note) VALUES (?,?,?,?,?)')
        .run(body.order_id, body.item_id, qty, body.shipped_at||'', body.note||'');
      db.prepare('UPDATE order_items SET shipped_qty = shipped_qty + ? WHERE id=?').run(qty, body.item_id);
      autoStatus(body.order_id);
    })();
    return json(res, 200, { ok:true });
  }

  // ── /api/shipments/order/:orderId ────────────────────────────
  const mShipOrder = pathname.match(/^\/api\/shipments\/order\/(\d+)$/);
  if (mShipOrder) {
    const orderId = parseInt(mShipOrder[1]);
    if (method === 'GET') return json(res, 200, db.prepare(`SELECT s.*,oi.name as item_name,oi.spec,oi.unit,sb.batch_no
                                                            FROM shipments s
                                                            LEFT JOIN order_items oi ON s.item_id=oi.id
                                                            LEFT JOIN shipment_batches sb ON s.batch_id=sb.id
                                                            WHERE s.order_id=? ORDER BY s.shipped_at DESC, s.id DESC`).all(orderId));
  }

  // ── /api/shipments/:id, /api/purchase_receipts/:id ───────────
  // 지금까지 출고·입고는 등록만 되고 되돌릴 수단이 없었다. 수량을 잘못 넣으면
  // DB 를 직접 고치는 것 말고는 방법이 없었다. 원장에서 다시 계산해 지운다.
  const mLedgerDel = pathname.match(/^\/api\/(shipments|purchase_receipts)\/(\d+)$/);
  if (mLedgerDel && method === 'DELETE') {
    const sales = mLedgerDel[1] === 'shipments';
    const cfg   = sales ? LINE_ITEM.sales : LINE_ITEM.purchase;
    const id    = parseInt(mLedgerDel[2]);
    const row = db.prepare(`SELECT ${cfg.parentCol} as parent FROM ${cfg.ledger} WHERE id=?`).get(id);
    if (!row) return json(res, 404, { ok:false, error:'해당 기록을 찾을 수 없습니다.' });
    const statusCol = sales ? 'order_status' : 'purchase_status';
    const st = db.prepare(`SELECT ${statusCol} as st FROM ${cfg.parent} WHERE id=?`).get(row.parent)?.st;
    if (['done','cancelled'].includes(st)) {
      return json(res, 400, { ok:false, error:`완료·취소된 건의 ${cfg.word} 기록은 삭제할 수 없습니다.` });
    }
    db.transaction(() => {
      db.prepare(`DELETE FROM ${cfg.ledger} WHERE id=?`).run(id);
      recalcLedgerQty(cfg, row.parent);   // 클라이언트 값이 아니라 원장에서 다시 센다
      // 전부 취소돼 0 이 되면 상태도 되돌려야 한다. autoStatus 는 올리기만 하므로
      // 먼저 ordered 로 내린 뒤 원장 기준으로 다시 올린다.
      const anyLeft = db.prepare(`SELECT COALESCE(SUM(${cfg.doneCol}),0) as n FROM ${cfg.items} WHERE ${cfg.parentCol}=?`).get(row.parent).n;
      if (!anyLeft && ['partial','shipped','received'].includes(st)) {
        db.prepare(`UPDATE ${cfg.parent} SET ${statusCol}='ordered' WHERE id=?`).run(row.parent);
      } else if (['partial','shipped','received'].includes(st)) {
        db.prepare(`UPDATE ${cfg.parent} SET ${statusCol}='ordered' WHERE id=?`).run(row.parent);
        cfg.after(row.parent);
      }
    })();
    return json(res, 200, { ok:true });
  }

  // ── /api/order_items/order/:orderId ──────────────────────────
  const mItemOrder = pathname.match(/^\/api\/order_items\/order\/(\d+)$/);
  if (mItemOrder) {
    const orderId = parseInt(mItemOrder[1]);
    if (method === 'GET') return json(res, 200, db.prepare('SELECT * FROM order_items WHERE order_id=? ORDER BY sort_order,id').all(orderId));
    if (method === 'PUT') {
      const body = await parseBody(req);
      if (!Array.isArray(body)) return json(res, 400, { ok:false, error:'품목 배열이 필요합니다.' });
      const order = db.prepare('SELECT order_status FROM quotations WHERE id=?').get(orderId);
      if (!order) return json(res, 404, { ok:false, error:'주문을 찾을 수 없습니다.' });
      if (['done','cancelled'].includes(order.order_status)) {
        return json(res, 400, { ok:false, error:'완료·취소된 주문의 품목은 수정할 수 없습니다.' });
      }
      const err = saveLineItems(LINE_ITEM.sales, orderId, body);
      if (err) return json(res, 400, { ok:false, error: err });
      return json(res, 200, { ok:true });
    }
  }

  // ── PATCH /api/quotations/:id/status ─────────────────────────
  const mQStatus = pathname.match(/^\/api\/quotations\/(\d+)\/status$/);
  if (mQStatus && method === 'PATCH') {
    const id   = parseInt(mQStatus[1]);
    const body = await parseBody(req);
    if (!body || !body.status) return json(res, 400, { ok:false, error:'status 필수' });
    if (!ORDER_STATUSES.includes(body.status)) return json(res, 400, { ok:false, error:'알 수 없는 상태입니다.' });
    // 취소는 사유를 남기는 전용 경로(/cancel)로만 — 사유 없는 취소건이 생기지 않도록
    if (body.status === 'cancelled') return json(res, 400, { ok:false, error:'취소는 /cancel 을 사용하세요.' });
    const current = db.prepare('SELECT order_status FROM quotations WHERE id=?').get(id);
    if (!current) return json(res, 404, { ok:false, error:'주문을 찾을 수 없습니다.' });
    if (!canTransit(current.order_status, body.status)) {
      return json(res, 400, { ok:false, error:`${current.order_status} → ${body.status} 로는 변경할 수 없습니다.` });
    }
    db.transaction(() => {
      db.prepare('UPDATE quotations SET order_status=? WHERE id=?').run(body.status, id);
      recordStatusChange(id, current.order_status, body.status, body.reason||'', req.user);
    })();
    return json(res, 200, { ok:true });
  }

  // ── PATCH /api/quotations/:id/cancel ─────────────────────────
  const mQCancel = pathname.match(/^\/api\/quotations\/(\d+)\/cancel$/);
  if (mQCancel && method === 'PATCH') {
    const id   = parseInt(mQCancel[1]);
    const body = await parseBody(req);
    const current = db.prepare('SELECT order_status FROM quotations WHERE id=?').get(id);
    if (!current) return json(res, 404, { ok:false, error:'주문을 찾을 수 없습니다.' });
    if (current.order_status === 'done') return json(res, 400, { ok:false, error:'완료된 주문은 취소할 수 없습니다.' });
    if (current.order_status === 'cancelled') return json(res, 400, { ok:false, error:'이미 취소된 주문입니다.' });
    const reason = (body?.reason || '').trim();
    if (!reason) return json(res, 400, { ok:false, error:'취소 사유를 입력하세요.' });
    db.transaction(() => {
      db.prepare('UPDATE quotations SET order_status=?,cancelled_at=?,cancelled_reason=? WHERE id=?')
        .run('cancelled', today(), reason, id);
      recordStatusChange(id, current.order_status, 'cancelled', reason, req.user);
    })();
    return json(res, 200, { ok:true });
  }

  // ── /api/quotations/:id/history — 상태 변경 이력 + 출처 견적 ──
  // status_changes / quotation_sources 는 그동안 쓰기만 하고 읽는 경로가 없었다.
  const mQHist = pathname.match(/^\/api\/quotations\/(\d+)\/history$/);
  if (mQHist && method === 'GET') {
    const id = parseInt(mQHist[1]);
    return json(res, 200, {
      changes: db.prepare(`SELECT id,from_status,to_status,changed_at,reason,user_id,user_name
                           FROM status_changes WHERE order_id=? ORDER BY id DESC`).all(id),
      sources: db.prepare(`SELECT qs.source_quotation_id, qs.source_item_ids, q.no, q.date, q.customer
                           FROM quotation_sources qs
                           LEFT JOIN quotations q ON q.id = qs.source_quotation_id
                           WHERE qs.order_id=?`).all(id),
    });
  }

  // ── /api/quotations/:id/uncancel — 취소 해제 ─────────────────
  const mQUncancel = pathname.match(/^\/api\/quotations\/(\d+)\/uncancel$/);
  if (mQUncancel && method === 'PATCH') {
    const id = parseInt(mQUncancel[1]);
    const current = db.prepare('SELECT order_status FROM quotations WHERE id=?').get(id);
    if (!current) return json(res, 404, { ok:false, error:'주문을 찾을 수 없습니다.' });
    if (current.order_status !== 'cancelled') return json(res, 400, { ok:false, error:'취소 상태가 아닙니다.' });
    // 무조건 draft 로 되돌리면 안 된다. tracksUnpaid 가 draft 를 미수금에서 제외하므로
    // 계약금만 받고 출고 전인 ordered 주문을 잘못 취소했다 해제하면 미수금이 증발한다.
    // autoStatus 는 출고 이력이 없으면 그냥 반환하므로 그것만으로는 복구되지 않는다.
    const prev = db.prepare(`SELECT from_status FROM status_changes
                             WHERE order_id=? AND to_status='cancelled' ORDER BY id DESC LIMIT 1`).get(id);
    const restored = ORDER_STATUSES.includes(prev?.from_status) && prev.from_status !== 'cancelled'
      ? prev.from_status : 'draft';
    db.transaction(() => {
      db.prepare('UPDATE quotations SET order_status=?,cancelled_at=?,cancelled_reason=? WHERE id=?')
        .run(restored, '', '', id);
      recordStatusChange(id, 'cancelled', restored, '취소 해제', req.user);
      autoStatus(id);   // 출고 이력이 있으면 원장 기준 실제 상태가 이긴다
    })();
    return json(res, 200, { ok:true });
  }

  // ── PATCH /api/quotations/:id/tax, /api/purchases/:id/tax ────
  const mTax = pathname.match(/^\/api\/(quotations|purchases)\/(\d+)\/tax$/);
  if (mTax && method === 'PATCH') {
    const cfg  = mTax[1] === 'quotations' ? LINE_ITEM.sales : LINE_ITEM.purchase;
    const id   = parseInt(mTax[2]);
    const body = await parseBody(req);
    const row  = db.prepare(`SELECT id FROM ${cfg.parent} WHERE id=?`).get(id);
    if (!row) return json(res, 404, { ok:false, error:'대상을 찾을 수 없습니다.' });
    const mode = body?.vat_mode;
    if (mode !== undefined && !['EXCLUSIVE','INCLUSIVE'].includes(mode)) {
      return json(res, 400, { ok:false, error:'과세 방식은 EXCLUSIVE 또는 INCLUSIVE 여야 합니다.' });
    }
    let rate;
    if (body?.vat_rate !== undefined) {
      rate = Number(body.vat_rate);
      // 0(영세율) ~ 1 만 허용. 10 을 넣으면 세액이 원금의 10배가 된다.
      if (!Number.isFinite(rate) || rate < 0 || rate > 1) {
        return json(res, 400, { ok:false, error:'세율은 0 이상 1 이하여야 합니다. (10% = 0.1)' });
      }
    }
    let disc;
    if (body?.discount !== undefined) {
      disc = Math.round(Number(body.discount));
      if (!Number.isFinite(disc) || disc < 0) return json(res, 400, { ok:false, error:'할인 금액은 0 이상이어야 합니다.' });
      if (!columnsOf(cfg.parent).has('discount')) return json(res, 400, { ok:false, error:'이 문서는 할인을 지원하지 않습니다.' });
    }
    db.transaction(() => {
      if (mode !== undefined) db.prepare(`UPDATE ${cfg.parent} SET vat_mode=? WHERE id=?`).run(mode, id);
      if (rate !== undefined) db.prepare(`UPDATE ${cfg.parent} SET vat_rate=? WHERE id=?`).run(rate, id);
      if (disc !== undefined) db.prepare(`UPDATE ${cfg.parent} SET discount=? WHERE id=?`).run(disc, id);
      recalcTotal(cfg, id);
    })();
    const cols = 'total,supply_amount,vat_amount,exempt_amount,vat_mode,vat_rate'
               + (columnsOf(cfg.parent).has('discount') ? ',discount' : '');
    return json(res, 200, { ok:true, ...db.prepare(`SELECT ${cols} FROM ${cfg.parent} WHERE id=?`).get(id) });
  }

  // ── PATCH /api/quotations/:id/drawing — 연결된 도면 기록 ─────
  // drawing_id 컬럼은 예전부터 있었지만 채우는 경로가 없어 실측 0건이었다.
  const mQDraw = pathname.match(/^\/api\/quotations\/(\d+)\/drawing$/);
  if (mQDraw && method === 'PATCH') {
    const id   = parseInt(mQDraw[1]);
    const body = await parseBody(req);
    const drawingId = String(body?.drawing_id ?? '').trim().slice(0, 64);
    const r = db.prepare('UPDATE quotations SET drawing_id=? WHERE id=?').run(drawingId, id);
    if (!r.changes) return json(res, 404, { ok:false, error:'주문을 찾을 수 없습니다.' });
    return json(res, 200, { ok:true, drawing_id: drawingId });
  }

  // ── PATCH /api/quotations/:id/memo ───────────────────────────
  const mQMemo = pathname.match(/^\/api\/quotations\/(\d+)\/memo$/);
  if (mQMemo && method === 'PATCH') {
    const id   = parseInt(mQMemo[1]);
    const body = await parseBody(req);
    if (!body) return json(res, 400, { ok:false });
    // 문서에 붙는 텍스트 항목들. 금액에 영향을 주는 discount 는 /tax 에서 다룬다.
    const FIELDS = ['memo_customer','memo_internal','site_name','valid_until','delivery_terms','payment_terms'];
    const sets = [], vals = [];
    for (const f of FIELDS) {
      if (body[f] !== undefined) { sets.push(`${f}=?`); vals.push(String(body[f])); }
    }
    if (!sets.length) return json(res, 400, { ok:false, error:'변경할 필드 없음' });
    db.prepare(`UPDATE quotations SET ${sets.join(',')} WHERE id=?`).run(...vals, id);
    return json(res, 200, { ok:true });
  }

  // ── POST /api/customers ──────────────────────────────────────
  // 견적을 쓰다 말고 고객 화면으로 넘어가지 않도록, 상호 하나만 있으면 만들어 준다.
  // 상호가 비슷한 거래처가 이미 있으면 알려주되 막지는 않는다 — 같은 회사인지
  // 아닌지는 사람이 판단할 일이다.
  if (pathname === '/api/customers' && method === 'POST') {
    const body = await parseBody(req);
    const name = String(body?.name || '').trim();
    if (!name) return json(res, 400, { ok:false, error:'상호를 입력하세요.' });

    const key = normName(name);
    const similar = db.prepare('SELECT id,name FROM customers').all()
                      .filter(c => normName(c.name) === key && c.name !== name);
    const exact = db.prepare('SELECT id,name FROM customers WHERE name = ?').get(name);
    if (exact) return json(res, 200, { ok:true, existing:true, ...exact });

    const id = body.id || nextCustomerId();
    db.prepare(`INSERT INTO customers (id,name,rep,business_no,phone,email,address_base,address_detail,address_post,status,price_group)
                VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, name, body.rep||'', body.business_no||'', body.phone||'', body.email||'',
      body.address_base||'', body.address_detail||'', body.address_post||'',
      body.status||'NORMAL', body.price_group||'A');
    return json(res, 200, { ok:true, id, name, similar });
  }

  /* 품목 템플릿. 같은 구성이 반복되는 공사가 있는데 매번 처음부터 적었다.
   * 제네릭 CRUD 를 열지 않는 이유는 items_json 이 배열인지 확인해야 하고,
   * 만든 사람을 화면 입력이 아니라 세션에서 가져와야 하기 때문이다. */
  if (pathname === '/api/item_templates') {
    if (method === 'GET') {
      return json(res, 200, db.prepare('SELECT * FROM item_templates ORDER BY name').all()
        .map(t => ({ ...t, items: JSON.parse(t.items_json || '[]') })));
    }
    if (method === 'POST') {
      const body = await parseBody(req);
      const name = String(body?.name || '').trim();
      if (!name) return json(res, 400, { ok:false, error:'템플릿 이름을 입력하세요.' });
      if (!Array.isArray(body?.items) || !body.items.length)
        return json(res, 400, { ok:false, error:'저장할 품목이 없습니다.' });
      if (db.prepare('SELECT 1 FROM item_templates WHERE name=?').get(name))
        return json(res, 409, { ok:false, error:'같은 이름의 템플릿이 있습니다.' });
      // 수량·출고 이력은 템플릿에 넣지 않는다. 다음 견적의 수량은 그때 정한다.
      const items = body.items.map(it => ({
        name: String(it?.name || '').trim(), spec: String(it?.spec || '').trim(),
        unit: String(it?.unit || 'EA'), qty: Number(it?.qty) || 0,
        unit_price: Math.max(0, parseInt(it?.unit_price, 10) || 0),
        note: String(it?.note || ''), tax_free: it?.tax_free ? 1 : 0,
      })).filter(it => it.name);
      if (!items.length) return json(res, 400, { ok:false, error:'품목명이 있는 행이 없습니다.' });
      const r = db.prepare(`INSERT INTO item_templates (name,items_json,created_by,created_at)
                            VALUES (?,?,?,datetime('now','localtime'))`)
                  .run(name, JSON.stringify(items), req.user ? (req.user.name || req.user.username) : '');
      return json(res, 200, { ok:true, id: r.lastInsertRowid, count: items.length });
    }
  }
  const mTpl = pathname.match(/^\/api\/item_templates\/(\d+)$/);
  if (mTpl && method === 'DELETE') {
    db.prepare('DELETE FROM item_templates WHERE id=?').run(parseInt(mTpl[1], 10));
    return json(res, 200, { ok:true });
  }

  /* 이 품목을 얼마에 적었었는지 알려준다. 근거는 두 가지뿐이고 순서가 있다 —
   * ① 같은 품목을 실제로 넣었던 가장 최근 견적의 단가, ② 카탈로그 가격.
   * 실제 거래가가 카탈로그 정가보다 앞선다.
   * 비교는 normItem 으로 한다. 띄어쓰기와 괄호만 다른 같은 품목이 흔하다. */
  if (pathname === '/api/price-hint' && method === 'GET') {
    const key = normItem(req.query.name, req.query.spec);
    if (!key || key === '|') return json(res, 200, { ok:true, price:null });

    const hist = db.prepare(`SELECT i.name, i.spec, i.unit_price, q.date
                             FROM order_items i JOIN quotations q ON q.id = i.order_id
                             WHERE i.unit_price > 0 ORDER BY q.date DESC, i.id DESC`).all()
                   .find(r => normItem(r.name, r.spec) === key);
    if (hist) return json(res, 200, { ok:true, price: hist.unit_price, source:'history', at: hist.date || '' });

    const cat = db.prepare('SELECT name,note,price FROM products WHERE price > 0').all()
                  .find(p => normItem(p.name, p.note) === key);
    if (cat) return json(res, 200, { ok:true, price: cat.price, source:'catalog', at:'' });

    return json(res, 200, { ok:true, price:null });
  }

  /* 견적에 적은 품목을 카탈로그로 돌려보낸다. 카탈로그는 비어 있고(시드 6건이
   * 전부 더미다) 앞으로도 따로 채워 넣을 사람이 없다. 쓰면서 쌓이게 한다.
   * 이미 있는 품목은 조용히 건너뛴다 — 단가를 덮어쓰면 견적마다 값이 달라
   * 카탈로그가 마지막 견적을 따라다니게 된다. */
  if (pathname === '/api/products/bulk' && method === 'POST') {
    const body = await parseBody(req);
    if (!Array.isArray(body)) return json(res, 400, { ok:false, error:'배열이어야 합니다.' });
    const have = new Set(db.prepare('SELECT name,note FROM products').all()
                           .map(p => normItem(p.name, p.note)));
    const ins = db.prepare(`INSERT INTO products (cat1,cat2,cat3,cat4,name,unit,price,note)
                            VALUES ('','','','',?,?,?,?)`);
    const added = [];
    db.transaction(() => {
      for (const it of body) {
        const name = String(it?.name || '').trim();
        if (!name) continue;
        const spec = String(it?.spec || '').trim();
        const k = normItem(name, spec);
        if (have.has(k)) continue;
        have.add(k);
        ins.run(name, String(it.unit || 'EA'), Math.max(0, parseInt(it.unit_price, 10) || 0), spec);
        added.push(name);
      }
    })();
    return json(res, 200, { ok:true, added: added.length, names: added });
  }

  // ── POST /api/quotations ─────────────────────────────────────
  // 판매번호는 서버가 매긴다. 화면에서 만들면 목록이 낡은 순간 겹치고,
  // 두 사람이 동시에 새 판매서를 열면 같은 번호를 본다.
  if (pathname === '/api/quotations' && method === 'POST') {
    const body = await parseBody(req);
    if (!body) return json(res, 400, { ok:false });
    if (body.no && db.prepare('SELECT 1 FROM quotations WHERE no=?').get(body.no))
      return json(res, 409, { ok:false, error:'이미 있는 판매번호입니다.' });
    const cust = db.prepare('SELECT * FROM customers WHERE id=?').get(body.customer_id||'');
    const date = body.date || today();
    const r = db.prepare(`INSERT INTO quotations (no,date,customer_id,customer,order_status,total,total_paid,items,ref,status,created_by,site_name,valid_until)
                          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      body.no || nextOrderNo(), date, body.customer_id||'',
      cust?.name || body.customer || '', 'draft', 0, 0, body.memo || body.items || '',
      companyName(), '진행중', req.user.name || req.user.username,
      body.site_name || '', body.valid_until || defaultValidUntil(date)
    );
    return json(res, 200, { ok:true, ...getOne(TABLES.quotations, r.lastInsertRowid) });
  }

  // ── POST /api/quotations/from-quotations ─────────────────────
  if (pathname === '/api/quotations/from-quotations' && method === 'POST') {
    const body = await parseBody(req);
    if (!body) return json(res, 400, { ok:false });
    const now = new Date();
    const mm = String(now.getMonth()+1).padStart(2,'0');
    const dd = String(now.getDate()).padStart(2,'0');
    const today = `${now.getFullYear()}-${mm}-${dd}`;
    if (body.no && db.prepare('SELECT 1 FROM quotations WHERE no=?').get(body.no))
      return json(res, 409, { ok:false, error:'이미 있는 판매번호입니다.' });
    const no = body.no || nextOrderNo(now);
    const cust = db.prepare('SELECT * FROM customers WHERE id=?').get(body.customer_id||'');
    const r = db.prepare('INSERT INTO quotations (no,date,customer_id,customer,order_status,total,total_paid,items,ref,status,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(
      no, body.date||today, body.customer_id||'', cust?.name||body.customer||'', 'draft', 0, 0, body.memo||'', companyName(), '진행중',
      req.user.name || req.user.username
    );
    const newId = r.lastInsertRowid;
    let sortOrder = 0;
    const insertRaw = db.prepare('INSERT INTO order_items (order_id,name,spec,unit,qty,unit_price,shipped_qty,note,sort_order,amount,tax_free) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
    // 행 금액은 정수로 확정하고 과세구분(tax_free)은 원본에서 승계한다
    const insertItem = (oid, name, spec, unit, qty, price, done, note, sort, taxFree) =>
      insertRaw.run(oid, name, spec, unit, qty, price, done, note, sort, Math.round((qty||0)*(price||0)), taxFree ? 1 : 0);
    if (body.items_from?.length) {
      db.transaction(() => {
        for (const src of body.items_from) {
          if (!src.selected_item_ids?.length) continue;
          const ph = src.selected_item_ids.map(()=>'?').join(',');
          const srcItems = db.prepare(`SELECT * FROM order_items WHERE order_id=? AND id IN (${ph}) ORDER BY sort_order`).all(src.quotation_id, ...src.selected_item_ids);
          for (const it of srcItems) insertItem(newId, it.name, it.spec||'', it.unit||'EA', it.qty||0, it.unit_price||0, 0, it.note||'', sortOrder++, it.tax_free);
          db.prepare('INSERT INTO quotation_sources (order_id,source_quotation_id,source_item_ids) VALUES (?,?,?)').run(newId, src.quotation_id, JSON.stringify(src.selected_item_ids));
        }
      })();
    }
    if (body.additional_items?.length) {
      db.transaction(() => {
        for (const it of body.additional_items) insertItem(newId, it.name||'', it.spec||'', it.unit||'EA', it.qty||0, it.unit_price||0, 0, it.note||'', sortOrder++, it.tax_free);
      })();
    }
    recalcTotal(LINE_ITEM.sales, newId);   // 공급가액·부가세까지 한 곳에서 계산한다
    return json(res, 200, { ok:true, id: newId, no });
  }

  // ── POST /api/quotations/:id/copy ────────────────────────────
  /* 지난 견적을 그대로 한 건 더. 가져오는 것과 안 가져오는 것이 갈린다.
   * 가져온다: 품목·거래처·현장명·메모·과세구분·할인.
   * 안 가져온다: 출고·입금·상태 이력·도면 연결(같은 도면을 두 건이 함께 물면
   * 한쪽을 고칠 때 다른 쪽이 조용히 바뀐다)·유효기간(오늘 기준으로 다시 잡는다). */
  const mCopy = pathname.match(/^\/api\/quotations\/(\d+)\/copy$/);
  if (mCopy && method === 'POST') {
    const srcId = parseInt(mCopy[1], 10);
    const src = db.prepare('SELECT * FROM quotations WHERE id=?').get(srcId);
    if (!src) return json(res, 404, { ok:false, error:'원본을 찾을 수 없습니다.' });
    /* 이관된 옛 건은 품목 행 없이 items 요약 문자열과 금액만 있다. 그대로 복사하면
     * "경첩 [k-702]" 라고 적힌 0원짜리 견적이 생겨 목록에서 진짜와 구분되지 않는다. */
    const srcItems = db.prepare('SELECT * FROM order_items WHERE order_id=? ORDER BY sort_order,id').all(srcId);
    if (!srcItems.length)
      return json(res, 400, { ok:false, error:'이 건에는 품목 내역이 없어 복사할 것이 없습니다. 새 판매로 만드세요.' });

    const now = new Date();
    const no = nextOrderNo(now);
    const cols = columnsOf('quotations');
    const extra = ['site_name','delivery_terms','payment_terms','discount','vat_mode','vat_rate','tax_free']
                    .filter(c => cols.has(c));
    const newId = db.transaction(() => {
      const names = ['no','date','customer_id','customer','order_status','total','total_paid',
                     'items','ref','status','created_by','memo_customer','memo_internal', ...extra];
      const vals  = [no, today(), src.customer_id || '', src.customer || '', 'draft', 0, 0,
                     src.items || '', companyName(), '진행중',
                     req.user.name || req.user.username, src.memo_customer || '', src.memo_internal || '',
                     ...extra.map(c => src[c])];
      if (cols.has('valid_until')) { names.push('valid_until'); vals.push(defaultValidUntil(today())); }
      const id = db.prepare(`INSERT INTO quotations (${names.join(',')})
                             VALUES (${names.map(()=>'?').join(',')})`).run(...vals).lastInsertRowid;

      const ins = db.prepare(`INSERT INTO order_items (order_id,name,spec,unit,qty,unit_price,shipped_qty,note,sort_order,amount,tax_free)
                              VALUES (?,?,?,?,?,?,0,?,?,?,?)`);
      srcItems.forEach((it, i) => ins.run(id, it.name, it.spec||'', it.unit||'EA', it.qty||0,
                                          it.unit_price||0, it.note||'', i,
                                          Math.round((it.qty||0)*(it.unit_price||0)), it.tax_free?1:0));
      db.prepare('INSERT INTO quotation_sources (order_id,source_quotation_id,source_item_ids) VALUES (?,?,?)')
        .run(id, srcId, JSON.stringify(srcItems.map(it => it.id)));
      recalcTotal(LINE_ITEM.sales, id);
      return id;
    })();
    return json(res, 200, { ok:true, id: newId, no });
  }

  // ── /api/shipment-batches ────────────────────────────────────
  if (pathname === '/api/shipment-batches') {
    if (method === 'GET') {
      const rows = db.prepare('SELECT sb.*,COUNT(s.id) as items_count FROM shipment_batches sb LEFT JOIN shipments s ON s.batch_id=sb.id GROUP BY sb.id ORDER BY sb.created_at DESC').all();
      return json(res, 200, rows);
    }
    if (method === 'POST') {
      const body = await parseBody(req);
      if (!body || !body.items?.length) return json(res, 400, { ok:false, error:'items 필수' });
      const now = new Date();
      const ds = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}`;
      const batch_no = `SB${ds}${String(nextSeq('shipment_batches','batch_no',`SB${ds}`)).padStart(3,'0')}`;
      const br = db.prepare('INSERT INTO shipment_batches (batch_no,shipped_at,note) VALUES (?,?,?)').run(batch_no, body.shipped_at||'', body.note||'');
      const batchId = br.lastInsertRowid;
      db.transaction(() => {
        for (const item of body.items) {
          db.prepare('INSERT INTO shipments (order_id,item_id,qty,shipped_at,note,batch_id) VALUES (?,?,?,?,?,?)').run(item.order_id, item.item_id, item.qty, body.shipped_at||'', body.note||'', batchId);
          db.prepare('UPDATE order_items SET shipped_qty = shipped_qty + ? WHERE id=?').run(item.qty, item.item_id);
          autoStatus(item.order_id);
        }
      })();
      return json(res, 200, { ok:true, batch_id: batchId, batch_no });
    }
  }

  // ── /api/shipment-batches/:id ────────────────────────────────
  const mSB = pathname.match(/^\/api\/shipment-batches\/(\d+)$/);
  if (mSB && method === 'GET') {
    const id = parseInt(mSB[1]);
    const batch = db.prepare('SELECT * FROM shipment_batches WHERE id=?').get(id);
    if (!batch) return json(res, 404, { ok:false });
    const items = db.prepare('SELECT s.*,oi.name as item_name,q.no as order_no FROM shipments s LEFT JOIN order_items oi ON s.item_id=oi.id LEFT JOIN quotations q ON s.order_id=q.id WHERE s.batch_id=?').all(id);
    return json(res, 200, { ...batch, items });
  }

  // ── /api/completion-batches ──────────────────────────────────
  if (pathname === '/api/completion-batches') {
    if (method === 'GET') {
      const rows = db.prepare('SELECT cb.*,COUNT(q.id) as orders_count FROM completion_batches cb LEFT JOIN quotations q ON q.completion_batch_id=cb.id GROUP BY cb.id ORDER BY cb.created_at DESC').all();
      return json(res, 200, rows);
    }
    if (method === 'POST') {
      const body = await parseBody(req);
      if (!body || !body.order_ids?.length) return json(res, 400, { ok:false, error:'order_ids 필수' });

      // 출고가 끝나지 않은 주문을 완료 처리하면 되돌릴 방법이 없다 → 먼저 막는다
      const targets = [];
      for (const orderId of body.order_ids) {
        const cur = db.prepare('SELECT id,no,order_status FROM quotations WHERE id=?').get(orderId);
        if (!cur) return json(res, 400, { ok:false, error:`주문 ${orderId} 을 찾을 수 없습니다.` });
        if (!canTransit(cur.order_status, 'done')) {
          return json(res, 400, { ok:false, error:`${cur.no||orderId} 은 ${cur.order_status} 상태라 완료할 수 없습니다.` });
        }
        const un = db.prepare(`SELECT COUNT(*) as n FROM order_items WHERE order_id=? AND shipped_qty < qty`).get(orderId).n;
        if (un > 0) return json(res, 400, { ok:false, error:`${cur.no||orderId} 은 출고가 끝나지 않았습니다.` });
        targets.push(cur);
      }

      const ds = today().replace(/-/g, '');
      let batchId, batch_no;
      db.transaction(() => {
        batch_no = `CB${ds}${String(nextSeq('completion_batches','batch_no',`CB${ds}`)).padStart(3,'0')}`;
        batchId = db.prepare('INSERT INTO completion_batches (batch_no,completed_at,note) VALUES (?,?,?)')
                    .run(batch_no, body.completed_at||today(), body.note||'').lastInsertRowid;
        for (const cur of targets) {
          db.prepare('UPDATE quotations SET order_status=?,completion_batch_id=? WHERE id=?').run('done', batchId, cur.id);
          recordStatusChange(cur.id, cur.order_status, 'done', `완료묶음 ${batch_no}`, req.user);
        }
      })();
      return json(res, 200, { ok:true, batch_id: batchId, batch_no });
    }
  }

  // ── DELETE /api/completion-batches/:id — 완료 묶음 취소 ──────
  const mCBId = pathname.match(/^\/api\/completion-batches\/(\d+)$/);
  if (mCBId && method === 'DELETE') {
    const id = parseInt(mCBId[1]);
    const batch = db.prepare('SELECT * FROM completion_batches WHERE id=?').get(id);
    if (!batch) return json(res, 404, { ok:false, error:'완료 묶음을 찾을 수 없습니다.' });
    const rows = db.prepare('SELECT id,order_status FROM quotations WHERE completion_batch_id=?').all(id);
    db.transaction(() => {
      for (const o of rows) uncompleteOrder(o, `완료묶음 ${batch.batch_no} 취소`, req.user);
      db.prepare('DELETE FROM completion_batches WHERE id=?').run(id);
    })();
    return json(res, 200, { ok:true, restored: rows.length });
  }

  // ── PATCH /api/quotations/:id/uncomplete — 완료 해제 ─────────
  const mQUncomp = pathname.match(/^\/api\/quotations\/(\d+)\/uncomplete$/);
  if (mQUncomp && method === 'PATCH') {
    const id  = parseInt(mQUncomp[1]);
    const cur = db.prepare('SELECT id,order_status,completion_batch_id FROM quotations WHERE id=?').get(id);
    if (!cur) return json(res, 404, { ok:false, error:'주문을 찾을 수 없습니다.' });
    if (cur.order_status !== 'done') return json(res, 400, { ok:false, error:'완료 상태가 아닙니다.' });
    let restored;
    db.transaction(() => {
      restored = uncompleteOrder(cur, '완료 해제', req.user);
      // 묶음이 비면 남겨 둘 이유가 없다 — 빈 묶음이 목록에 쌓인다
      if (cur.completion_batch_id != null) {
        const left = db.prepare('SELECT COUNT(*) as n FROM quotations WHERE completion_batch_id=?').get(cur.completion_batch_id).n;
        if (left === 0) db.prepare('DELETE FROM completion_batches WHERE id=?').run(cur.completion_batch_id);
      }
    })();
    return json(res, 200, { ok:true, order_status: restored });
  }

  // ── /api/quotations/:id/items (편의 조회) ────────────────────
  const mQItems = pathname.match(/^\/api\/quotations\/(\d+)\/items$/);
  if (mQItems && method === 'GET') {
    const orderId = parseInt(mQItems[1]);
    return json(res, 200, db.prepare('SELECT * FROM order_items WHERE order_id=? ORDER BY sort_order,id').all(orderId));
  }

  // ── /api/customers/:id/quotations ────────────────────────────
  const mCustQ = pathname.match(/^\/api\/customers\/([^/]+)\/quotations$/);
  if (mCustQ && method === 'GET') {
    return json(res, 200, db.prepare('SELECT * FROM quotations WHERE customer_id=? ORDER BY id DESC').all(mCustQ[1]));
  }

  // ── /api/customers/:id/as ────────────────────────────────────
  const mCustAS = pathname.match(/^\/api\/customers\/([^/]+)\/as$/);
  if (mCustAS && method === 'GET') {
    return json(res, 200, db.prepare('SELECT * FROM as_records WHERE cust_id=? ORDER BY date DESC').all(mCustAS[1]));
  }

  // ── /api/purchase_payments ───────────────────────────────────
  if (pathname === '/api/purchase_payments') {
    if (method === 'GET') {
      return json(res, 200, db.prepare('SELECT p.*,q.no,q.vendor FROM purchase_payments p LEFT JOIN purchases q ON p.purchase_id=q.id ORDER BY p.created_at DESC').all());
    }
    if (method === 'POST') {
      const body = await parseBody(req);
      if (!body || !body.purchase_id || !body.amount) return json(res, 400, { ok:false, error:'purchase_id, amount 필수' });
      const pur = db.prepare('SELECT purchase_status FROM purchases WHERE id=?').get(body.purchase_id);
      if (!pur) return json(res, 404, { ok:false, error:'발주를 찾을 수 없습니다.' });
      if (pur.purchase_status === 'cancelled') return json(res, 400, { ok:false, error:'취소된 발주에는 지급을 등록할 수 없습니다.' });
      db.prepare('INSERT INTO purchase_payments (purchase_id,amount,paid_at,note) VALUES (?,?,?,?)').run(body.purchase_id, body.amount, body.paid_at||'', body.note||'');
      recalcPurchasePaid(body.purchase_id);
      return json(res, 200, { ok:true });
    }
  }

  const mPPP = pathname.match(/^\/api\/purchase_payments\/purchase\/(\d+)$/);
  if (mPPP && method === 'GET') {
    return json(res, 200, db.prepare('SELECT * FROM purchase_payments WHERE purchase_id=? ORDER BY paid_at').all(parseInt(mPPP[1])));
  }

  const mPPI = pathname.match(/^\/api\/purchase_payments\/(\d+)$/);
  if (mPPI && method === 'DELETE') {
    const id = parseInt(mPPI[1]);
    const row = db.prepare('SELECT purchase_id FROM purchase_payments WHERE id=?').get(id);
    db.prepare('DELETE FROM purchase_payments WHERE id=?').run(id);
    if (row) recalcPurchasePaid(row.purchase_id);
    return json(res, 200, { ok:true });
  }

  // ── /api/purchase_receipts ───────────────────────────────────
  if (pathname === '/api/purchase_receipts' && method === 'POST') {
    const body = await parseBody(req);
    if (!body || !body.purchase_id || !body.item_id) return json(res, 400, { ok:false, error:'purchase_id, item_id, qty 필수' });
    const qty = Number(body.qty);
    const err = validateLedgerEntry(LINE_ITEM.purchase, body.purchase_id, body.item_id, qty,
                                    ['done','cancelled'], 'purchase_status');
    if (err) return json(res, 400, { ok:false, error: err });
    db.transaction(() => {
      db.prepare('INSERT INTO purchase_receipts (purchase_id,item_id,qty,received_at,note) VALUES (?,?,?,?,?)')
        .run(body.purchase_id, body.item_id, qty, body.received_at||'', body.note||'');
      db.prepare('UPDATE purchase_items SET received_qty = received_qty + ? WHERE id=?').run(qty, body.item_id);
      autoReceiveStatus(body.purchase_id);
    })();
    return json(res, 200, { ok:true });
  }

  const mPRP = pathname.match(/^\/api\/purchase_receipts\/purchase\/(\d+)$/);
  if (mPRP && method === 'GET') {
    return json(res, 200, db.prepare('SELECT r.*,pi.name as item_name FROM purchase_receipts r LEFT JOIN purchase_items pi ON r.item_id=pi.id WHERE r.purchase_id=? ORDER BY r.received_at').all(parseInt(mPRP[1])));
  }

  // ── /api/purchase_items/purchase/:id ─────────────────────────
  const mPIP = pathname.match(/^\/api\/purchase_items\/purchase\/(\d+)$/);
  if (mPIP) {
    const purchaseId = parseInt(mPIP[1]);
    if (method === 'GET') return json(res, 200, db.prepare('SELECT * FROM purchase_items WHERE purchase_id=? ORDER BY sort_order,id').all(purchaseId));
    if (method === 'PUT') {
      const body = await parseBody(req);
      if (!Array.isArray(body)) return json(res, 400, { ok:false, error:'품목 배열이 필요합니다.' });
      const p = db.prepare('SELECT purchase_status FROM purchases WHERE id=?').get(purchaseId);
      if (!p) return json(res, 404, { ok:false, error:'구매 건을 찾을 수 없습니다.' });
      if (['done','cancelled'].includes(p.purchase_status)) return json(res, 400, { ok:false, error:'완료·취소된 구매 건의 품목은 수정할 수 없습니다.' });
      const err = saveLineItems(LINE_ITEM.purchase, purchaseId, body);
      if (err) return json(res, 400, { ok:false, error: err });
      return json(res, 200, { ok:true });
    }
  }

  // ── POST /api/purchases ──────────────────────────────────────
  // 판매와 같은 이유로 발주번호도 서버가 매긴다 (화면의 COUNT 는 겹친다).
  if (pathname === '/api/purchases' && method === 'POST') {
    const body = await parseBody(req);
    if (!body) return json(res, 400, { ok:false });
    if (body.no && db.prepare('SELECT 1 FROM purchases WHERE no=?').get(body.no))
      return json(res, 409, { ok:false, error:'이미 있는 발주번호입니다.' });
    const r = db.prepare(`INSERT INTO purchases (no,date,vendor,vendor_id,items,total,total_paid,purchase_status,status,memo,created_by)
                          VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      body.no || nextPurchaseNo(), body.date || today(), body.vendor || '', body.vendor_id || '',
      body.items || '', 0, 0, 'draft', '진행중', body.memo || '', req.user.name || req.user.username
    );
    return json(res, 200, { ok:true, ...getOne(TABLES.purchases, r.lastInsertRowid) });
  }

  // ── PATCH /api/purchases/:id/status ──────────────────────────
  const mPStat = pathname.match(/^\/api\/purchases\/(\d+)\/status$/);
  if (mPStat && method === 'PATCH') {
    const id   = parseInt(mPStat[1]);
    const body = await parseBody(req);
    if (!body || !PURCHASE_STATUSES.includes(body.status)) return json(res, 400, { ok:false, error:'알 수 없는 상태입니다.' });
    // 취소는 사유를 남기는 전용 경로로만 — 사유 없는 취소건이 생기지 않도록
    if (body.status === 'cancelled') return json(res, 400, { ok:false, error:'취소는 /cancel 을 사용하세요.' });
    const cur = db.prepare('SELECT purchase_status FROM purchases WHERE id=?').get(id);
    if (!cur) return json(res, 404, { ok:false, error:'발주를 찾을 수 없습니다.' });
    if (!canTransitPurchase(cur.purchase_status, body.status))
      return json(res, 400, { ok:false, error:`${cur.purchase_status} → ${body.status} 로는 바꿀 수 없습니다.` });
    db.prepare('UPDATE purchases SET purchase_status=? WHERE id=?').run(body.status, id);
    return json(res, 200, { ok:true });
  }

  // ── PATCH /api/purchases/:id/cancel · /uncancel ──────────────
  const mPCancel = pathname.match(/^\/api\/purchases\/(\d+)\/(cancel|uncancel)$/);
  if (mPCancel && method === 'PATCH') {
    const id  = parseInt(mPCancel[1]);
    const cur = db.prepare('SELECT * FROM purchases WHERE id=?').get(id);
    if (!cur) return json(res, 404, { ok:false, error:'발주를 찾을 수 없습니다.' });

    if (mPCancel[2] === 'cancel') {
      const body = await parseBody(req) || {};
      const reason = String(body.reason || '').trim();
      if (!reason) return json(res, 400, { ok:false, error:'취소 사유를 입력하세요.' });
      if (cur.purchase_status === 'cancelled') return json(res, 400, { ok:false, error:'이미 취소된 발주입니다.' });
      if (cur.purchase_status === 'done')      return json(res, 400, { ok:false, error:'정산 완료된 발주는 취소할 수 없습니다.' });
      db.prepare(`UPDATE purchases SET purchase_status='cancelled',cancelled_at=?,cancelled_reason=?,cancelled_from=? WHERE id=?`)
        .run(today(), reason, cur.purchase_status, id);
      return json(res, 200, { ok:true });
    }

    if (cur.purchase_status !== 'cancelled') return json(res, 400, { ok:false, error:'취소 상태가 아닙니다.' });
    // 취소 전 상태로 되돌린다. 무조건 draft 로 두면 입고·지급 기록이 있는
    // 발주가 작성중으로 내려앉아 미지급금 집계에서 빠진다.
    const restored = PURCHASE_STATUSES.includes(cur.cancelled_from) && cur.cancelled_from !== 'cancelled'
                   ? cur.cancelled_from : 'draft';
    db.prepare(`UPDATE purchases SET purchase_status=?,cancelled_at='',cancelled_reason='',cancelled_from='' WHERE id=?`)
      .run(restored, id);
    return json(res, 200, { ok:true, purchase_status: restored });
  }

  // ── blob 리소스 ──────────────────────────────────────────────
  const mBase = pathname.match(/^\/api\/([a-z_]+)$/);
  if (mBase) {
    const resource = mBase[1];

    if (BLOB_KEYS.has(resource)) {
      if (method === 'GET') {
        const row = db.prepare('SELECT value FROM blobs WHERE key=?').get(resource);
        res.writeHead(200, {'Content-Type':'application/json; charset=utf-8'});
        res.end(row ? row.value : (resource === 'inventory' ? '[]' : '{}'));
        return;
      }
      if (method === 'PUT') {
        const body = await parseBody(req);
        if (body === null) return json(res, 400, { ok:false, error:'본문 없음' });
        db.prepare('INSERT INTO blobs(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(resource, JSON.stringify(body));
        return json(res, 200, { ok:true });
      }
      return json(res, 405, { ok:false });
    }

    const cfg = TABLES[resource];
    if (!cfg) return json(res, 404, { ok:false, error:'알 수 없는 리소스' });

    // 쿼리스트링이 있으면 { rows, total, limit, offset } 봉투를, 없으면 배열을
    // 돌려준다. 기존 호출부(전체 목록을 쓰는 곳)를 깨지 않으면서 페이지네이션을 연다.
    if (method === 'GET') {
      return json(res, 200, Object.keys(req.query).length ? queryList(cfg, req.query) : getAll(cfg));
    }
    if (method === 'POST') {
      const item = await parseBody(req);
      if (!item) return json(res, 400, { ok:false, error:'본문 없음' });
      // 작성자는 클라이언트가 보낸 값이 아니라 세션에서 가져온다
      if (CREATED_BY_TABLES.has(cfg.table)) {
        item.created_by = req.user.name || req.user.username;
      }
      upsert(cfg, item);
      return json(res, 200, { ok:true, id: item.id ?? lastRowId(cfg.table) });
    }
    // PUT /api/:resource (테이블 전체 교체) 는 제거됨 — 프론트에서 쓰지 않으며
    // 빈 배열 하나로 테이블이 통째로 비워지는 사고 경로였다.
    return json(res, 405, { ok:false, error:'허용되지 않는 메서드' });
  }

  // ── /api/:resource/:id ───────────────────────────────────────
  const mItem = pathname.match(/^\/api\/([a-z_]+)\/([^/]+)$/);
  if (mItem) {
    const resource = mItem[1];
    const cfg = TABLES[resource];
    if (!cfg) return json(res, 404, { ok:false, error:'알 수 없는 리소스' });

    const rawId = mItem[2];
    const id    = cfg.int && /^\d+$/.test(rawId) ? parseInt(rawId, 10)
                : cfg.table === 'drawings' ? drawingId(rawId)
                : rawId;

    if (method === 'GET') {
      const item = getOne(cfg, id);
      if (!item) return json(res, 404, { ok:false, error:'항목 없음' });
      return json(res, 200, item);
    }
    if ((method === 'PUT' || method === 'PATCH') && GENERIC_WRITE_BLOCKED.has(resource)) {
      return json(res, 405, { ok:false, error:'전용 엔드포인트를 사용하세요.' });
    }
    if (method === 'PUT') {
      const body = await parseBody(req);
      if (!body) return json(res, 400, { ok:false });
      if (!updateOne(cfg, id, body)) return json(res, 404, { ok:false });
      return json(res, 200, { ok:true });
    }
    if (method === 'PATCH') {
      const body = await parseBody(req) || {};
      const item = getOne(cfg, id);
      if (!item) return json(res, 404, { ok:false });
      // 빈 본문 = 즐겨찾기 토글. 도면에만 있는 동작인데 모든 테이블에 적용돼
      // starred 컬럼이 없는 곳에서는 SQL 오류가 났다.
      if (Object.keys(body).length === 0) {
        if (cfg.table !== 'drawings') return json(res, 400, { ok:false, error:'변경할 내용이 없습니다.' });
        updateOne(cfg, id, { starred: !item.starred });
        return json(res, 200, { ok:true, ...getOne(cfg, id) });
      }
      updateOne(cfg, id, body);
      return json(res, 200, { ok:true, ...getOne(cfg, id) });
    }
    if (method === 'DELETE') { deleteOne(cfg, id); return json(res, 200, { ok:true }); }
    return json(res, 405, { ok:false });
  }

  serveStatic(req, res, pathname);
}

// 예기치 못한 오류로 프로세스가 죽지 않도록 (Node 18+ 는 기본이 fatal)
process.on('unhandledRejection', err => {
  console.error(`[${new Date().toISOString()}] unhandledRejection\n`, err);
});
process.on('uncaughtException', err => {
  console.error(`[${new Date().toISOString()}] uncaughtException\n`, err);
});

server.listen(PORT, () => {
  console.log(`\n  ❄️  ColdStorage Master (SQLite)\n  🌐  http://localhost:${PORT}\n`);
});
