'use strict';
/**
 * Zero-dependency backend: node:http + node:sqlite (Node 22+).
 * Run:  INGEST_TOKEN=<secret> node server.js
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { parse, CATEGORIES } = require('./parser');
const insights = require('./insights');

const PORT = process.env.PORT || 8080;
const TOKEN = process.env.INGEST_TOKEN || 'dev-token-change-me';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.db');
const PUBLIC = path.join(__dirname, 'public');

// --- storage ---------------------------------------------------------------
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS tx (
    id           TEXT PRIMARY KEY,
    bank         TEXT NOT NULL,
    direction    TEXT NOT NULL CHECK (direction IN ('credit','debit')),
    amount       REAL NOT NULL,
    balance      REAL,
    counterparty TEXT,
    account      TEXT,
    ref          TEXT,
    occurred_at  TEXT NOT NULL,
    category     TEXT NOT NULL,
    note         TEXT,
    raw          TEXT NOT NULL,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS unparsed (
    id          TEXT PRIMARY KEY,
    sender      TEXT,
    body        TEXT NOT NULL,
    reason      TEXT,
    received_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS tx_occurred ON tx(occurred_at DESC);
`);

// Dedupe key: the bank's own reference when present, else the message content.
const fingerprint = (tx) =>
  crypto.createHash('sha1')
    .update(tx.ref ? `${tx.bank}:${tx.ref}` : `${tx.bank}:${tx.raw}`)
    .digest('hex').slice(0, 20);

const insertTx = db.prepare(`
  INSERT OR IGNORE INTO tx
    (id,bank,direction,amount,balance,counterparty,account,ref,occurred_at,category,raw)
  VALUES (?,?,?,?,?,?,?,?,?,?,?)
`);
const insertUnparsed = db.prepare(
  `INSERT OR IGNORE INTO unparsed (id,sender,body,reason,received_at) VALUES (?,?,?,?,?)`
);

function ingestOne({ sender, body, received_at }, opts = {}) {
  const r = parse({ sender, body, received_at, ...opts });
  if (!r.ok) {
    const id = crypto.createHash('sha1').update(String(body)).digest('hex').slice(0, 20);
    insertUnparsed.run(id, sender || null, body, r.reason, received_at || new Date().toISOString());
    return { stored: false, reason: r.reason };
  }
  const t = r.tx;
  const id = fingerprint(t);
  const res = insertTx.run(
    id, t.bank, t.direction, t.amount, t.balance, t.counterparty,
    t.account, t.ref, t.occurred_at, t.category, t.raw
  );
  return { stored: res.changes > 0, duplicate: res.changes === 0, id, tx: t };
}

// --- helpers ---------------------------------------------------------------
const json = (res, code, obj) => {
  const b = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(b) });
  res.end(b);
};

function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) { reject(new Error('payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (e) { reject(new Error('invalid json')); }
    });
    req.on('error', reject);
  });
}

function authed(req) {
  const h = req.headers.authorization || '';
  const given = h.startsWith('Bearer ') ? h.slice(7) : '';
  const a = Buffer.from(given), b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// --- period handling -------------------------------------------------------
// ?period=day|month|year|all&date=YYYY-MM-DD (date is an anchor inside the period)
const PERIOD = {
  day:   { len: 10, bucket: 13 },  // bucket by hour
  month: { len: 7,  bucket: 10 },  // bucket by day
  year:  { len: 4,  bucket: 7  },  // bucket by month
  all:   { len: 0,  bucket: 4  },  // bucket by year
};

function resolvePeriod(url) {
  const period = PERIOD[url.searchParams.get('period')] ? url.searchParams.get('period') : 'month';
  const today = new Date().toISOString().slice(0, 10);
  const anchor = (url.searchParams.get('date') || url.searchParams.get('month') || today).slice(0, 10);
  const { len, bucket } = PERIOD[period];
  const prefix = len ? anchor.slice(0, len) : '';
  const label = period === 'all' ? 'All time' : prefix;
  return { period, anchor, prefix, bucket, label };
}

/** The matching prefix one period earlier, for trend comparison. */
function prevPrefix(period, prefix) {
  if (period === 'all' || !prefix) return null;
  if (period === 'year') return String(+prefix - 1);
  if (period === 'month') {
    const [y, m] = prefix.split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 2, 1));
    return d.toISOString().slice(0, 7);
  }
  const d = new Date(prefix + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** How far into the period we are — used for "on pace for" only. */
function periodProgress(period, prefix) {
  const now = new Date();
  if (period === 'month') {
    const [y, m] = prefix.split('-').map(Number);
    const total = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const current = now.toISOString().slice(0, 7) === prefix;
    return { elapsed: current ? now.getUTCDate() : total, total };
  }
  if (period === 'year') {
    const current = now.toISOString().slice(0, 4) === prefix;
    const total = 365;
    return { elapsed: current ? Math.ceil((now - new Date(Date.UTC(+prefix, 0, 1))) / 864e5) : total, total };
  }
  return { elapsed: 0, total: 0 };
}

/** Distinct days / months / years that actually have transactions. */
function periodOptions() {
  const q = (n) => db.prepare(
    `SELECT DISTINCT substr(occurred_at,1,${n}) AS k FROM tx ORDER BY k DESC`
  ).all().map((r) => r.k);
  return { day: q(10), month: q(7), year: q(4) };
}

function coverage() {
  const r = db.prepare(`SELECT MIN(occurred_at) AS first, MAX(occurred_at) AS last, COUNT(*) AS n FROM tx`).get();
  return r.n ? r : null;
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };

function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC)) return json(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, buf) => {
    if (err) return json(res, 404, { error: 'not found' });
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': rel === 'sw.js' ? 'no-cache' : 'public, max-age=300',
    });
    res.end(buf);
  });
}

