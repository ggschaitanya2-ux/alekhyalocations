// Alekhya Locations — shared location tree service
// One source of truth for Site › Block › Floor › Flat › Room used by Gate, Daybook, QC, JMR, ...
'use strict';
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

// ---------- config ----------
const cfg = {
  port: parseInt(process.env.PORT || '3200', 10),
  databaseUrl: process.env.DATABASE_URL,
  jwtSecret: process.env.JWT_SECRET,
  editRoles: list(process.env.EDIT_ROLES || 'admin,pm'),
  adminRoles: list(process.env.ADMIN_ROLES || 'admin'),
  usersTable: process.env.USERS_TABLE || 'users',
  usersPasswordCol: process.env.USERS_PASSWORD_COL || 'password_hash',
  corsOrigins: list(process.env.CORS_ORIGINS || ''),
  // API_KEYS="daybook-grand:longrandomkey:AGV,qc-grand:anotherkey:AGV"
  // name:key[:SITE_CODE] — read-only keys for other apps' servers. With a site code the key
  // can only ever see that one site (one Daybook / QC deployment per site).
  apiKeys: Object.fromEntries(list(process.env.API_KEYS || '').map(s => {
    const [name, key, site] = s.split(':');
    return key ? [key, { name, site: site || null }] : [name, { name: 'app', site: null }];
  })),
};
function list(s) { return String(s).split(',').map(x => x.trim()).filter(Boolean); }
if (!cfg.databaseUrl || !cfg.jwtSecret) {
  console.error('DATABASE_URL and JWT_SECRET must be set (see .env.example)');
  process.exit(1);
}
const ident = s => { if (!/^[a-z_][a-z0-9_]*$/i.test(s)) throw new Error('bad identifier ' + s); return '"' + s + '"'; };

const pool = new Pool({ connectionString: cfg.databaseUrl, max: 10 });

// ---------- migrations ----------
async function migrate() {
  const dir = path.join(__dirname, 'sql');
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(dir, f), 'utf8'));
    console.log('migration ok:', f);
  }
}

// ---------- helpers ----------
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

async function tx(fn) {
  const c = await pool.connect();
  try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; }
  catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
  finally { c.release(); }
}
async function audit(c, locationId, action, before, after, user, note) {
  await c.query(
    'INSERT INTO location_audit (location_id, action, before, after, note, username) VALUES ($1,$2,$3,$4,$5,$6)',
    [locationId, action, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, note || null, user]);
}
async function bump(c) {
  await c.query(`UPDATE location_meta SET value = (value::bigint + 1)::text WHERE key = 'version'`);
}
async function getNode(c, id) {
  const r = await c.query('SELECT * FROM locations WHERE id = $1', [id]);
  if (!r.rows[0]) throw new HttpError(404, 'Location not found');
  return r.rows[0];
}
async function assertType(c, type) {
  const r = await c.query('SELECT 1 FROM location_types WHERE code = $1 AND active', [type]);
  if (!r.rows[0]) throw new HttpError(400, `Unknown location type "${type}"`);
}
async function isDescendant(c, ancestorId, nodeId) {
  const r = await c.query(`
    WITH RECURSIVE d AS (SELECT id FROM locations WHERE parent_id = $1
      UNION ALL SELECT l.id FROM locations l JOIN d ON l.parent_id = d.id)
    SELECT 1 FROM d WHERE id = $2 LIMIT 1`, [ancestorId, nodeId]);
  return !!r.rows[0];
}
async function nextSort(c, parentId) {
  const r = await c.query('SELECT COALESCE(MAX(sort_order), 0) + 10 AS s FROM locations WHERE parent_id IS NOT DISTINCT FROM $1', [parentId]);
  return r.rows[0].s;
}
function clean(s, max = 120) { return String(s ?? '').trim().replace(/\s+/g, ' ').slice(0, max); }

