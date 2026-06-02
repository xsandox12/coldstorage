// ColdStorage Master — SQLite 백엔드
// node server.js  |  http://localhost:9000

const http     = require('http');
const fs       = require('fs');
const path     = require('path');
const url      = require('url');
const Database = require('better-sqlite3');

const PORT     = 9000;
const ROOT     = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
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
`);

// ─── 마이그레이션 ────────────────────────────────────────────
// 기존 테이블 컬럼 추가 (없을 때만)
for (const sql of [
  `ALTER TABLE quotations ADD COLUMN customer_id TEXT DEFAULT ''`,
  `ALTER TABLE quotations ADD COLUMN drawing_id TEXT DEFAULT ''`,
  `ALTER TABLE quotations ADD COLUMN order_status TEXT DEFAULT 'draft'`,
  `ALTER TABLE quotations ADD COLUMN total_paid INTEGER DEFAULT 0`,
  `ALTER TABLE quotations ADD COLUMN items_json TEXT DEFAULT '[]'`,
  `ALTER TABLE as_records ADD COLUMN urgency TEXT DEFAULT 'NORMAL'`,
  `ALTER TABLE as_records ADD COLUMN assignee TEXT DEFAULT ''`,
]) { try { db.exec(sql) } catch {} }

// JSON → SQLite 최초 마이그레이션
(function migrate() {
  const dir = path.join(ROOT, 'db');
  if (!fs.existsSync(dir)) return;
  const load = f => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return null; } };
  const empty = tbl => db.prepare(`SELECT COUNT(*) as n FROM ${tbl}`).get().n === 0;

  if (empty('customers')) {
    const ins = db.prepare('INSERT OR IGNORE INTO customers VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
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
  products:    { table: 'products',    int: true  },
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
function getAll(cfg) {
  return db.prepare(`SELECT * FROM ${cfg.table}`).all().map(r => rowOut(cfg.table, r));
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
function replaceAll(cfg, rows) {
  db.transaction(() => { db.prepare(`DELETE FROM ${cfg.table}`).run(); rows.forEach(r => upsert(cfg, r)); })();
}

// ─── 전문 쿼리 ───────────────────────────────────────────────
function recalcPaid(orderId) {
  const row = db.prepare('SELECT COALESCE(SUM(amount),0) as s FROM payments WHERE order_id=?').get(orderId);
  db.prepare('UPDATE quotations SET total_paid=? WHERE id=?').run(row.s, orderId);
}

function autoStatus(orderId) {
  const order = db.prepare('SELECT * FROM quotations WHERE id=?').get(orderId);
  if (!order || order.order_status === 'done') return;
  const items = db.prepare('SELECT * FROM order_items WHERE order_id=?').all(orderId);
  if (!items.length) return;
  const allShipped = items.every(i => i.shipped_qty >= i.qty);
  const anyShipped = items.some(i => i.shipped_qty > 0);
  if (allShipped) db.prepare('UPDATE quotations SET order_status=? WHERE id=?').run('shipped', orderId);
  else if (anyShipped) db.prepare('UPDATE quotations SET order_status=? WHERE id=?').run('partial', orderId);
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
const parseBody = req => new Promise((resolve, reject) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => { try { resolve(JSON.parse(body || 'null')); } catch { resolve(null); } });
  req.on('error', reject);
});
const serveStatic = (req, res, pathname) => {
  if (pathname === '/') pathname = '/index.html';
  const fp = path.join(ROOT, pathname);
  if (!fp.startsWith(ROOT)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404, {'Content-Type':'text/plain'}); res.end(`Not Found: ${pathname}`); return; }
    const mime = MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {'Content-Type': mime});
    res.end(data);
  });
};

// ─── HTTP 서버 ──────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const { pathname: rawPath } = url.parse(req.url);
  const pathname = decodeURIComponent(rawPath);
  const method   = req.method.toUpperCase();

  if (method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }

  // ── /api/dashboard ──────────────────────────────────────────
  if (pathname === '/api/dashboard' && method === 'GET') {
    const now = new Date();
    const ym  = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
    const kpi = {
      thisMonthDraft:   db.prepare(`SELECT COUNT(*) as n FROM quotations WHERE order_status='draft' AND date LIKE ?`).get(`${ym}%`).n,
      inProgress:       db.prepare(`SELECT COUNT(*) as n FROM quotations WHERE order_status IN ('ordered','partial')`).get().n,
      totalUnpaid:      db.prepare(`SELECT COALESCE(SUM(total - total_paid),0) as s FROM quotations WHERE order_status NOT IN ('done') AND total > total_paid`).get().s,
      openAS:           db.prepare(`SELECT COUNT(*) as n FROM as_records WHERE status='OPEN'`).get().n,
    };
    const workqueue = [
      ...db.prepare(`SELECT id,no,customer,total,total_paid,date,'미수금' as tag FROM quotations WHERE total > total_paid AND order_status NOT IN ('draft','done') ORDER BY date LIMIT 10`).all(),
      ...db.prepare(`SELECT id,cust_name as customer,issue,date,urgency,'AS' as tag FROM as_records WHERE status='OPEN' ORDER BY date LIMIT 5`).all(),
      ...db.prepare(`SELECT id,no,customer,date,'부분출고' as tag FROM quotations WHERE order_status='partial' ORDER BY date LIMIT 5`).all(),
    ];
    const recent = db.prepare(`SELECT q.*,c.name as cust_name FROM quotations q LEFT JOIN customers c ON q.customer_id=c.id ORDER BY q.id DESC LIMIT 10`).all();
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
      if (!body || !body.order_id || !body.amount) return json(res, 400, { ok:false, error:'order_id, amount 필수' });
      const stmt = db.prepare('INSERT INTO payments (order_id,amount,paid_at,note) VALUES (?,?,?,?)');
      const r = stmt.run(body.order_id, body.amount, body.paid_at||'', body.note||'');
      recalcPaid(body.order_id);
      return json(res, 200, { ok:true, id: r.lastInsertRowid });
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
    if (!body || !body.order_id || !body.item_id || !body.qty) return json(res, 400, { ok:false, error:'order_id, item_id, qty 필수' });
    db.prepare('INSERT INTO shipments (order_id,item_id,qty,shipped_at,note) VALUES (?,?,?,?,?)').run(body.order_id, body.item_id, body.qty, body.shipped_at||'', body.note||'');
    db.prepare('UPDATE order_items SET shipped_qty = shipped_qty + ? WHERE id=?').run(body.qty, body.item_id);
    autoStatus(body.order_id);
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
      if (!Array.isArray(body)) return json(res, 400, { ok:false });
      db.transaction(() => {
        db.prepare('DELETE FROM order_items WHERE order_id=?').run(orderId);
        body.forEach((item, i) => {
          db.prepare('INSERT INTO order_items (order_id,name,spec,unit,qty,unit_price,shipped_qty,note,sort_order) VALUES (?,?,?,?,?,?,?,?,?)').run(
            orderId, item.name||'', item.spec||'', item.unit||'EA', item.qty||0, item.unit_price||0, item.shipped_qty||0, item.note||'', i);
        });
      })();
      // 총액 재계산
      const total = db.prepare('SELECT COALESCE(SUM(qty*unit_price),0) as s FROM order_items WHERE order_id=?').get(orderId).s;
      db.prepare('UPDATE quotations SET total=? WHERE id=?').run(total, orderId);
      return json(res, 200, { ok:true });
    }
  }

  // ── PATCH /api/quotations/:id/status ─────────────────────────
  const mQStatus = pathname.match(/^\/api\/quotations\/(\d+)\/status$/);
  if (mQStatus && method === 'PATCH') {
    const id   = parseInt(mQStatus[1]);
    const body = await parseBody(req);
    const valid = ['draft','ordered','partial','shipped','done'];
    if (!body || !valid.includes(body.status)) return json(res, 400, { ok:false, error:'유효하지 않은 상태' });
    db.prepare('UPDATE quotations SET order_status=? WHERE id=?').run(body.status, id);
    return json(res, 200, { ok:true });
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
    if (method === 'PUT') {
      const data = await parseBody(req);
      if (data === null) return json(res, 400, { ok:false, error:'본문 없음' });
      replaceAll(cfg, data);
      return json(res, 200, { ok:true });
    }
    return json(res, 405, { ok:false });
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
});

server.listen(PORT, () => {
  console.log(`\n  ❄️  ColdStorage Master (SQLite)\n  🌐  http://localhost:${PORT}\n`);
});
