# Alekhya Locations

One shared location tree for every Lakshmi Alekhya app — **Gate, Daybook (productivity), QC, JMR, material entry, 360° capture** and whatever comes next.

```
Site / Project      Alekhya Grande
 └ Block / Tower    Tower A
    └ Floor         Floor 5
       └ Flat       Flat 501
          └ Room    Kitchen
 └ Common area      Clubhouse › Gym
```

Admin and PM edit the tree in a simple web page. Every other app only **reads** it and stores the `location_id`.

- **Live (after setup):** https://loc.150-241-247-25.sslip.io
- **Stack:** Node 22 + Express, PostgreSQL 16 (same database as Alekhya Gate), single-file frontend `public/index.html`
- **Logins:** the Gate's `users` table — same usernames and passwords

## Who can do what

| Role | Can |
|---|---|
| `admin` | everything + manage types + hard delete |
| `pm` | add, rename, move, reorder, bulk add, duplicate, import, deactivate |
| anyone else logged in (guard, engineer, supervisor…) | view only |
| other apps' servers with an API key | read only |

Roles are set in `.env` (`EDIT_ROLES`, `ADMIN_ROLES`). To use `pm`, give a user that role in the Gate's admin → users page (add `pm` to the Gate's role list if it isn't there yet).

## Making changes easy

- **Bulk add** — "Floors 1–7, 4 flats each" in one go. Patterns: `{n}` `{nn}` `{nnn}` `{A}` `{p}` (`Flat {p}{nn}` under Floor 5 → Flat 501). Re-running skips anything that already exists. Skip numbers (e.g. 13).
- **Duplicate branch** — copy Tower A to Tower B with find/replace on names and codes.
- **Move** — drag a branch under a new parent; IDs never change, so other apps' records stay linked.
- **Reorder** — ↑ ↓ on siblings.
- **Deactivate** instead of delete — hides the place (and everything inside it) from pickers; old records keep working.
- **CSV import/export** — edit in Excel, check (dry run), then import.
- **Extra fields** per location (area_sqft, facing, BHK…) stored as JSON `meta`.
- **History** — every change is logged with who and when.

## For the other apps (Daybook, QC, JMR, Gate…)

**Rule: store `location_id` (integer). Never store the name as the key** — names get corrected, IDs don't.

### Option A — same server, direct SQL (simplest for apps on this VM)

```sql
-- add to your app's tables
ALTER TABLE daybook_entries ADD COLUMN location_id int REFERENCES locations(id);

-- picker: every active flat in a site, with full path
SELECT id, path_name, path_code FROM location_paths
 WHERE site_id = 1 AND type = 'flat' AND effective_active ORDER BY sort_key;

-- roll up anything to tower level
SELECT b.name AS tower, sum(d.qty)
  FROM daybook_entries d
  JOIN location_paths lp ON lp.id = d.location_id
  JOIN locations b ON b.id = lp.path_ids[2]      -- [1]=site, [2]=block, [3]=floor, [4]=flat
 GROUP BY b.name;
```

`location_paths` (view) columns: `id, parent_id, type, code, name, sort_order, active, effective_active, meta, site_id, depth, path_name, path_code, path_ids, sort_key`.

### Option B — HTTP API

Auth with **either** the user's Gate JWT (`Authorization: Bearer …`, works because both apps share `JWT_SECRET`) **or** `X-Api-Key: <key>` for server-to-server.

| Call | Returns |
|---|---|
| `GET /api/locations?site_id=1&type=flat` | flat list with `path_name`, `path_code`, `path_ids` |
| `GET /api/locations?under=24` | everything inside location 24 |
| `GET /api/locations?parent_id=root` | sites only |
| `GET /api/locations?leaf=1&site_id=1` | lowest-level places only |
| `GET /api/locations?q=501` | search on full path |
| `GET /api/tree?root=1` | nested tree |
| `GET /api/locations/:id` | one location + its children |
| `GET /api/types` | location types |
| `GET /api/version` | `{version}` — increases on every change; cache the tree and re-fetch only when it changes |

Add `include_inactive=1` to see deactivated ones (needed when showing old records).

Browser apps on another origin must be listed in `CORS_ORIGINS`.

## Setup on the Utho server (one time)

```bash
cd /opt/alekhya
git clone git@github.com:ggschaitanya2-ux/alekhya-locations.git
cd alekhya-locations
bash deploy/setup.sh     # copies DATABASE_URL + JWT_SECRET from the Gate .env, installs service, adds Caddy site
```

Updates: `bash deploy/update.sh`
Logs: `journalctl -u alekhya-locations -f`