// ---------- auth ----------
function authenticate(req) {
  const key = req.get('x-api-key');
  if (key && cfg.apiKeys[key]) { const k = cfg.apiKeys[key]; return { username: 'app:' + k.name, role: 'app', app: true, site: k.site }; }
  const h = req.get('authorization') || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return null;
  try {
    const p = jwt.verify(token, cfg.jwtSecret);   // same secret as Alekhya Gate → Gate tokens work here too
    return { id: p.id ?? p.sub, username: p.username || p.name || String(p.id ?? p.sub), role: p.role, full_name: p.full_name };
  } catch { return null; }
}
const canEdit = u => u && !u.app && cfg.editRoles.includes(u.role);
const isAdmin = u => u && !u.app && cfg.adminRoles.includes(u.role);
function need(level) {
  return (req, res, next) => {
    const u = authenticate(req);
    if (!u) return res.status(401).json({ error: 'Login required' });
    if (level === 'edit' && !canEdit(u)) return res.status(403).json({ error: 'Only admin / PM can change locations' });
    if (level === 'admin' && !isAdmin(u)) return res.status(403).json({ error: 'Admin only' });
    req.user = u; next();
  };
}

// ---------- site scope ----------
// ?site=AGV (site code) limits a request to one site. A site-locked API key always applies its
// own site and is refused anything outside it.
async function siteScope(req) {
  const want = req.user.site || req.query.site || null;
  if (req.user.site && req.query.site && req.query.site.toLowerCase() !== req.user.site.toLowerCase())
    throw new HttpError(403, `This key is for site ${req.user.site} only`);
  if (!want) return null;
  const r = await pool.query('SELECT id FROM locations WHERE parent_id IS NULL AND lower(code) = lower($1)', [want]);
  if (!r.rows[0]) throw new HttpError(404, `No site with code "${want}"`);
  return r.rows[0].id;
}
async function assertInScope(req, id) {
  const site = await siteScope(req);
  if (!site) return;
  const r = await pool.query('SELECT site_id FROM location_paths WHERE id = $1', [id]);
  if (r.rows[0] && r.rows[0].site_id !== site) throw new HttpError(404, 'Location not found in this site');
}

