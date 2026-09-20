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
    total_amount INTEGER DEFAULT 0, last_activity TEXT DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS quotations (
    id INTEGER PRIMARY KEY,
    no TEXT DEFAULT '', customer TEXT DEFAULT '',
    items TEXT DEFAULT '', total INTEGER DEFAULT 0,
    payment TEXT DEFAULT '', drawing INTEGER DEFAULT 0,
    accounting INTEGER DEFAULT 0, printed INTEGER DEFAULT 0,
    ref TEXT DEFAULT '', date TEXT DEFAULT '', status TEXT DEFAULT '진행중',
    customer_id TEXT DEFAULT '', drawing_id TEXT DEFAULT '',
    order_status TEXT DEFAULT 'draft', total_paid INTEGER DEFAULT 0,
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
  CREATE TABLE IF NOT EXISTS quotation_sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER,
    source_quotation_id INTEGER,
    source_item_ids TEXT DEFAULT '[]'
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
    return { id, starred: starred?1:0, data: JSON.stringify(rest) };
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
function getOne(cfg, id) {
  return rowOut(cfg.table, db.prepare(`SELECT * FROM ${cfg.table} WHERE id = ?`).get(id));
}
function upsert(cfg, item) {
  const row  = rowIn(cfg.table, item);
  const keys = Object.keys(row);
  const vals = keys.map(k => row[k] ?? null);
  const ph   = keys.map(() => '?').join(', ');
  const upd  = keys.filter(k => k !== 'id').map(k => `${k} = excluded.${k}`).join(', ');
  db.prepare(`INSERT INTO ${cfg.table} (${keys.join(', ')}) VALUES (${ph}) ON CONFLICT(id) DO UPDATE SET ${upd}`).run(...vals);
}
function updateOne(cfg, id, patch) {
  const row  = rowIn(cfg.table, { id, ...patch });
  const keys = Object.keys(row).filter(k => k !== 'id');
  if (!keys.length) return false;
  const vals = keys.map(k => row[k] ?? null);
  return db.prepare(`UPDATE ${cfg.table} SET ${keys.map(k=>`${k}=?`).join(',')} WHERE id=?`).run(...vals, id).changes > 0;
}
function deleteOne(cfg, id) {
  db.prepare(`DELETE FROM ${cfg.table} WHERE id=?`).run(id);
}
// 금액·상태 캐시 컬럼을 클라이언트가 직접 덮어쓰지 못하도록 — 이 테이블들은
// 전용 엔드포인트(/status, /cancel, /memo, /order_items/order/:id)로만 수정한다.
const GENERIC_WRITE_BLOCKED = new Set(['quotations', 'purchases', 'order_items', 'purchase_items']);

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

// 부모의 total 을 품목에서 재계산한다 (캐시 컬럼 드리프트 방지).
function recalcTotal(cfg, parentId) {
  const s = db.prepare(`SELECT COALESCE(SUM(qty*unit_price),0) as s FROM ${cfg.items} WHERE ${cfg.parentCol}=?`).get(parentId).s;
  db.prepare(`UPDATE ${cfg.parent} SET total=? WHERE id=?`).run(Math.round(s), parentId);
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

    const upd = db.prepare(`UPDATE ${cfg.items} SET name=?,spec=?,unit=?,qty=?,unit_price=?,note=?,sort_order=? WHERE id=?`);
    const ins = db.prepare(`INSERT INTO ${cfg.items} (${cfg.parentCol},name,spec,unit,qty,unit_price,${cfg.doneCol},note,sort_order)
                            VALUES (?,?,?,?,?,?,0,?,?)`);
    items.forEach((item, i) => {
      const vals = [item.name||'', item.spec||'', item.unit||'EA',
                    Number(item.qty)||0, Number(item.unit_price)||0, item.note||'', i];
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

function recordStatusChange(orderId, fromStatus, toStatus, reason) {
  db.prepare('INSERT INTO status_changes (order_id,from_status,to_status,reason) VALUES (?,?,?,?)').run(orderId, fromStatus||'', toStatus||'', reason||'');
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
  if (!purchase || purchase.purchase_status === 'done') return;
  const items = db.prepare('SELECT * FROM purchase_items WHERE purchase_id=?').all(purchaseId);
  if (!items.length) return;
  const allReceived = items.every(i => i.received_qty >= i.qty);
  const anyReceived = items.some(i => i.received_qty > 0);
  if (allReceived) db.prepare('UPDATE purchases SET purchase_status=? WHERE id=?').run('received', purchaseId);
  else if (anyReceived) db.prepare('UPDATE purchases SET purchase_status=? WHERE id=?').run('partial', purchaseId);
}

// ─── MIME / CORS ─────────────────────────────────────────────
const MIME = {
  '.html':'text/html; charset=utf-8', '.js':'application/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8',   '.json':'application/json; charset=utf-8',
  '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg',
  '.svg':'image/svg+xml', '.ico':'image/x-icon',
};
const CORS = {
  'Access-Control-Allow-Origin':'*',
  'Access-Control-Allow-Methods':'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers':'Content-Type',
};

const json = (res, status, data) => {
  res.writeHead(status, { 'Content-Type':'application/json; charset=utf-8', ...CORS });
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

// ─── 인증 (단일 공용 비밀번호) ────────────────────────────────
const PASSWORD    = process.env.APP_PASSWORD || '0000';
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

const makeToken = () => { const exp = Date.now() + SESSION_MAX; return `${exp}.${sign(exp)}`; };
const validToken = token => {
  if (!token) return false;
  const [exp, mac] = String(token).split('.');
  if (!exp || !mac || !safeEq(mac, sign(exp))) return false;
  return Number(exp) > Date.now();
};
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
  const { pathname: rawPath } = url.parse(req.url);
  // 잘못된 퍼센트 인코딩(예: GET /%)이 프로세스를 죽이지 않도록
  let pathname;
  try { pathname = decodeURIComponent(rawPath); }
  catch { return json(res, 400, { ok:false, error:'잘못된 경로입니다.' }); }
  const method   = req.method.toUpperCase();

  if (method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }

  // ── 로그인 / 로그아웃 ────────────────────────────────────────
  if (pathname === '/api/login' && method === 'POST') {
    const body = await parseBody(req);
    if (!body || !safeEq(sign(body.password ?? ''), sign(PASSWORD))) {
      return json(res, 401, { error: '비밀번호가 올바르지 않습니다.' });
    }
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': `${COOKIE_NAME}=${makeToken()}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MAX / 1000}`,
    });
    return res.end(JSON.stringify({ ok: true }));
  }
  if (pathname === '/logout') {
    res.writeHead(302, {
      'Location': '/login.html',
      'Set-Cookie': `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`,
    });
    return res.end();
  }

  // ── 인증 게이트 ─────────────────────────────────────────────
  if (!PUBLIC_PATHS.has(pathname) && !validToken(readCookie(req, COOKIE_NAME))) {
    if (pathname.startsWith('/api/')) return json(res, 401, { error: '로그인이 필요합니다.' });
    res.writeHead(302, { 'Location': '/login.html' });
    return res.end();
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
    if (method === 'GET') return json(res, 200, db.prepare('SELECT s.*,oi.name as item_name FROM shipments s LEFT JOIN order_items oi ON s.item_id=oi.id WHERE s.order_id=? ORDER BY s.shipped_at').all(orderId));
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
      recordStatusChange(id, current.order_status, body.status, body.reason||'');
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
      recordStatusChange(id, current.order_status, 'cancelled', reason);
    })();
    return json(res, 200, { ok:true });
  }

  // ── /api/quotations/:id/history — 상태 변경 이력 + 출처 견적 ──
  // status_changes / quotation_sources 는 그동안 쓰기만 하고 읽는 경로가 없었다.
  const mQHist = pathname.match(/^\/api\/quotations\/(\d+)\/history$/);
  if (mQHist && method === 'GET') {
    const id = parseInt(mQHist[1]);
    return json(res, 200, {
      changes: db.prepare(`SELECT id,from_status,to_status,changed_at,reason
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
    db.transaction(() => {
      db.prepare('UPDATE quotations SET order_status=?,cancelled_at=?,cancelled_reason=? WHERE id=?')
        .run('draft', '', '', id);
      recordStatusChange(id, 'cancelled', 'draft', '취소 해제');
      autoStatus(id);   // 출고 이력이 있으면 실제 상태로 되돌린다
    })();
    return json(res, 200, { ok:true });
  }

  // ── PATCH /api/quotations/:id/memo ───────────────────────────
  const mQMemo = pathname.match(/^\/api\/quotations\/(\d+)\/memo$/);
  if (mQMemo && method === 'PATCH') {
    const id   = parseInt(mQMemo[1]);
    const body = await parseBody(req);
    if (!body) return json(res, 400, { ok:false });
    const sets = [], vals = [];
    if (body.memo_customer !== undefined) { sets.push('memo_customer=?'); vals.push(body.memo_customer); }
    if (body.memo_internal !== undefined) { sets.push('memo_internal=?'); vals.push(body.memo_internal); }
    if (!sets.length) return json(res, 400, { ok:false, error:'변경할 필드 없음' });
    db.prepare(`UPDATE quotations SET ${sets.join(',')} WHERE id=?`).run(...vals, id);
    return json(res, 200, { ok:true });
  }

  // ── POST /api/quotations/from-quotations ─────────────────────
  if (pathname === '/api/quotations/from-quotations' && method === 'POST') {
    const body = await parseBody(req);
    if (!body) return json(res, 400, { ok:false });
    const now = new Date();
    const mm = String(now.getMonth()+1).padStart(2,'0');
    const dd = String(now.getDate()).padStart(2,'0');
    const today = `${now.getFullYear()}-${mm}-${dd}`;
    const cnt = db.prepare('SELECT COUNT(*) as n FROM quotations WHERE date=?').get(today).n + 1;
    const no = body.no || `${String(now.getFullYear()).slice(2)}/${mm}/${dd}-${cnt}`;
    const cust = db.prepare('SELECT * FROM customers WHERE id=?').get(body.customer_id||'');
    const r = db.prepare('INSERT INTO quotations (no,date,customer_id,customer,order_status,total,total_paid,items,ref,status) VALUES (?,?,?,?,?,?,?,?,?,?)').run(
      no, body.date||today, body.customer_id||'', cust?.name||body.customer||'', 'draft', 0, 0, body.memo||'', '한남냉동테크(주)', '진행중'
    );
    const newId = r.lastInsertRowid;
    let sortOrder = 0;
    const insertItem = db.prepare('INSERT INTO order_items (order_id,name,spec,unit,qty,unit_price,shipped_qty,note,sort_order) VALUES (?,?,?,?,?,?,?,?,?)');
    if (body.items_from?.length) {
      db.transaction(() => {
        for (const src of body.items_from) {
          if (!src.selected_item_ids?.length) continue;
          const ph = src.selected_item_ids.map(()=>'?').join(',');
          const srcItems = db.prepare(`SELECT * FROM order_items WHERE order_id=? AND id IN (${ph}) ORDER BY sort_order`).all(src.quotation_id, ...src.selected_item_ids);
          for (const it of srcItems) insertItem.run(newId, it.name, it.spec||'', it.unit||'EA', it.qty||0, it.unit_price||0, 0, it.note||'', sortOrder++);
          db.prepare('INSERT INTO quotation_sources (order_id,source_quotation_id,source_item_ids) VALUES (?,?,?)').run(newId, src.quotation_id, JSON.stringify(src.selected_item_ids));
        }
      })();
    }
    if (body.additional_items?.length) {
      db.transaction(() => {
        for (const it of body.additional_items) insertItem.run(newId, it.name||'', it.spec||'', it.unit||'EA', it.qty||0, it.unit_price||0, 0, it.note||'', sortOrder++);
      })();
    }
    const total = db.prepare('SELECT COALESCE(SUM(qty*unit_price),0) as s FROM order_items WHERE order_id=?').get(newId).s;
    db.prepare('UPDATE quotations SET total=? WHERE id=?').run(total, newId);
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
      const cnt = db.prepare('SELECT COUNT(*) as n FROM shipment_batches WHERE batch_no LIKE ?').get(`SB${ds}%`).n + 1;
      const batch_no = `SB${ds}${String(cnt).padStart(3,'0')}`;
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
        const cnt = db.prepare('SELECT COUNT(*) as n FROM completion_batches WHERE batch_no LIKE ?').get(`CB${ds}%`).n + 1;
        batch_no = `CB${ds}${String(cnt).padStart(3,'0')}`;
        batchId = db.prepare('INSERT INTO completion_batches (batch_no,completed_at,note) VALUES (?,?,?)')
                    .run(batch_no, body.completed_at||today(), body.note||'').lastInsertRowid;
        for (const cur of targets) {
          db.prepare('UPDATE quotations SET order_status=?,completion_batch_id=? WHERE id=?').run('done', batchId, cur.id);
          recordStatusChange(cur.id, cur.order_status, 'done', `완료묶음 ${batch_no}`);
        }
      })();
      return json(res, 200, { ok:true, batch_id: batchId, batch_no });
    }
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
                                    ['done'], 'purchase_status');
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
      if (p.purchase_status === 'done') return json(res, 400, { ok:false, error:'완료된 구매 건의 품목은 수정할 수 없습니다.' });
      const err = saveLineItems(LINE_ITEM.purchase, purchaseId, body);
      if (err) return json(res, 400, { ok:false, error: err });
      return json(res, 200, { ok:true });
    }
  }

  // ── PATCH /api/purchases/:id/status ──────────────────────────
  const mPStat = pathname.match(/^\/api\/purchases\/(\d+)\/status$/);
  if (mPStat && method === 'PATCH') {
    const id   = parseInt(mPStat[1]);
    const body = await parseBody(req);
    const valid = ['draft','ordered','partial','received','done'];
    if (!body || !valid.includes(body.status)) return json(res, 400, { ok:false });
    db.prepare('UPDATE purchases SET purchase_status=? WHERE id=?').run(body.status, id);
    return json(res, 200, { ok:true });
  }

  // ── blob 리소스 ──────────────────────────────────────────────
  const mBase = pathname.match(/^\/api\/([a-z_]+)$/);
  if (mBase) {
    const resource = mBase[1];

    if (BLOB_KEYS.has(resource)) {
      if (method === 'GET') {
        const row = db.prepare('SELECT value FROM blobs WHERE key=?').get(resource);
        res.writeHead(200, {'Content-Type':'application/json; charset=utf-8', ...CORS});
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

    if (method === 'GET')  return json(res, 200, getAll(cfg));
    if (method === 'POST') {
      const item = await parseBody(req);
      if (!item) return json(res, 400, { ok:false, error:'본문 없음' });
      upsert(cfg, item);
      return json(res, 200, { ok:true });
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
    const id    = cfg.int && /^\d+$/.test(rawId) ? parseInt(rawId, 10) : rawId;

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
      const patch = Object.keys(body).length === 0 ? { starred: !item.starred } : body;
      updateOne(cfg, id, patch);
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
