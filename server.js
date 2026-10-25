'use strict';
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool, types } = require('pg');

types.setTypeParser(1082, (v) => v);              // DATE -> 'YYYY-MM-DD'
types.setTypeParser(1700, (v) => parseFloat(v));  // NUMERIC -> number
types.setTypeParser(20, (v) => parseInt(v, 10));  // BIGINT -> number

/* ------------------------------------------------------------------ config */
const REGIONS = {
  OM: { dec: 3, rates: [5, 0], weekend: [5, 6], tz: 'Asia/Muscat' },
  IN: { dec: 2, rates: [18, 12, 5, 0], weekend: [0], tz: 'Asia/Kolkata' },
};
const REGION = String(process.env.REGION || 'OM').toUpperCase() === 'IN' ? 'IN' : 'OM';
const CFG = REGIONS[REGION];
const TZ = process.env.TIMEZONE || CFG.tz;
const COMPANY = process.env.COMPANY_NAME || 'Your Company';
const JWT_SECRET = process.env.JWT_SECRET || '';
const PORT = process.env.PORT || 3000;

if (JWT_SECRET.length < 32) {
  console.error('JWT_SECRET is missing or too short. Set it to a random string of at least 32 characters.');
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is missing. Set it to your Postgres connection link.');
  process.exit(1);
}

const ROLES = ['Management', 'Daily Ops Clerk', 'Revenue & Payroll Clerk'];
const [M, OPS, RP] = ROLES;
const CATS = {
  Purchase: ['Diesel', 'Petrol', 'Tools', 'MEP', 'Services/Repair', 'Other'],
  'Equipment Hire': ['Hire - Tools', 'JCB', 'Pickup Truck', 'Shovel', 'Tanker', 'Tipper', 'Water Tanker'],
  Allowance: ['Bus', 'Car', 'Cookware/Kitchen Equipment', 'Food', 'Furniture', 'Mobile', 'Petrol', 'Rent', 'Taxi'],
};
const REVTYPES = ['Manpower Supply', 'Material & Services Supply'];
const PAYCATS = [
  ['Manpower', 'Gross Salaries', 'salary', 'Total gross salary'],
  ['Overheads', 'Rent', 'rent', 'Rent'],
  ['Overheads', 'Insurance', 'ins', 'Insurance'],
  ['Overheads', 'Misc Overheads', 'misc', 'Misc overheads'],
];
const MONL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const dbUrl = process.env.DATABASE_URL;
const useSsl = !/localhost|127\.0\.0\.1|\[::1\]/.test(dbUrl) && process.env.PGSSL !== 'off';
const pool = new Pool({ connectionString: dbUrl, ssl: useSsl ? { rejectUnauthorized: false } : false, max: 10 });
pool.on('error', (e) => console.error('Database connection error:', e.message));

/* ------------------------------------------------------------------ helpers */
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const pad = (n, w) => String(n).padStart(w, '0');
const rnd = (v) => { const f = Math.pow(10, CFG.dec); return Math.round(v * f) / f; };

function todayStr() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function tomorrowStr() {
  return new Date(Date.parse(todayStr() + 'T00:00:00Z') + 864e5).toISOString().slice(0, 10);
}
const curMonth = () => todayStr().slice(0, 7);
function addMonths(m, k) {
  const [y, mo] = m.split('-').map(Number);
  const d = new Date(Date.UTC(y, mo - 1 + k, 1));
  return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1, 2);
}
function isDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}
function mlabel(m) { const [y, mo] = m.split('-').map(Number); return MONL[mo - 1] + ' ' + y; }
function workingDays(m) {
  const [y, mo] = m.split('-').map(Number);
  const n = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const out = [];
  for (let d = 1; d <= n; d++) {
    if (!CFG.weekend.includes(new Date(Date.UTC(y, mo - 1, d)).getUTCDay())) out.push(`${m}-${pad(d, 2)}`);
  }
  return out;
}
function spread(total, n) {
  const f = Math.pow(10, CFG.dec);
  const T = Math.round(total * f);
  const per = Math.floor(T / n);
  const a = Array(n).fill(per);
  a[n - 1] += T - per * n;
  return a.map((x) => x / f);
}
function str(v, max, label, required) {
  const s = String(v == null ? '' : v).trim();
  if (required && !s) throw new HttpError(400, `${label} is required.`);
  if (s.length > max) throw new HttpError(400, `${label} is too long.`);
  return s;
}
function money(v, label, allowZero) {
  const n = typeof v === 'number' ? v : Number(String(v == null ? '' : v).replace(/,/g, ''));
  if (!Number.isFinite(n) || n < 0 || (!allowZero && n === 0) || n > 1e12) throw new HttpError(400, `${label} must be a valid amount.`);
  return rnd(n);
}
function idList(v) {
  if (!Array.isArray(v) || !v.length || v.length > 500) throw new HttpError(400, 'No entries selected.');
  const out = v.map(Number);
  if (out.some((n) => !Number.isInteger(n) || n < 1)) throw new HttpError(400, 'Invalid entry.');
  return [...new Set(out)];
}
function intParam(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, 'Invalid id.');
  return n;
}
async function withTx(fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch (_) { /* ignore */ }
    throw e;
  } finally {
    c.release();
  }
}