// ---------- app ----------
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '5mb' }));
app.use((req, res, next) => {
  const o = req.get('origin');
  if (o && (cfg.corsOrigins.includes('*') || cfg.corsOrigins.includes(o))) {
    res.set('Access-Control-Allow-Origin', o);
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Api-Key');
    res.set('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
  }
  next();
});

app.get('/api/health', wrap(async (req, res) => {
  await pool.query('SELECT 1'); res.json({ ok: true, service: 'alekhya-locations' });
}));

app.post('/api/login', wrap(async (req, res) => {
  const username = clean(req.body.username, 80), password = String(req.body.password || '');
  if (!username || !password) throw new HttpError(400, 'Username and password required');
  const r = await pool.query(
    `SELECT id, username, full_name, role, active, ${ident(cfg.usersPasswordCol)} AS pw
       FROM ${ident(cfg.usersTable)} WHERE lower(username) = lower($1)`, [username]);
  const u = r.rows[0];
  if (!u || !u.active || !u.pw || !(await bcrypt.compare(password, u.pw))) throw new HttpError(401, 'Wrong username or password');
  const payload = { id: u.id, username: u.username, full_name: u.full_name, role: u.role };
  res.json({ token: jwt.sign(payload, cfg.jwtSecret, { expiresIn: '12h' }), user: { ...payload, can_edit: canEdit(payload), is_admin: isAdmin(payload) } });
}));

app.get('/api/me', need('read'), (req, res) => res.json({ ...req.user, can_edit: canEdit(req.user), is_admin: isAdmin(req.user) }));

// ---- version (cheap change check for other apps) ----
app.get('/api/version', need('read'), wrap(async (req, res) => {
  const r = await pool.query(`SELECT value FROM location_meta WHERE key='version'`);
  res.json({ version: Number(r.rows[0]?.value || 0) });
}));

// ---- types ----
app.get('/api/types', need('read'), wrap(async (req, res) => {
  const r = await pool.query('SELECT * FROM location_types ORDER BY sort_order, label');
  res.json(r.rows);
}));
app.put('/api/types/:code', need('admin'), wrap(async (req, res) => {
  const code = clean(req.params.code, 30).toLowerCase();
  if (!/^[a-z][a-z0-9_]*$/.test(code)) throw new HttpError(400, 'Type code: lowercase letters, digits, _');
  const label = clean(req.body.label, 60); if (!label) throw new HttpError(400, 'Label required');
  const r = await tx(async c => {
    const q = await c.query(`
      INSERT INTO location_types (code, label, sort_order, color, active) VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (code) DO UPDATE SET label=EXCLUDED.label, sort_order=EXCLUDED.sort_order, color=EXCLUDED.color, active=EXCLUDED.active
      RETURNING *`, [code, label, parseInt(req.body.sort_order || 0, 10) || 0, /^#[0-9a-f]{6}$/i.test(req.body.color || '') ? req.body.color : '#64748b', req.body.active !== false]);
    await audit(c, null, 'type', null, q.rows[0], req.user.username); await bump(c);
    return q.rows[0];
  });
  res.json(r);
}));

// ---- read: flat list ----
// GET /api/locations?site_id=&parent_id=&type=flat,villa&q=&include_inactive=1&leaf=1
app.get('/api/locations', need('read'), wrap(async (req, res) => {
  const w = [], p = [];
  const add = (sql, v) => { p.push(v); w.push(sql.replace('?', '$' + p.length)); };
  const scoped = await siteScope(req);
  if (scoped) add('site_id = ?', scoped);
  if (req.query.site_id) add('site_id = ?', parseInt(req.query.site_id, 10));
  if (req.query.parent_id === 'root') w.push('parent_id IS NULL');
  else if (req.query.parent_id) add('parent_id = ?', parseInt(req.query.parent_id, 10));
  if (req.query.type) add('type = ANY(?)', list(req.query.type));
  if (req.query.q) add('path_name ILIKE ?', '%' + req.query.q + '%');
  if (req.query.under) add('? = ANY(path_ids)', parseInt(req.query.under, 10));
  if (!req.query.include_inactive) w.push('effective_active');
  if (req.query.leaf) w.push('NOT EXISTS (SELECT 1 FROM locations k WHERE k.parent_id = lp.id AND k.active)');
  const r = await pool.query(
    `SELECT id, parent_id, type, code, name, sort_order, active, effective_active, meta, site_id, depth, path_name, path_code, path_ids
       FROM location_paths lp ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY sort_key`, p);
  res.json(r.rows);
}));

// ---- read: nested tree ----
app.get('/api/tree', need('read'), wrap(async (req, res) => {
  const incl = !!req.query.include_inactive;
  const scoped = await siteScope(req);
  const root = req.query.root ? parseInt(req.query.root, 10) : scoped;
  if (req.query.root) await assertInScope(req, root);
  const r = await pool.query(
    `SELECT id, parent_id, type, code, name, sort_order, active, effective_active, meta, depth, path_name, path_code,
            (SELECT count(*)::int FROM locations k WHERE k.parent_id = lp.id) AS child_count
       FROM location_paths lp
      WHERE ($1::int IS NULL OR $1 = ANY(path_ids)) AND ($2 OR effective_active)
      ORDER BY sort_key`, [root, incl]);
  const byId = new Map(); const roots = [];
  for (const n of r.rows) { n.children = []; byId.set(n.id, n); }
  for (const n of r.rows) {
    const par = byId.get(n.parent_id);
    if (par && n.id !== root) par.children.push(n); else roots.push(n);
  }
  res.json(root ? roots.filter(n => n.id === root) : roots);
}));

// ---- sites (each app deployment picks one by code) ----
app.get('/api/sites', need('read'), wrap(async (req, res) => {
  const scoped = await siteScope(req);
  const r = await pool.query(
    `SELECT id, code, name, active, meta FROM locations WHERE parent_id IS NULL AND ($1::int IS NULL OR id = $1) ORDER BY sort_order, id`, [scoped]);
  res.json(r.rows);
}));
// ---- check before saving: does this location belong to this app's site? ----
// GET /api/check?site=AGV&id=123  →  { ok: true, path_name: "Alekhya Grand › Tower 1 › Floor 3 › 304" }
app.get('/api/check', need('read'), wrap(async (req, res) => {
  const site = req.user.site || req.query.site;
  if (!site) throw new HttpError(400, 'site code required');
  const id = parseInt(req.query.id, 10);
  const r = await pool.query('SELECT location_in_site($1, $2) AS ok', [id, site]);
  const p = r.rows[0].ok ? (await pool.query('SELECT path_name, effective_active FROM location_paths WHERE id=$1', [id])).rows[0] : null;
  res.json({ ok: !!r.rows[0].ok, active: !!p?.effective_active, path_name: p?.path_name || null });
}));

app.get('/api/locations/:id', need('read'), wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  await assertInScope(req, id);
  const r = await pool.query('SELECT * FROM location_paths WHERE id = $1', [id]);
  if (!r.rows[0]) throw new HttpError(404, 'Location not found');
  const kids = await pool.query('SELECT * FROM locations WHERE parent_id = $1 ORDER BY sort_order, id', [id]);
  res.json({ ...r.rows[0], children: kids.rows });
}));

// ---- write: create ----
app.post('/api/locations', need('edit'), wrap(async (req, res) => {
  const b = req.body;
  const node = await tx(async c => {
    const parentId = b.parent_id ? parseInt(b.parent_id, 10) : null;
    if (parentId) await getNode(c, parentId);
    const type = clean(b.type, 30) || (parentId ? 'area' : 'site');
    await assertType(c, type);
    const name = clean(b.name); if (!name) throw new HttpError(400, 'Name required');
    const sort = Number.isFinite(+b.sort_order) && b.sort_order !== '' && b.sort_order != null ? +b.sort_order : await nextSort(c, parentId);
    const r = await c.query(
      `INSERT INTO locations (parent_id, type, code, name, sort_order, meta, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$7) RETURNING *`,
      [parentId, type, clean(b.code, 30), name, sort, b.meta && typeof b.meta === 'object' ? b.meta : {}, req.user.username]);
    await audit(c, r.rows[0].id, 'create', null, r.rows[0], req.user.username); await bump(c);
    return r.rows[0];
  });
  res.status(201).json(node);
}));

// ---- write: update fields ----
app.patch('/api/locations/:id', need('edit'), wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10), b = req.body;
  const node = await tx(async c => {
    const before = await getNode(c, id);
    const next = { ...before };
    if ('name' in b) { next.name = clean(b.name); if (!next.name) throw new HttpError(400, 'Name required'); }
    if ('code' in b) next.code = clean(b.code, 30);
    if ('type' in b) { next.type = clean(b.type, 30); await assertType(c, next.type); }
    if ('sort_order' in b) next.sort_order = parseInt(b.sort_order, 10) || 0;
    if ('meta' in b && b.meta && typeof b.meta === 'object') next.meta = b.meta;
    if ('active' in b) next.active = !!b.active;
    const r = await c.query(
      `UPDATE locations SET name=$2, code=$3, type=$4, sort_order=$5, meta=$6, active=$7, updated_by=$8, updated_at=now()
        WHERE id=$1 RETURNING *`,
      [id, next.name, next.code, next.type, next.sort_order, next.meta, next.active, req.user.username]);
    const action = before.active !== next.active ? (next.active ? 'reactivate' : 'deactivate') : 'update';
    await audit(c, id, action, before, r.rows[0], req.user.username, clean(b.note, 300)); await bump(c);
    return r.rows[0];
  });
  res.json(node);
}));

