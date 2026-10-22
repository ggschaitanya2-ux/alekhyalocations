-- Site scoping: every app deployment is pinned to one site by its code (e.g. AGV = Alekhya Grand).
-- Site codes must be unique so an app's SITE_CODE always points at exactly one site.
CREATE UNIQUE INDEX IF NOT EXISTS locations_site_code_uq
  ON locations (lower(code)) WHERE parent_id IS NULL AND code <> '';

-- true when a location belongs to the site with this code. Apps can use it in a trigger or
-- before saving:  SELECT location_in_site($location_id, 'AGV');
CREATE OR REPLACE FUNCTION location_in_site(loc_id int, site_code text) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM location_paths lp JOIN locations s ON s.id = lp.site_id
     WHERE lp.id = loc_id AND lower(s.code) = lower(site_code))
$$;