/* ------------------------------------------------------------------ app */
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      upgradeInsecureRequests: null,
    },
  },
}));
app.use(express.json({ limit: '1mb' }));

app.get('/healthz', (req, res) => res.json({ ok: true }));

app.get('/api/config', (req, res) => res.json({ region: REGION, company: COMPANY }));

const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many sign-in attempts. Wait 15 minutes and try again.' },
});

app.post('/api/login', loginLimiter, wrap(async (req, res) => {
  const username = str(req.body && req.body.username, 60, 'Username', true);
  const password = String((req.body && req.body.password) || '');
  const { rows } = await pool.query('SELECT * FROM users WHERE lower(username) = lower($1)', [username]);
  const u = rows[0];
  const ok = await bcrypt.compare(password, u ? u.password_hash : DUMMY_HASH);
  if (!u || !ok) throw new HttpError(401, 'That username and password do not match.');
  if (u.status !== 'Active') throw new HttpError(403, 'This account is inactive. Ask Management to reactivate it.');
  res.json({ token: jwt.sign({ uid: u.id }, JWT_SECRET, { expiresIn: '12h' }) });
}));

const auth = wrap(async (req, res, next) => {
  const h = req.headers.authorization || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : '';
  let p;
  try { p = jwt.verify(t, JWT_SECRET); } catch (e) { throw new HttpError(401, 'Please sign in again.'); }
  const { rows } = await pool.query('SELECT id, username, name, role, status, sites FROM users WHERE id = $1', [p.uid]);
  const u = rows[0];
  if (!u || u.status !== 'Active') throw new HttpError(401, 'This account is not active.');
  req.user = u;
  next();
});
const mgmtOnly = (req, res, next) => (req.user.role === M ? next() : next(new HttpError(403, 'Only Management can do this.')));

/* ---- everything the screens need, limited to what this role may see ---- */
app.get('/api/data', auth, wrap(async (req, res) => {
  const u = req.user;
  const mgmt = u.role === M;

  const sitesQ = mgmt
    ? await pool.query('SELECT * FROM sites ORDER BY id')
    : await pool.query('SELECT * FROM sites WHERE id = ANY($1) ORDER BY id', [u.sites]);
  const sites = sitesQ.rows.map((s) => ({
    id: s.id, code: s.code, name: s.name, location: s.location, manager: s.manager,
    budget: mgmt ? s.budget : 0, status: s.status,
  }));

  const users = mgmt
    ? (await pool.query('SELECT id, username, name, role, status, sites FROM users ORDER BY id')).rows
    : [{ id: u.id, username: u.username, name: u.name, role: u.role, status: u.status, sites: u.sites }];

  let txSql = 'SELECT * FROM transactions';
  let txArgs = [];
  if (u.role === OPS) { txSql += " WHERE kind = 'ops' AND site_id = ANY($1)"; txArgs = [u.sites]; }
  else if (u.role === RP) { txSql += " WHERE kind IN ('rev','pay') AND site_id = ANY($1)"; txArgs = [u.sites]; }
  txSql += ' ORDER BY id';
  const txRows = (await pool.query(txSql, txArgs)).rows;
  const tx = txRows.map((t) => ({
    id: t.id, date: t.tx_date, kind: t.kind, type: t.type, parent: t.parent, sub: t.sub, party: t.party,
    site: t.site_id, user: t.user_id, doc: t.doc, desc: t.descr, net: t.net, rate: t.rate, vat: t.vat,
    gross: t.gross, status: t.status, group: t.grp, entered: t.entered, at: t.tx_date,
  }));

  const reqRows = mgmt
    ? (await pool.query('SELECT * FROM cancel_requests ORDER BY id')).rows
    : (await pool.query('SELECT * FROM cancel_requests WHERE tx_ids && $1::int[] ORDER BY id', [tx.map((t) => t.id)])).rows;
  const reqs = reqRows.map((q) => ({
    id: q.id, by: q.by_user, reason: q.reason, at: q.requested_on, status: q.status,
    reviewedBy: q.reviewed_by, reviewedAt: q.reviewed_on, txIds: q.tx_ids,
  }));

  const first = await pool.query("SELECT to_char(min(tx_date), 'YYYY-MM') AS m FROM transactions");
  let start = process.env.START_MONTH && /^\d{4}-\d{2}$/.test(process.env.START_MONTH) ? process.env.START_MONTH : addMonths(curMonth(), -2);
  if (first.rows[0].m && first.rows[0].m < start) start = first.rows[0].m;
  if (start > curMonth()) start = curMonth();

  res.json({ me: u.id, data: { region: REGION, company: COMPANY, start, sites, users, tx, reqs } });
}));