// ---- write: move under another parent ----
app.post('/api/locations/:id/move', need('edit'), wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const parentId = req.body.parent_id ? parseInt(req.body.parent_id, 10) : null;
  const node = await tx(async c => {
    const before = await getNode(c, id);
    if (parentId) {
      await getNode(c, parentId);
      if (parentId === id || await isDescendant(c, id, parentId)) throw new HttpError(400, 'Cannot move a location inside itself');
    }
    const r = await c.query(
      'UPDATE locations SET parent_id=$2, sort_order=$3, updated_by=$4, updated_at=now() WHERE id=$1 RETURNING *',
      [id, parentId, await nextSort(c, parentId), req.user.username]);
    await audit(c, id, 'move', before, r.rows[0], req.user.username); await bump(c);
    return r.rows[0];
  });
  res.json(node);
}));

// ---- write: reorder siblings ----
app.post('/api/locations/reorder', need('edit'), wrap(async (req, res) => {
  const ids = (req.body.ids || []).map(x => parseInt(x, 10)).filter(Boolean);
  if (!ids.length) throw new HttpError(400, 'ids required');
  await tx(async c => {
    const r = await c.query('SELECT DISTINCT parent_id FROM locations WHERE id = ANY($1)', [ids]);
    if (r.rows.length !== 1) throw new HttpError(400, 'Can only reorder siblings');
    for (let i = 0; i < ids.length; i++)
      await c.query('UPDATE locations SET sort_order=$2, updated_at=now(), updated_by=$3 WHERE id=$1', [ids[i], (i + 1) * 10, req.user.username]);
    await audit(c, null, 'reorder', null, { ids }, req.user.username); await bump(c);
  });
  res.json({ ok: true });
}));

