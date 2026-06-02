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
    ref TEXT DEFAULT '', date TEXT DEFAULT '', status TEXT DEFAULT '진행중'
  );
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    customer_id TEXT DEFAULT '', project_name TEXT DEFAULT '',
    status TEXT DEFAULT 'PLANNING', specs TEXT DEFAULT '{}',
    amount INTEGER DEFAULT 0, start_date TEXT DEFAULT '', end_date TEXT
  );
  CREATE TABLE IF NOT EXISTS as_records (
    id TEXT PRIMARY KEY,
    proj_id TEXT DEFAULT '', cust_id TEXT DEFAULT '',
    cust_name TEXT DEFAULT '', phone TEXT DEFAULT '',
    type TEXT DEFAULT 'NORMAL', issue TEXT DEFAULT '',
    desc TEXT DEFAULT '', status TEXT DEFAULT 'OPEN', date TEXT DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS contracts (
    id TEXT PRIMARY KEY,
    proj_id TEXT DEFAULT '', cust_id TEXT DEFAULT '',
    total_price INTEGER DEFAULT 0, down_payment INTEGER DEFAULT 0,
    middle_payment INTEGER DEFAULT 0, balance INTEGER DEFAULT 0,
    billing_status TEXT DEFAULT 'PENDING', note TEXT DEFAULT ''
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
`);

// ─── JSON → SQLite 마이그레이션 (최초 1회) ──────────────────
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
    const ins = db.prepare('INSERT OR IGNORE INTO quotations VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
    db.transaction(() => (load('quotations.json') || []).forEach(q =>
      ins.run(q.id, q.no||'', q.customer||'', q.items||'', q.total||0, q.payment||'',
        q.drawing?1:0, q.accounting?1:0, q.printed?1:0, q.ref||'', q.date||'', q.status||'완료')
    ))();
  }

  if (empty('projects')) {
    const ins = db.prepare('INSERT OR IGNORE INTO projects VALUES (?,?,?,?,?,?,?,?)');
    db.transaction(() => (load('projects.json') || []).forEach(p =>
      ins.run(p.id, p.customer_id||'', p.project_name||'', p.status||'PLANNING',
        JSON.stringify(p.specs||{}), p.amount||0, p.start_date||'', p.end_date||null)
    ))();
  }

  if (empty('as_records')) {
    const ins = db.prepare('INSERT OR IGNORE INTO as_records VALUES (?,?,?,?,?,?,?,?,?,?)');
    db.transaction(() => (load('as_records.json') || []).forEach(a =>
      ins.run(String(a.id), a.proj_id||'', a.cust_id||'', a.cust_name||'', a.phone||'',
        a.type||'NORMAL', a.issue||'', a.desc||'', a.status||'OPEN', a.date||'')
    ))();
  }

  if (empty('contracts')) {
    const ins = db.prepare('INSERT OR IGNORE INTO contracts VALUES (?,?,?,?,?,?,?,?,?)');
    db.transaction(() => (load('contracts.json') || []).forEach(c =>
      ins.run(c.id, c.proj_id||'', c.cust_id||'', c.total_price||0, c.down_payment||0,
        c.middle_payment||0, c.balance||0, c.billing_status||'PENDING', c.note||'')
    ))();
  }

  for (const [key, file] of [['inventory','inventory.json'],['templates','templates.json'],['settings','user_settings.json']]) {
    if (!db.prepare('SELECT 1 FROM blobs WHERE key=?').get(key)) {
      try {
        const raw = fs.readFileSync(path.join(dir, file), 'utf8');
        db.prepare('INSERT OR IGNORE INTO blobs(key,value) VALUES(?,?)').run(key, raw);
      } catch {}
    }
  }
})();

// ─── 리소스 설정 ─────────────────────────────────────────────
const BLOB_KEYS = new Set(['inventory', 'templates', 'settings']);

const TABLES = {
  customers:  { table: 'customers',  int: false },
  quotations: { table: 'quotations', int: true  },
  projects:   { table: 'projects',   int: false },
  as_records: { table: 'as_records', int: false },
  contracts:  { table: 'contracts',  int: false },
  drawings:   { table: 'drawings',   int: false },
};

// ─── 직렬화 / 역직렬화 ──────────────────────────────────────
function rowOut(table, row) {
  if (!row) return null;
  if (table === 'quotations') return { ...row, drawing: !!row.drawing, accounting: !!row.accounting, printed: !!row.printed };
  if (table === 'projects')   return { ...row, specs: JSON.parse(row.specs || '{}') };
  if (table === 'drawings') {
    const { id, starred, data } = row;
    return { id, starred: !!starred, ...JSON.parse(data || '{}') };
  }
  return row;
}

function rowIn(table, item) {
  if (table === 'quotations') return { ...item, drawing: item.drawing?1:0, accounting: item.accounting?1:0, printed: item.printed?1:0 };
  if (table === 'projects')   return { ...item, specs: typeof item.specs === 'object' ? JSON.stringify(item.specs) : (item.specs || '{}') };
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
  return db.prepare(`UPDATE ${cfg.table} SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`).run(...vals, id).changes > 0;
}

function deleteOne(cfg, id) {
  db.prepare(`DELETE FROM ${cfg.table} WHERE id = ?`).run(id);
}

function replaceAll(cfg, rows) {
  db.transaction(() => {
    db.prepare(`DELETE FROM ${cfg.table}`).run();
    rows.forEach(r => upsert(cfg, r));
  })();
}

// ─── MIME / CORS / 유틸 ──────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.svg':  'image/svg+xml', '.ico': 'image/x-icon',
};
const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const json = (res, status, data) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...CORS });
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
  const filePath = path.join(ROOT, pathname);
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end(`Not Found: ${pathname}`); return; }
    const mime = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
};

// ─── HTTP 서버 ──────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const { pathname: rawPath } = url.parse(req.url);
  const pathname = decodeURIComponent(rawPath);
  const method   = req.method.toUpperCase();

  if (method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }

  // /api/:resource
  const mBase = pathname.match(/^\/api\/([a-z_]+)$/);
  if (mBase) {
    const resource = mBase[1];

    if (BLOB_KEYS.has(resource)) {
      if (method === 'GET') {
        const row = db.prepare('SELECT value FROM blobs WHERE key = ?').get(resource);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', ...CORS });
        res.end(row ? row.value : (resource === 'inventory' ? '[]' : '{}'));
        return;
      }
      if (method === 'PUT') {
        const body = await parseBody(req);
        if (body === null) return json(res, 400, { ok: false, error: '본문 없음' });
        db.prepare('INSERT INTO blobs(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
          .run(resource, JSON.stringify(body));
        return json(res, 200, { ok: true });
      }
      return json(res, 405, { ok: false, error: '허용되지 않는 메서드' });
    }

    const cfg = TABLES[resource];
    if (!cfg) return json(res, 404, { ok: false, error: '알 수 없는 리소스' });

    if (method === 'GET')  return json(res, 200, getAll(cfg));

    if (method === 'POST') {
      const item = await parseBody(req);
      if (!item) return json(res, 400, { ok: false, error: '본문 없음' });
      upsert(cfg, item);
      return json(res, 200, { ok: true });
    }

    if (method === 'PUT') {
      const data = await parseBody(req);
      if (data === null) return json(res, 400, { ok: false, error: '본문 없음' });
      replaceAll(cfg, data);
      return json(res, 200, { ok: true });
    }

    return json(res, 405, { ok: false, error: '허용되지 않는 메서드' });
  }

  // /api/:resource/:id
  const mItem = pathname.match(/^\/api\/([a-z_]+)\/(.+)$/);
  if (mItem) {
    const resource = mItem[1];
    const cfg = TABLES[resource];
    if (!cfg) return json(res, 404, { ok: false, error: '알 수 없는 리소스' });

    const rawId = mItem[2];
    const id    = cfg.int && /^\d+$/.test(rawId) ? parseInt(rawId, 10) : rawId;

    if (method === 'GET') {
      const item = getOne(cfg, id);
      if (!item) return json(res, 404, { ok: false, error: '항목 없음' });
      return json(res, 200, item);
    }

    if (method === 'PUT') {
      const body = await parseBody(req);
      if (!body) return json(res, 400, { ok: false, error: '본문 없음' });
      if (!updateOne(cfg, id, body)) return json(res, 404, { ok: false, error: '항목 없음' });
      return json(res, 200, { ok: true });
    }

    if (method === 'PATCH') {
      const body = await parseBody(req) || {};
      const item = getOne(cfg, id);
      if (!item) return json(res, 404, { ok: false, error: '항목 없음' });
      const patch = Object.keys(body).length === 0 ? { starred: !item.starred } : body;
      updateOne(cfg, id, patch);
      return json(res, 200, { ok: true, ...getOne(cfg, id) });
    }

    if (method === 'DELETE') {
      deleteOne(cfg, id);
      return json(res, 200, { ok: true });
    }

    return json(res, 405, { ok: false, error: '허용되지 않는 메서드' });
  }

  serveStatic(req, res, pathname);
});

server.listen(PORT, () => {
  console.log(`\n  ❄️  ColdStorage Master 서버 시작 (SQLite)\n  🌐  http://localhost:${PORT}\n`);
});
