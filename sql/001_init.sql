-- Alekhya Locations — schema v1
-- Safe to run repeatedly (idempotent). Lives in the same Postgres database as Alekhya Gate
-- so every app can join on locations.id directly.

CREATE TABLE IF NOT EXISTS location_types (
  code        text PRIMARY KEY,               -- 'site', 'block', 'floor', 'flat', ...
  label       text NOT NULL,                  -- shown in the UI
  sort_order  int  NOT NULL DEFAULT 0,        -- typical depth order (site=10, block=20 ...)
  color       text NOT NULL DEFAULT '#64748b',
  active      boolean NOT NULL DEFAULT true
);

INSERT INTO location_types (code, label, sort_order, color) VALUES
  ('site',   'Site / Project',      10, '#d97706'),
  ('block',  'Block / Tower',       20, '#2563eb'),
  ('floor',  'Floor / Level',       30, '#7c3aed'),
  ('flat',   'Flat / Unit',         40, '#059669'),
  ('villa',  'Villa / House',       40, '#0d9488'),
  ('plot',   'Plot',                40, '#65a30d'),
  ('room',   'Room / Space',        50, '#db2777'),
  ('area',   'Common area / Zone',  45, '#64748b')
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS locations (
  id          serial PRIMARY KEY,
  parent_id   int REFERENCES locations(id) ON DELETE RESTRICT,
  type        text NOT NULL REFERENCES location_types(code) ON UPDATE CASCADE,
  code        text NOT NULL DEFAULT '',        -- short code, e.g. 'T1', 'F05', '501'
  name        text NOT NULL,                   -- display name, e.g. 'Tower 1', 'Flat 501'
  sort_order  int  NOT NULL DEFAULT 0,
  active      boolean NOT NULL DEFAULT true,   -- never hard-delete once other apps use it
  meta        jsonb NOT NULL DEFAULT '{}'::jsonb, -- free fields: area_sqft, facing, bhk ...
  created_by  text,
  updated_by  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (parent_id IS NULL OR parent_id <> id)
);

CREATE INDEX IF NOT EXISTS locations_parent_idx  ON locations(parent_id);
CREATE INDEX IF NOT EXISTS locations_updated_idx ON locations(updated_at);
-- No two active siblings with the same name
CREATE UNIQUE INDEX IF NOT EXISTS locations_sibling_name_uq
  ON locations (COALESCE(parent_id, 0), lower(name)) WHERE active;

-- Full path for every location. Other apps can simply:
--   SELECT * FROM location_paths WHERE site_id = 3 AND type = 'flat';
CREATE OR REPLACE VIEW location_paths AS
WITH RECURSIVE t AS (
  SELECT l.id, l.parent_id, l.type, l.code, l.name, l.sort_order, l.active, l.meta,
         l.id AS site_id, 0 AS depth,
         l.name::text AS path_name,
         NULLIF(l.code, '')::text AS path_code,
         ARRAY[l.id] AS path_ids,
         ARRAY[l.sort_order, l.id] AS sort_key,
         l.active AS branch_active
  FROM locations l WHERE l.parent_id IS NULL
  UNION ALL
  SELECT c.id, c.parent_id, c.type, c.code, c.name, c.sort_order, c.active, c.meta,
         t.site_id, t.depth + 1,
         t.path_name || ' › ' || c.name,
         CASE WHEN c.code = '' THEN t.path_code
              WHEN t.path_code IS NULL THEN c.code
              ELSE t.path_code || '-' || c.code END,
         t.path_ids || c.id,
         t.sort_key || ARRAY[c.sort_order, c.id],
         t.branch_active AND c.active
  FROM locations c JOIN t ON c.parent_id = t.id
)
SELECT id, parent_id, type, code, name, sort_order, active, meta,
       site_id, depth, path_name, path_code, path_ids, sort_key,
       branch_active AS effective_active   -- false if this node OR any parent is inactive
FROM t;

CREATE TABLE IF NOT EXISTS location_audit (
  id           bigserial PRIMARY KEY,
  location_id  int,
  action       text NOT NULL,      -- create / update / move / deactivate / reactivate / delete / bulk / import
  before       jsonb,
  after        jsonb,
  note         text,
  username     text,
  at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS location_audit_loc_idx ON location_audit(location_id);
CREATE INDEX IF NOT EXISTS location_audit_at_idx  ON location_audit(at DESC);

-- Small key/value table so apps can cheaply check "has anything changed?"
CREATE TABLE IF NOT EXISTS location_meta (
  key   text PRIMARY KEY,
  value text NOT NULL
);
INSERT INTO location_meta (key, value) VALUES ('version', '1') ON CONFLICT (key) DO NOTHING;