// ---- usage: is any app's data linked to this location or anything inside it? ----
// Every table in the database with a foreign key to locations(id) is found automatically
// (Daybook entries, QC checks, JMR bills, gate punches…), so new apps are covered as soon as
// they add `location_id int REFERENCES locations(id)`.
async function subtreeIds(c, id) {
  const r = await c.query(`
    WITH RECURSIVE t AS (SELECT id, 0 AS depth FROM locations WHERE id = $1
      UNION ALL SELECT l.id, t.depth + 1 FROM locations l JOIN t ON l.parent_id = t.id)
    SELECT id FROM t ORDER BY depth DESC`, [id]);
  return r.rows.map(x => x.id);
}
async function usage(c, ids) {
  const fks = await c.query(`
    SELECT n.nspname AS schema, cl.relname AS tbl, a.attname AS col
      FROM pg_constraint k
      JOIN pg_class cl ON cl.oid = k.conrelid
      JOIN pg_namespace n ON n.oid = cl.relnamespace
      JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = k.conkey[1]
     WHERE k.contype = 'f' AND k.confrelid = 'locations'::regclass
       AND array_length(k.conkey, 1) = 1 AND cl.relname <> 'locations'`);
  const out = [];
  for (const f of fks.rows) {
    const r = await c.query(`SELECT count(*)::int n FROM ${ident(f.schema)}.${ident(f.tbl)} WHERE ${ident(f.col)} = ANY($1)`, [ids]);
    if (r.rows[0].n) out.push({ table: f.tbl, column: f.col, count: r.rows[0].n });
  }
  return out;
}
app.get('/api/locations/:id/usage', need('read'), wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  await assertInScope(req, id);
  const c = await pool.connect();
  try {
    await getNode(c, id);
    const ids = await subtreeIds(c, id);
    const used = await usage(c, ids);
    res.json({ inside: ids.length - 1, used, can_delete: used.length === 0 });
  } finally { c.release(); }
}));

// ---- write: hard delete (admin) — only when NO app data is linked to it or anything inside ----
// Empty sub-locations (no records anywhere) are deleted with it when ?with_children=1.
app.delete('/api/locations/:id', need('admin'), wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const deleted = await tx(async c => {
    const before = await getNode(c, id);
    const ids = await subtreeIds(c, id);
    const used = await usage(c, ids);
    if (used.length)
      throw new HttpError(409, `Can't delete ${before.name} — it has data in ${used.map(u => `${u.table.replace(/_/g, ' ')} (${u.count})`).join(', ')}. Deactivate it instead.`);
    if (ids.length > 1 && !req.query.with_children)
      throw new HttpError(400, `${before.name} has ${ids.length - 1} locations inside — confirm deleting them too`);
    try { for (const x of ids) await c.query('DELETE FROM locations WHERE id=$1', [x]); }
    catch (e) { if (e.code === '23503') throw new HttpError(409, 'Data is linked to this location — deactivate it instead'); throw e; }
    await audit(c, id, 'delete', before, { deleted: ids.length }, req.user.username); await bump(c);
    return ids.length;
  });
  res.json({ ok: true, deleted });
}));

