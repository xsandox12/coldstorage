// ============================================================
// ColdStorage Master — 로컬 개발 서버
// 실행: node server.js  (또는 npm start)
// 접속: http://localhost:9000
// ============================================================

const http = require('http');
const fs   = require('fs');
const path = require('path');
const url  = require('url');

const PORT = 9000;
const ROOT = __dirname;
const DB   = path.join(ROOT, 'db');

// ─── 허용된 리소스 목록 ─────────────────────────────────────
const RESOURCES = {
    drawings   : { type: 'array',  idField: 'id' },
    customers  : { type: 'array',  idField: 'id' },
    inventory  : { type: 'array',  idField: null  },  // 카테고리 배열, 통째로 교체
    projects   : { type: 'array',  idField: 'id' },
    as_records : { type: 'array',  idField: 'id' },
    contracts  : { type: 'array',  idField: 'id' },
    quotations : { type: 'array',  idField: 'id' },
    templates  : { type: 'object', idField: null  },  // 단일 객체
    settings   : { type: 'object', idField: null  },  // 단일 객체
};

// ─── MIME 타입 ─────────────────────────────────────────────
const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js'  : 'application/javascript; charset=utf-8',
    '.css' : 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png' : 'image/png',
    '.jpg' : 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg' : 'image/svg+xml',
    '.ico' : 'image/x-icon',
};

// ─── DB 파일 I/O ────────────────────────────────────────────
const FILE_ALIASES = { settings: 'user_settings' };
function dbFile(resource) {
    const alias = FILE_ALIASES[resource] || resource;
    return path.join(DB, `${alias}.json`);
}

function readDB(resource) {
    const meta = RESOURCES[resource];
    const empty = meta.type === 'object' ? {} : [];
    try {
        const raw = fs.readFileSync(dbFile(resource), 'utf8');
        return JSON.parse(raw || JSON.stringify(empty));
    } catch {
        return empty;
    }
}

function writeDB(resource, data) {
    fs.writeFileSync(dbFile(resource), JSON.stringify(data, null, 2), 'utf8');
}

// ─── 요청 본문 파싱 ─────────────────────────────────────────
function parseBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            try { resolve(JSON.parse(body || 'null')); }
            catch { resolve(null); }
        });
        req.on('error', reject);
    });
}

// ─── JSON 응답 헬퍼 ─────────────────────────────────────────
const CORS = {
    'Access-Control-Allow-Origin' : '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
};

function json(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...CORS });
    res.end(JSON.stringify(data));
}

// ─── 정적 파일 서빙 ─────────────────────────────────────────
function serveStatic(req, res, pathname) {
    if (pathname === '/') pathname = '/index.html';
    const filePath = path.join(ROOT, pathname);
    if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end('Forbidden'); return; }

    fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end(`Not Found: ${pathname}`); return; }
        const mime = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': mime });
        res.end(data);
    });
}

// ─── HTTP 서버 ──────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
    const parsed   = url.parse(req.url, true);
    const pathname = decodeURIComponent(parsed.pathname);
    const method   = req.method.toUpperCase();

    // CORS preflight
    if (method === 'OPTIONS') {
        res.writeHead(204, CORS); res.end(); return;
    }

    // ── /api/:resource ─────────────────────────────────────
    const mBase = pathname.match(/^\/api\/([a-z_]+)$/);
    if (mBase) {
        const resource = mBase[1];
        if (!RESOURCES[resource]) return json(res, 404, { ok: false, error: '알 수 없는 리소스' });
        const meta = RESOURCES[resource];

        // GET → 전체 조회
        if (method === 'GET') {
            return json(res, 200, readDB(resource));
        }

        // POST → 항목 추가 또는 전체 교체 (배열 리소스)
        if (method === 'POST' && meta.type === 'array') {
            const item = await parseBody(req);
            if (!item) return json(res, 400, { ok: false, error: '요청 본문이 없습니다.' });
            const list = readDB(resource);
            if (meta.idField) {
                const idx = list.findIndex(d => d[meta.idField] === item[meta.idField]);
                if (idx >= 0) list[idx] = item; else list.push(item);
            } else {
                list.push(item);
            }
            writeDB(resource, list);
            return json(res, 200, { ok: true });
        }

        // PUT → 전체 교체 (배열/객체 모두)
        if (method === 'PUT') {
            const data = await parseBody(req);
            if (data === null) return json(res, 400, { ok: false, error: '요청 본문이 없습니다.' });
            writeDB(resource, data);
            return json(res, 200, { ok: true });
        }
    }

    // ── /api/:resource/:id ─────────────────────────────────
    const mItem = pathname.match(/^\/api\/([a-z_]+)\/(.+)$/);
    if (mItem) {
        const resource = mItem[1];
        const rawId    = mItem[2];
        if (!RESOURCES[resource]) return json(res, 404, { ok: false, error: '알 수 없는 리소스' });
        const meta = RESOURCES[resource];
        if (meta.type !== 'array' || !meta.idField) return json(res, 400, { ok: false, error: '이 리소스는 ID 접근을 지원하지 않습니다.' });

        // id 타입 자동 감지 (숫자면 숫자로)
        const id = /^\d+$/.test(rawId) ? parseInt(rawId, 10) : rawId;

        // GET → 단일 조회
        if (method === 'GET') {
            const item = readDB(resource).find(d => d[meta.idField] === id);
            if (!item) return json(res, 404, { ok: false, error: '항목을 찾을 수 없습니다.' });
            return json(res, 200, item);
        }

        // PUT → 단일 수정
        if (method === 'PUT') {
            const body = await parseBody(req);
            if (!body) return json(res, 400, { ok: false, error: '요청 본문이 없습니다.' });
            const list = readDB(resource);
            const idx  = list.findIndex(d => d[meta.idField] === id);
            if (idx < 0) return json(res, 404, { ok: false, error: '항목을 찾을 수 없습니다.' });
            list[idx] = { ...list[idx], ...body };
            writeDB(resource, list);
            return json(res, 200, { ok: true });
        }

        // DELETE → 삭제
        if (method === 'DELETE') {
            const list = readDB(resource).filter(d => d[meta.idField] !== id);
            writeDB(resource, list);
            return json(res, 200, { ok: true });
        }

        // PATCH → 부분 수정 (drawings의 별표 토글 등)
        if (method === 'PATCH') {
            const body = await parseBody(req) || {};
            const list = readDB(resource);
            const idx  = list.findIndex(d => d[meta.idField] === id);
            if (idx < 0) return json(res, 404, { ok: false, error: '항목을 찾을 수 없습니다.' });
            // body가 비어있으면 starred 토글 (drawings 호환)
            if (Object.keys(body).length === 0) {
                list[idx].starred = !list[idx].starred;
            } else {
                list[idx] = { ...list[idx], ...body };
            }
            writeDB(resource, list);
            return json(res, 200, { ok: true, ...list[idx] });
        }
    }

    // ── 정적 파일 ─────────────────────────────────────────
    serveStatic(req, res, pathname);
});

server.listen(PORT, () => {
    console.log('');
    console.log('  ❄️  ColdStorage Master 서버 시작');
    console.log(`  🌐  http://localhost:${PORT}`);
    console.log('');
    console.log('  📂  API 엔드포인트:');
    Object.keys(RESOURCES).forEach(r => {
        console.log(`       GET/POST /api/${r}`);
    });
    console.log('');
    console.log('  🛑  종료: Ctrl + C');
    console.log('');
});
