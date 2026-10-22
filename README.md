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

- **Repo:** https://github.com/ggschaitanya2-ux/alekhyalocations (private) — separate from Alekhya Gate
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

## One app per site — how apps are pinned to their site

Each site has its own Daybook, QC, JMR… deployment. Every site has a **unique site code** (Alekhya Grand = `AGV`), and each app deployment is configured with it:

1. In the app's own `.env`: `SITE_CODE=AGV`
2. Give that deployment its own key here, locked to the site: `API_KEYS=daybook-grand:<key>:AGV`
3. A site-locked key can only see that site: lists, tree, details and checks never return another site's locations, and asking for another site is refused.
4. Before saving a record, the app confirms the location is in its site — `GET /api/check?id=<location_id>` (or in SQL `SELECT location_in_site($1, 'AGV')`).

Because `location_id` is unique across all sites, a record can never point at the wrong project, and reports can still be combined across sites later.

## For the other apps (Daybook, QC, JMR, Gate…)

**Rule: store `location_id` (integer). Never store the name as the key** — names get corrected, IDs don't.

### Option A — same server, direct SQL (simplest for apps on this VM)

```sql
-- add to your app's tables
ALTER TABLE daybook_entries ADD COLUMN location_id int REFERENCES locations(id);

-- picker: every active flat in a site, with full path
SELECT id, path_name, path_code FROM location_paths
 WHERE site_id = 1 AND type = 'flat' AND effective_active ORDER BY sort_key;

-- roll up anything to floor level (pick the ancestor by TYPE, not by position:
-- sites differ — Alekhya Grand has no tower level, Grande has towers)
SELECT f.name AS floor, sum(d.qty)
  FROM daybook_entries d
  JOIN location_paths lp ON lp.id = d.location_id
  JOIN locations f ON f.id = ANY(lp.path_ids) AND f.type = 'floor'
 GROUP BY f.name, f.sort_order ORDER BY f.sort_order;
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
| `GET /api/sites` | sites (only its own for a site-locked key) |
| `GET /api/check?id=123` | `{ok, active, path_name}` — is this location in my site? |
| `?site=AGV` on any list | limit to one site (automatic for site-locked keys) |
| `GET /api/version` | `{version}` — increases on every change; cache the tree and re-fetch only when it changes |

Add `include_inactive=1` to see deactivated ones (needed when showing old records).

Browser apps on another origin must be listed in `CORS_ORIGINS`.

## Setup on the Utho server (one time)

```bash
cd /opt/alekhya
git clone https://github.com/ggschaitanya2-ux/alekhyalocations.git alekhya-locations   # same GitHub login/key method the Gate repo uses
cd alekhya-locations
bash deploy/setup.sh     # copies DATABASE_URL + JWT_SECRET from the Gate .env, installs service, adds Caddy site
```

Updates: `bash deploy/update.sh`

### Starting data
`setup.sh` loads these on a fresh install. To load one by hand: `node scripts/seed.js seed/<file>.csv` (safe to re-run — existing locations are kept, nothing is deleted).

| File | Site (code) | What's in it |
|---|---|---|
| `seed/alekhya-grand.csv` | Alekhya Grand, Vijayawada (`AGV`) | From the QC app: Floors 1–5, flats 101–506, 17 rooms per flat — 546 locations. Single building, so no tower level (Site › Floor › Flat › Room). Each keeps its QC code (`qc_code`, e.g. `AG-T1-304-POOJA`) and QC room group (`group`). |
| `seed/alekhya-grande.csv` | Alekhya Grande, Kogilu Road, Bangalore (`AG`) | **Sample layout** from the demo (Towers A/B, basement + 7 floors × 4 flats, clubhouse) — correct it before any app uses it. |
| `seed/vuyyuru-layout.csv` | Vuyyuru Layout (`VL`) | Plots 1–146. |

Alekhya Grand and Alekhya Grande are different projects.