// ---- bulk generator ----
// levels: [{ type:'floor', from:1, to:7, name:'Floor {n}', code:'F{nn}' }, { type:'flat', from:1, to:4, name:'Flat {p}{nn}', code:'{p}{nn}' }]
// tokens: {n} number, {nn} 2-digit, {nnn} 3-digit, {p} parent level's number, {pp} parent 2-digit, {A} letter (1→A)
function fill(tpl, n, p) {
  const pad = (x, w) => String(x).padStart(w, '0');
  return String(tpl)
    .replace(/\{nnn\}/g, pad(n, 3)).replace(/\{nn\}/g, pad(n, 2)).replace(/\{n\}/g, n)
    .replace(/\{pp\}/g, p == null ? '' : pad(p, 2)).replace(/\{p\}/g, p == null ? '' : p)
    .replace(/\{A\}/g, n >= 1 && n <= 26 ? String.fromCharCode(64 + n) : n);
}
function planGenerate(levels, rootNum) {
  if (!Array.isArray(levels) || !levels.length || levels.length > 3) throw new HttpError(400, '1–3 levels required');
  let total = 1;
  for (const L of levels) {
    L.from = parseInt(L.from, 10); L.to = parseInt(L.to, 10);
    if (!Number.isFinite(L.from) || !Number.isFinite(L.to) || L.to < L.from) throw new HttpError(400, 'Each level needs from ≤ to');
    if (!clean(L.name)) throw new HttpError(400, 'Each level needs a name pattern');
    L.skip = list(L.skip || '').map(Number);
    total *= (L.to - L.from + 1);
  }
  if (total > 2000) throw new HttpError(400, `That would create ${total} locations — max 2000 at once`);
  const out = [];
  (function walk(depth, parentN, prefix) {
    const L = levels[depth];
    for (let n = L.from; n <= L.to; n++) {
      if (L.skip.includes(n)) continue;
      const item = { type: L.type, name: clean(fill(L.name, n, parentN)), code: clean(fill(L.code || '', n, parentN), 30), children: [] };
      prefix.push(item);
      if (depth + 1 < levels.length) walk(depth + 1, n, item.children);
    }
  })(0, rootNum ?? null, out);
  return out;
}
app.post('/api/locations/:id/generate', need('edit'), wrap(async (req, res) => {
  const rootId = req.params.id === 'root' ? null : parseInt(req.params.id, 10);
  // {p} on the first level = the number in the parent's code/name (Floor 5 → 5), so 'Flat {p}{nn}' → Flat 501
  let rootNum = null;
  if (rootId) {
    const pr = await pool.query('SELECT code, name FROM locations WHERE id=$1', [rootId]);
    if (!pr.rows[0]) throw new HttpError(404, 'Location not found');
    const m = (pr.rows[0].code.match(/(\d+)\D*$/) || pr.rows[0].name.match(/(\d+)\D*$/));
    if (m) rootNum = parseInt(m[1], 10);
  }
  const plan = planGenerate(req.body.levels, rootNum);
  if (req.body.dry_run) return res.json({ plan });
  const result = await tx(async c => {
    if (rootId) await getNode(c, rootId);
    for (const L of req.body.levels) await assertType(c, L.type);
    let created = 0, existing = 0;
    async function put(parentId, items) {
      let sort = await nextSort(c, parentId);
      for (const it of items) {
        const ex = await c.query('SELECT id FROM locations WHERE parent_id IS NOT DISTINCT FROM $1 AND lower(name)=lower($2) AND active', [parentId, it.name]);
        let id;
        if (ex.rows[0]) { id = ex.rows[0].id; existing++; }
        else {
          const r = await c.query(
            `INSERT INTO locations (parent_id, type, code, name, sort_order, created_by, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$6) RETURNING id`,
            [parentId, it.type, it.code, it.name, sort, req.user.username]);
          id = r.rows[0].id; sort += 10; created++;
        }
        if (it.children.length) await put(id, it.children);
      }
    }
    await put(rootId, plan);
    await audit(c, rootId, 'bulk', null, { levels: req.body.levels, created, existing }, req.user.username); await bump(c);
    return { created, existing };
  });
  res.json(result);
}));

