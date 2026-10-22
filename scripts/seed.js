// Load a location CSV straight into the database (safe to re-run).
//   node scripts/seed.js seed/alekhya-grand.csv
// CSV columns: path (levels separated by ›), type, code, and any extra columns (qc_code, group…)
// which are stored in the location's extra fields (meta). Existing locations are matched by
// name under the same parent and only get missing extra fields added — nothing is deleted.
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const { Pool } = require('pg');

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

(async () => {
  const file = process.argv[2];
  if (!file) { console.error('usage: node scripts/seed.js <file.csv>'); process.exit(1); }
  const rows = parseCsv(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  const head = rows.shift().map(h => h.trim());
  const ix = n => head.indexOf(n);
  const extra = head.filter(h => !['path', 'type', 'code', 'sort_order'].includes(h));
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const c = await pool.connect();
  let created = 0, updated = 0;
  try {
    await c.query('BEGIN');
    const sortNext = new Map();
    for (const r of rows) {
      const segs = r[ix('path')].split(/\s*[›>]\s*/).map(s => s.trim()).filter(Boolean);
      const type = r[ix('type')].trim(), code = (r[ix('code')] || '').trim();
      const meta = {}; for (const h of extra) if ((r[ix(h)] || '').trim()) meta[h] = r[ix(h)].trim();
      let parentId = null;
      for (let s = 0; s < segs.length; s++) {
        const last = s === segs.length - 1;
        const f = await c.query('SELECT * FROM locations WHERE parent_id IS NOT DISTINCT FROM $1 AND lower(name)=lower($2) AND active', [parentId, segs[s]]);
        let node = f.rows[0];
        if (!node) {
          if (!last) throw new Error(`Parent "${segs.slice(0, s + 1).join(' › ')}" must come before its children in the file`);
          const key = String(parentId);
          const sort = (sortNext.get(key) ?? (await c.query('SELECT COALESCE(MAX(sort_order),0) s FROM locations WHERE parent_id IS NOT DISTINCT FROM $1', [parentId])).rows[0].s) + 10;
          sortNext.set(key, sort);
          node = (await c.query(
            `INSERT INTO locations (parent_id, type, code, name, sort_order, meta, created_by, updated_by)
             VALUES ($1,$2,$3,$4,$5,$6,'seed','seed') RETURNING *`, [parentId, type, code, segs[s], sort, meta])).rows[0];
          created++;
        } else if (last && Object.keys(meta).some(k => node.meta[k] === undefined)) {
          await c.query(`UPDATE locations SET meta = $2 || meta, updated_at = now(), updated_by = 'seed' WHERE id = $1`, [node.id, meta]);
          updated++;
        }
        parentId = node.id;
      }
    }
    await c.query(`INSERT INTO location_audit (action, after, username) VALUES ('import', $1, 'seed')`, [JSON.stringify({ file, created, updated })]);
    await c.query(`UPDATE location_meta SET value = (value::bigint + 1)::text WHERE key = 'version'`);
    await c.query('COMMIT');
    console.log(`${file}: ${created} created, ${updated} updated, ${rows.length - created - updated} already there`);
  } catch (e) { await c.query('ROLLBACK'); console.error('Nothing saved —', e.message); process.exitCode = 1; }
  finally { c.release(); await pool.end(); }
})();