// --- routes ----------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  try {
    // Ingest from the Android forwarder. Accepts one message or a batch.
    if (req.method === 'POST' && p === '/api/ingest') {
      if (!authed(req)) return json(res, 401, { error: 'unauthorized' });
      const payload = await readBody(req);
      const list = Array.isArray(payload.messages) ? payload.messages : [payload];
      const results = list.map(ingestOne);
      return json(res, 200, {
        received: list.length,
        stored: results.filter((r) => r.stored).length,
        duplicates: results.filter((r) => r.duplicate).length,
        skipped: results.filter((r) => !r.stored && !r.duplicate).length,
      });
    }

    // Transactions, newest first, filtered by period.
    if (req.method === 'GET' && p === '/api/tx') {
      const { prefix } = resolvePeriod(url);
      const limit = Math.min(2000, +url.searchParams.get('limit') || 500);
      const rows = prefix
        ? db.prepare(`SELECT * FROM tx WHERE occurred_at LIKE ? ORDER BY occurred_at DESC LIMIT ?`).all(`${prefix}%`, limit)
        : db.prepare(`SELECT * FROM tx ORDER BY occurred_at DESC LIMIT ?`).all(limit);
      return json(res, 200, { tx: rows });
    }

    // Totals for the dashboard, for any day / month / year / all time.
    if (req.method === 'GET' && p === '/api/summary') {
      const { period, anchor, prefix, bucket, label } = resolvePeriod(url);
      const like = `${prefix}%`;

      const tot = db.prepare(`
        SELECT direction, SUM(amount) AS total, COUNT(*) AS n
        FROM tx WHERE occurred_at LIKE ? GROUP BY direction
      `).all(like);
      const byCat = db.prepare(`
        SELECT category, SUM(amount) AS total, COUNT(*) AS n
        FROM tx WHERE direction='debit' AND occurred_at LIKE ?
        GROUP BY category ORDER BY total DESC
      `).all(like);
      const series = db.prepare(`
        SELECT substr(occurred_at,1,${bucket}) AS k,
               SUM(CASE WHEN direction='debit'  THEN amount ELSE 0 END) AS out,
               SUM(CASE WHEN direction='credit' THEN amount ELSE 0 END) AS inn
        FROM tx WHERE occurred_at LIKE ? GROUP BY k ORDER BY k
      `).all(like);
      const balances = db.prepare(`
        SELECT bank, balance, occurred_at FROM tx t
        WHERE balance IS NOT NULL
          AND occurred_at = (SELECT MAX(occurred_at) FROM tx x WHERE x.bank=t.bank AND x.balance IS NOT NULL)
        GROUP BY bank
      `).all();

      const income  = tot.find((r) => r.direction === 'credit')?.total || 0;
      const expense = tot.find((r) => r.direction === 'debit')?.total || 0;

      return json(res, 200, {
        period, anchor, label, income, expense, net: income - expense,
        count: tot.reduce((a, r) => a + r.n, 0),
        byCategory: byCat, series, balances,
        options: periodOptions(),
        range: coverage(),
        unparsed: db.prepare(`SELECT COUNT(*) AS n FROM unparsed`).get().n,
      });
    }

    // Savings read-out, computed from the same period's transactions.
    if (req.method === 'GET' && p === '/api/insights') {
      const { period, prefix, label } = resolvePeriod(url);
      const rows = db.prepare(`SELECT * FROM tx WHERE occurred_at LIKE ?`).all(`${prefix}%`);
      const sum = (d) => rows.filter((r) => r.direction === d).reduce((a, r) => a + r.amount, 0);

      const prev = prevPrefix(period, prefix);
      const prevRows = prev ? db.prepare(`SELECT direction, amount FROM tx WHERE occurred_at LIKE ?`).all(`${prev}%`) : [];
      const psum = (d) => prevRows.filter((r) => r.direction === d).reduce((a, r) => a + r.amount, 0);

      const byCat = db.prepare(`
        SELECT category, SUM(amount) AS total, COUNT(*) AS n
        FROM tx WHERE direction='debit' AND occurred_at LIKE ?
        GROUP BY category ORDER BY total DESC
      `).all(`${prefix}%`);

      const fees = byCat.filter((c) => c.category === 'Fees').reduce((a, c) => a + c.total, 0);
      const months = new Set(rows.map((r) => r.occurred_at.slice(0, 7))).size || 1;
      const { elapsed, total } = periodProgress(period, prefix);

      return json(res, 200, {
        period, label,
        suggestions: insights.build({
          period,
          income: sum('credit'), expense: sum('debit'),
          byCategory: byCat.filter((c) => c.category !== 'Transfer out'),
          recurring: insights.findRecurring(rows),
          fees, monthsCovered: months,
          prevIncome: psum('credit'), prevExpense: psum('debit'),
          daysElapsed: elapsed, daysInPeriod: total,
        }),
      });
    }

    // Re-label a transaction.
    if (req.method === 'PATCH' && p.startsWith('/api/tx/')) {
      const id = decodeURIComponent(p.slice('/api/tx/'.length));
      const { category, note } = await readBody(req);
      const r = db.prepare(
        `UPDATE tx SET category = COALESCE(?, category), note = COALESCE(?, note) WHERE id = ?`
      ).run(category ?? null, note ?? null, id);
      return json(res, r.changes ? 200 : 404, { updated: r.changes });
    }

    // Paste-in box: parse without the phone, same pipeline.
    if (req.method === 'POST' && p === '/api/paste') {
      const { text = '', sender = '' } = await readBody(req);
      const lines = text.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
      const results = lines.map((body) => ingestOne({ sender, body }, { allowUnknownBank: true }));
      return json(res, 200, {
        stored: results.filter((r) => r.stored).length,
        skipped: results.filter((r) => !r.stored).map((r) => r.reason).filter(Boolean),
      });
    }

    // Digital Asset Links — proves this site and the APK belong together, which
    // is what lets the TWA run without a URL bar. Set TWA_FINGERPRINT to the
    // signing certificate's SHA-256 (colon-separated hex) from the build output.
    if (req.method === 'GET' && p === '/.well-known/assetlinks.json') {
      const fp = process.env.TWA_FINGERPRINT;
      if (!fp) return json(res, 404, { error: 'TWA_FINGERPRINT not set' });
      return json(res, 200, [{
        relation: ['delegate_permission/common.handle_all_urls'],
        target: {
          namespace: 'android_app',
          package_name: process.env.TWA_PACKAGE || 'et.birukfin.forwarder',
          sha256_cert_fingerprints: fp.split(',').map((s) => s.trim()).filter(Boolean),
        },
      }]);
    }

    if (req.method === 'GET' && p === '/api/meta') {
      return json(res, 200, { categories: CATEGORIES.map(([n]) => n).concat('Uncategorised') });
    }

    if (req.method === 'GET') return serveStatic(req, res, p);
    return json(res, 405, { error: 'method not allowed' });
  } catch (e) {
    return json(res, 400, { error: e.message });
  }
});

server.listen(PORT, () => console.log(`sms-finance listening on :${PORT}`));