// ---- duplicate a whole branch (e.g. Tower A → Tower B) ----
app.post('/api/locations/:id/duplicate', need('edit'), wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const result = await tx(async c => {
    const src = await getNode(c, id);
    const targetParent = 'parent_id' in req.body ? (req.body.parent_id ? parseInt(req.body.parent_id, 10) : null) : src.parent_id;
    const name = clean(req.body.name) || src.name + ' (copy)';
    // optional find/replace applied to every child name & code, e.g. "A" → "B"
    const find = String(req.body.find ?? ''), repl = String(req.body.replace ?? '');
    const sub = s => find ? s.split(find).join(repl) : s;
    let count = 0;
    async function copy(node, parentId, isRoot) {
      const r = await c.query(
        `INSERT INTO locations (parent_id, type, code, name, sort_order, meta, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$7) RETURNING id`,
        [parentId, node.type, isRoot ? clean(req.body.code ?? sub(node.code), 30) : sub(node.code),
         isRoot ? name : sub(node.name), isRoot ? await nextSort(c, parentId) : node.sort_order, node.meta, req.user.username]);
      count++;
      const kids = await c.query('SELECT * FROM locations WHERE parent_id=$1 AND active ORDER BY sort_order, id', [node.id]);
      for (const k of kids.rows) await copy(k, r.rows[0].id, false);
      return r.rows[0].id;
    }
    const newId = await copy(src, targetParent, true);
    await audit(c, newId, 'duplicate', { from: id }, { count }, req.user.username); await bump(c);
    return { id: newId, count };
  });
  res.json(result);
}));