/* ---- daily ops and revenue entries ---- */
app.post('/api/transactions', auth, wrap(async (req, res) => {
  const u = req.user;
  const rows = req.body && req.body.rows;
  if (!Array.isArray(rows) || !rows.length || rows.length > 200) throw new HttpError(400, 'Add at least one line (maximum 200 per batch).');
  const maxDate = tomorrowStr();
  const siteRows = (await pool.query('SELECT id, status FROM sites')).rows;
  const siteOk = new Set(siteRows.filter((s) => s.status === 'Active' && u.sites.includes(s.id)).map((s) => s.id));

  const clean = rows.map((r) => {
    const kind = r.kind;
    if (kind === 'ops') { if (u.role !== OPS && u.role !== M) throw new HttpError(403, 'You cannot enter daily expenses.'); }
    else if (kind === 'rev') { if (u.role !== RP && u.role !== M) throw new HttpError(403, 'You cannot enter revenue.'); }
    else throw new HttpError(400, 'Unknown entry type.');
    if (!isDate(r.date) || r.date > maxDate || r.date < '2000-01-01') throw new HttpError(400, 'Choose a valid date up to today.');
    const siteId = Number(r.site);
    if (!siteOk.has(siteId)) throw new HttpError(403, 'You cannot enter data for that site.');
    const rate = Number(r.rate);
    if (!CFG.rates.includes(rate)) throw new HttpError(400, 'Choose a valid tax rate.');
    const net = money(r.net, 'Net amount', false);
    const vat = rnd(net * rate / 100);
    const base = {
      date: r.date, kind, site: siteId, rate, net, vat, gross: rnd(net + vat),
      party: str(r.party, 120, kind === 'ops' ? 'Vendor' : 'Client', true),
      doc: str(r.doc, 60, kind === 'rev' ? 'Invoice number' : 'Bill number', kind === 'rev'),
      desc: str(r.desc, 300, 'Description', false),
    };
    if (kind === 'ops') {
      if (!CATS[r.parent] || !CATS[r.parent].includes(r.sub)) throw new HttpError(400, 'Choose a valid category.');
      return { ...base, type: 'Expense', parent: r.parent, sub: r.sub };
    }
    if (!REVTYPES.includes(r.sub)) throw new HttpError(400, 'Choose a valid revenue type.');
    return { ...base, type: 'Revenue', parent: 'Revenue', sub: r.sub };
  });

  const revDocs = clean.filter((r) => r.kind === 'rev').map((r) => r.doc.toLowerCase());
  if (new Set(revDocs).size !== revDocs.length) throw new HttpError(409, 'The same invoice number appears twice in this batch.');
  if (revDocs.length) {
    const dup = await pool.query("SELECT doc FROM transactions WHERE kind = 'rev' AND status = 'Active' AND lower(doc) = ANY($1)", [revDocs]);
    if (dup.rowCount) throw new HttpError(409, `Invoice ${dup.rows[0].doc} is already recorded. Check the number before adding it again.`);
  }

  const idsOut = await withTx(async (c) => {
    const out = [];
    for (const r of clean) {
      const ins = await c.query(
        `INSERT INTO transactions (tx_date, kind, type, parent, sub, party, site_id, user_id, doc, descr, net, rate, vat, gross)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
        [r.date, r.kind, r.type, r.parent, r.sub, r.party, r.site, u.id, r.doc, r.desc, r.net, r.rate, r.vat, r.gross]);
      out.push(ins.rows[0].id);
    }
    return out;
  });
  res.json({ first: Math.min(...idsOut), last: Math.max(...idsOut), count: idsOut.length });
}));

/* ---- monthly payroll and overheads, spread over working days ---- */
app.post('/api/payroll', auth, wrap(async (req, res) => {
  const u = req.user;
  if (u.role !== RP && u.role !== M) throw new HttpError(403, 'You cannot enter payroll.');
  const b = req.body || {};
  const m = String(b.month || '');
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(m) || m > curMonth() || m < addMonths(curMonth(), -24)) throw new HttpError(400, 'Choose a valid month.');
  const sid = Number(b.site);
  const s = (await pool.query('SELECT id, status FROM sites WHERE id = $1', [sid])).rows[0];
  if (!s || s.status !== 'Active' || !u.sites.includes(sid)) throw new HttpError(403, 'You cannot enter data for that site.');
  const vals = {};
  for (const pc of PAYCATS) {
    const raw = b.vals && b.vals[pc[2]];
    vals[pc[2]] = raw === undefined || raw === null || raw === '' ? 0 : money(raw, pc[3], true);
  }
  if (!(vals.salary > 0)) throw new HttpError(400, 'Enter the total gross salary for the month.');

  const wd = workingDays(m);
  const ids = await withTx(async (c) => {
    const ex = await c.query("SELECT 1 FROM transactions WHERE kind = 'pay' AND status = 'Active' AND site_id = $1 AND grp LIKE $2 LIMIT 1", [sid, `PAY-${sid}-${m}-%`]);
    if (ex.rowCount) throw new HttpError(409, `Payroll for ${mlabel(m)} is already submitted for this site. Request cancellation of it first to resubmit.`);
    const out = [];
    for (const pc of PAYCATS) {
      const v = vals[pc[2]];
      if (v <= 0) continue;
      const g = `PAY-${sid}-${m}-${pc[2]}`;
      const parts = spread(v, wd.length);
      for (let i = 0; i < wd.length; i++) {
        const r = await c.query(
          `INSERT INTO transactions (tx_date, kind, type, parent, sub, party, site_id, user_id, doc, descr, net, rate, vat, gross, grp, entered)
           VALUES ($1,'pay','Expense',$2,$3,$4,$5,$6,'',$7,$8,0,0,$8,$9,$10) RETURNING id`,
          [wd[i], pc[0], pc[1], pc[0] === 'Manpower' ? 'Payroll' : '', sid, u.id, `${pc[3]}, ${mlabel(m)}`, parts[i], g, v]);
        out.push(r.rows[0].id);
      }
    }
    return out;
  });
  res.json({ rows: ids.length, days: wd.length, first: Math.min(...ids), last: Math.max(...ids) });
}));

/* ---- cancellation workflow ---- */
app.post('/api/cancel-requests', auth, wrap(async (req, res) => {
  const u = req.user;
  const idl = idList(req.body && req.body.txIds);
  const reason = str(req.body && req.body.reason, 300, 'Reason', true);
  if (reason.length < 5) throw new HttpError(400, 'Give a short reason so Management can decide.');
  await withTx(async (c) => {
    const { rows } = await c.query('SELECT id, user_id, status FROM transactions WHERE id = ANY($1) FOR UPDATE', [idl]);
    if (rows.length !== idl.length) throw new HttpError(404, 'Entry not found.');
    for (const t of rows) {
      if (t.status !== 'Active') throw new HttpError(409, 'Only active entries can be cancelled.');
      if (u.role !== M && t.user_id !== u.id) throw new HttpError(403, 'You can only request cancellation of your own entries.');
    }
    const p = await c.query("SELECT 1 FROM cancel_requests WHERE status = 'Pending' AND tx_ids && $1::int[]", [idl]);
    if (p.rowCount) throw new HttpError(409, 'A cancellation request is already waiting for one of these entries.');
    await c.query("INSERT INTO cancel_requests (by_user, reason, requested_on, status, tx_ids) VALUES ($1,$2,$3,'Pending',$4)", [u.id, reason, todayStr(), idl]);
  });
  res.json({ ok: true });
}));

app.post('/api/cancel-requests/:id/review', auth, mgmtOnly, wrap(async (req, res) => {
  const id = intParam(req.params.id);
  const decision = req.body && req.body.decision;
  if (decision !== 'approve' && decision !== 'reject') throw new HttpError(400, 'Choose approve or reject.');
  await withTx(async (c) => {
    const q = (await c.query('SELECT * FROM cancel_requests WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!q) throw new HttpError(404, 'Request not found.');
    if (q.status !== 'Pending') throw new HttpError(409, 'This request has already been reviewed.');
    await c.query('UPDATE cancel_requests SET status = $1, reviewed_by = $2, reviewed_on = $3 WHERE id = $4',
      [decision === 'approve' ? 'Approved' : 'Rejected', req.user.id, todayStr(), id]);
    if (decision === 'approve') await c.query("UPDATE transactions SET status = 'Cancelled' WHERE id = ANY($1)", [q.tx_ids]);
  });
  res.json({ ok: true });
}));

app.post('/api/transactions/cancel', auth, mgmtOnly, wrap(async (req, res) => {
  const idl = idList(req.body && req.body.ids);
  const reason = str(req.body && req.body.reason, 300, 'Reason', true);
  if (reason.length < 5) throw new HttpError(400, 'Add a reason for the audit trail.');
  await withTx(async (c) => {
    const { rows } = await c.query('SELECT id FROM transactions WHERE id = ANY($1) FOR UPDATE', [idl]);
    if (rows.length !== idl.length) throw new HttpError(404, 'Entry not found.');
    await c.query("UPDATE transactions SET status = 'Cancelled' WHERE id = ANY($1)", [idl]);
    await c.query("UPDATE cancel_requests SET status = 'Approved', reviewed_by = $1, reviewed_on = $2 WHERE status = 'Pending' AND tx_ids && $3::int[]", [req.user.id, todayStr(), idl]);
    await c.query("INSERT INTO cancel_requests (by_user, reason, requested_on, status, reviewed_by, reviewed_on, tx_ids) VALUES ($1,$2,$3,'Approved',$1,$3,$4)", [req.user.id, reason, todayStr(), idl]);
  });
  res.json({ ok: true });
}));

app.post('/api/transactions/reinstate', auth, mgmtOnly, wrap(async (req, res) => {
  const idl = idList(req.body && req.body.ids);
  await pool.query("UPDATE transactions SET status = 'Active' WHERE id = ANY($1) AND status = 'Cancelled'", [idl]);
  res.json({ ok: true });
}));

/* ---- sites ---- */
app.post('/api/sites', auth, mgmtOnly, wrap(async (req, res) => {
  const b = req.body || {};
  const code = str(b.code, 20, 'Site code', true).toUpperCase();
  const name = str(b.name, 120, 'Site name', true);
  const location = str(b.location, 80, 'Location', false) || name;
  const manager = str(b.manager, 80, 'Site manager', false);
  const budget = b.budget === undefined || b.budget === '' || b.budget === null ? 0 : money(b.budget, 'Budget', true);
  if ((await pool.query('SELECT 1 FROM sites WHERE code = $1', [code])).rowCount) throw new HttpError(409, `Site code ${code} is already in use.`);
  await withTx(async (c) => {
    const r = await c.query('INSERT INTO sites (code, name, location, manager, budget) VALUES ($1,$2,$3,$4,$5) RETURNING id', [code, name, location, manager, budget]);
    await c.query("UPDATE users SET sites = array_append(sites, $1) WHERE role = 'Management'", [r.rows[0].id]);
  });
  res.json({ ok: true });
}));

app.post('/api/sites/:id/toggle', auth, mgmtOnly, wrap(async (req, res) => {
  const id = intParam(req.params.id);
  const r = await pool.query("UPDATE sites SET status = CASE WHEN status = 'Active' THEN 'Inactive' ELSE 'Active' END WHERE id = $1 RETURNING name, status", [id]);
  if (!r.rowCount) throw new HttpError(404, 'Site not found.');
  res.json(r.rows[0]);
}));

/* ---- users ---- */
async function validSites(arr) {
  if (!Array.isArray(arr) || !arr.length) throw new HttpError(400, 'Assign at least one site.');
  const want = [...new Set(arr.map(Number))];
  if (want.some((n) => !Number.isInteger(n) || n < 1)) throw new HttpError(400, 'Invalid site.');
  const { rows } = await pool.query('SELECT id FROM sites WHERE id = ANY($1)', [want]);
  if (rows.length !== want.length) throw new HttpError(400, 'One of the sites does not exist.');
  return want;
}

app.post('/api/users', auth, mgmtOnly, wrap(async (req, res) => {
  const b = req.body || {};
  const name = str(b.name, 80, 'Full name', true);
  const username = str(b.username, 40, 'Username', true);
  if (!/^[A-Za-z0-9._-]{3,40}$/.test(username)) throw new HttpError(400, 'Username can use letters, numbers, dot, dash and underscore (at least 3 characters).');
  const password = String(b.password || '');
  if (password.length < 8 || password.length > 100) throw new HttpError(400, 'Use a password of at least 8 characters.');
  if (!ROLES.includes(b.role)) throw new HttpError(400, 'Choose a valid role.');
  const sites = await validSites(b.sites);
  if ((await pool.query('SELECT 1 FROM users WHERE lower(username) = lower($1)', [username])).rowCount) throw new HttpError(409, `Username ${username} is taken.`);
  const hash = await bcrypt.hash(password, 10);
  await pool.query('INSERT INTO users (username, password_hash, name, role, sites) VALUES ($1,$2,$3,$4,$5)', [username, hash, name, b.role, sites]);
  res.json({ ok: true });
}));

app.post('/api/users/:id/toggle', auth, mgmtOnly, wrap(async (req, res) => {
  const id = intParam(req.params.id);
  if (id === req.user.id) throw new HttpError(400, 'You cannot deactivate your own account.');
  const r = await pool.query("UPDATE users SET status = CASE WHEN status = 'Active' THEN 'Inactive' ELSE 'Active' END WHERE id = $1 RETURNING name, status", [id]);
  if (!r.rowCount) throw new HttpError(404, 'User not found.');
  res.json(r.rows[0]);
}));

app.put('/api/users/:id/sites', auth, mgmtOnly, wrap(async (req, res) => {
  const id = intParam(req.params.id);
  const sites = await validSites(req.body && req.body.sites);
  const r = await pool.query('UPDATE users SET sites = $1 WHERE id = $2', [sites, id]);
  if (!r.rowCount) throw new HttpError(404, 'User not found.');
  res.json({ ok: true });
}));

app.post('/api/password', auth, wrap(async (req, res) => {
  const cur = String((req.body && req.body.current) || '');
  const next = String((req.body && req.body.next) || '');
  const row = (await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id])).rows[0];
  if (!(await bcrypt.compare(cur, row.password_hash))) throw new HttpError(400, 'Your current password is not correct.');
  if (next.length < 8 || next.length > 100) throw new HttpError(400, 'Use at least 8 characters.');
  if (next === cur) throw new HttpError(400, 'Choose a password different from the current one.');
  await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [await bcrypt.hash(next, 10), req.user.id]);
  res.json({ ok: true });
}));

/* ---- website files and errors ---- */
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
app.use(express.static(path.join(__dirname, 'public')));

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Bad request.' });
  if (err && err.code === '23505') return res.status(409).json({ error: 'This conflicts with an existing record (for example a duplicate invoice number or payroll month).' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server. Try again.' });
});

/* ------------------------------------------------------------------ start */
async function init() {
  await pool.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  const n = (await pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n;
  if (n === 0) {
    const un = process.env.ADMIN_USERNAME;
    const pw = process.env.ADMIN_PASSWORD;
    if (!un || !pw || pw.length < 8) {
      console.warn('No users exist yet. Set ADMIN_USERNAME and ADMIN_PASSWORD (8+ characters) and restart to create the first Management login.');
    } else {
      await pool.query('INSERT INTO users (username, password_hash, name, role, sites) VALUES ($1,$2,$3,$4,$5)',
        [un, await bcrypt.hash(pw, 10), process.env.ADMIN_NAME || 'Administrator', M, []]);
      console.log(`Created first Management login "${un}".`);
    }
  }
}

init()
  .then(() => app.listen(PORT, () => console.log(`OpsNest FIS running on port ${PORT} (${REGION}, ${CFG.dec} decimals)`)))
  .catch((e) => { console.error('Could not start:', e.message); process.exit(1); });