// ---- CSV export / import ----
const csvCell = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
function parseCsv(text) {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += ch;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows.filter(r => r.some(x => x.trim() !== ''));
}
app.get('/api/export.csv', need('read'), wrap(async (req, res) => {
  const site = (await siteScope(req)) || (req.query.site_id ? parseInt(req.query.site_id, 10) : null);
  const r = await pool.query(
    `SELECT id, path_name, type, code, name, sort_order, active, meta FROM location_paths
      WHERE ($1::int IS NULL OR site_id = $1) ORDER BY sort_key`, [site]);
  const lines = ['id,path,type,code,sort_order,active,meta'];
  for (const x of r.rows) lines.push([x.id, x.path_name, x.type, x.code, x.sort_order, x.active, JSON.stringify(x.meta)].map(csvCell).join(','));
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="alekhya-locations${site ? '-site' + site : ''}.csv"`);
  res.send('﻿' + lines.join('\n'));
}));
// Body: { csv: "path,type,code\nAlekhya Grande › Tower 1 › Floor 1,floor,F01\n...", dry_run: true }
// path segments separated by › or >. Missing parents are created as type 'area' unless they appear earlier in the file.
app.post('/api/import', need('edit'), wrap(async (req, res) => {
  const rows = parseCsv(String(req.body.csv || '').replace(/^﻿/, ''));
  if (rows.length < 2) throw new HttpError(400, 'CSV needs a header row and at least one data row');
  const head = rows[0].map(h => h.trim().toLowerCase());
  const col = n => head.indexOf(n);
  if (col('path') < 0) throw new HttpError(400, 'CSV must have a "path" column');
  const dry = !!req.body.dry_run;
  const log = [];
  try {
    const result = await tx(async c => {
      const types = new Set((await c.query('SELECT code FROM location_types WHERE active')).rows.map(r => r.code));
      let created = 0, updated = 0;
      async function find(parentId, name) {
        const r = await c.query('SELECT * FROM locations WHERE parent_id IS NOT DISTINCT FROM $1 AND lower(name)=lower($2) AND active', [parentId, name]);
        return r.rows[0];
      }
      for (let i = 1; i < rows.length; i++) {
        const r = rows[i]; const get = n => col(n) >= 0 ? (r[col(n)] ?? '').trim() : '';
        const segs = get('path').split(/\s*[›>]\s*/).map(s => clean(s)).filter(Boolean);
        if (!segs.length) { log.push(`row ${i + 1}: empty path, skipped`); continue; }
        const type = get('type') || null;
        if (type && !types.has(type)) throw new HttpError(400, `row ${i + 1}: unknown type "${type}"`);
        // any other column (qc_code, group, area_sqft…) goes into the location's extra fields
        const meta = {};
        for (const h of head) if (!['path', 'type', 'code', 'sort_order', 'id', 'active', 'meta'].includes(h) && get(h)) meta[h] = get(h);
        let parentId = null;
        for (let s = 0; s < segs.length; s++) {
          const last = s === segs.length - 1;
          let node = await find(parentId, segs[s]);
          if (!node) {
            const t = last ? (type || 'area') : (s === 0 ? 'site' : 'area');
            const ins = await c.query(
              `INSERT INTO locations (parent_id, type, code, name, sort_order, created_by, updated_by, meta)
               VALUES ($1,$2,$3,$4,$5,$6,$6,$7) RETURNING *`,
              [parentId, t, last ? clean(get('code'), 30) : '', segs[s],
               last && get('sort_order') !== '' ? parseInt(get('sort_order'), 10) || 0 : await nextSort(c, parentId), req.user.username, last ? meta : {}]);
            node = ins.rows[0]; created++;
            log.push(`row ${i + 1}: + ${segs.slice(0, s + 1).join(' › ')} (${t})`);
          } else if (last && (type && node.type !== type || get('code') && node.code !== get('code'))) {
            await c.query('UPDATE locations SET type=COALESCE($2,type), code=CASE WHEN $3 = \'\' THEN code ELSE $3 END, updated_by=$4, updated_at=now() WHERE id=$1',
              [node.id, type, clean(get('code'), 30), req.user.username]);
            updated++; log.push(`row ${i + 1}: ~ ${segs.join(' › ')} updated`);
          }
          parentId = node.id;
        }
      }
      if (dry) { const e = new Error('dry'); e.dry = { created, updated }; throw e; }
      await audit(c, null, 'import', null, { created, updated, rows: rows.length - 1 }, req.user.username); await bump(c);
      return { created, updated };
    });
    res.json({ ...result, log });
  } catch (e) {
    if (e.dry) return res.json({ dry_run: true, ...e.dry, log });
    throw e;
  }
}));

// ---- audit ----
app.get('/api/audit', need('edit'), wrap(async (req, res) => {
  const id = req.query.location_id ? parseInt(req.query.location_id, 10) : null;
  const lim = Math.min(parseInt(req.query.limit || '100', 10) || 100, 500);
  const r = await pool.query(
    `SELECT a.*, lp.path_name FROM location_audit a LEFT JOIN location_paths lp ON lp.id = a.location_id
      WHERE ($1::int IS NULL OR a.location_id = $1) ORDER BY a.at DESC LIMIT $2`, [id, lim]);
  res.json(r.rows);
}));

// ---------- static + errors ----------
app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0 }));
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => {
  if (err.status) return res.status(err.status).json({ error: err.message });
  if (err.code === '23505' && err.constraint === 'locations_site_code_uq') return res.status(409).json({ error: 'Another site already uses this code — each site needs its own code (apps are linked to a site by it)' });
  if (err.code === '23505') return res.status(409).json({ error: 'A location with this name already exists at this level' });
  if (err.code === '23503') return res.status(409).json({ error: 'That location is referenced elsewhere' });
  console.error(err);
  res.status(500).json({ error: 'Server error' });
});

(async () => {
  await migrate();
  if (process.argv.includes('--migrate-only')) { await pool.end(); return; }
  app.listen(cfg.port, '127.0.0.1', () => console.log(`alekhya-locations on http://127.0.0.1:${cfg.port}`));
})().catch(e => { console.error(e); process.exit(1); });
