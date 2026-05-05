-- Extra index recommendations for homeSnatch.
--
-- HAND-RUN ONLY. Drizzle doesn't manage these — schema.ts is owned by another
-- agent and we can't add `index()` declarations there. Apply via:
--   psql "$DATABASE_URL" -f drizzle/extra-indexes.sql
--
-- All statements use `IF NOT EXISTS` and `CONCURRENTLY` so they're safe to
-- re-run and don't take an ACCESS EXCLUSIVE lock on the underlying tables.
-- (Note: CONCURRENTLY can't run inside an explicit transaction; psql -f is
-- fine because each statement runs in its own implicit transaction.)
--
-- Why these indexes:
--
-- 1. listings_active_posted_at_idx — covers getRankedFeed's hot path
--      WHERE is_active = true AND posted_at >= cutoff ORDER BY posted_at DESC
--    The existing posted_at_idx + is_active_idx are single-column; the planner
--    has to choose one and filter the other. A composite covers the lookup +
--    sort in one index scan. Partial WHERE is_active=true keeps it small
--    (~80% smaller than full).
--
-- 2. listings_active_partial_posted_at_idx — same idea, partial form.
--
-- 3. hpd_violations_address_lower_idx — supports lower(address) ILIKE matches
--    used by buildHpdByListingId (pre-filter step). Functional index avoids
--    case-fold on every row.
--
-- 4. hpd_violations_address_trgm_idx — trigram GIN for substring ILIKE
--    matching. Requires `CREATE EXTENSION pg_trgm` (idempotent below).
--    Without this, ILIKE '%foo%' falls back to seq scan; with it, the planner
--    can use the trgm index for selective predicates.
--
-- 5. rent_stabilized_buildings_address_lower_idx + trgm — same as HPD.
--
-- 6. scores_listing_computed_at_idx — supports the LATERAL "latest score per
--    listing" subquery in getRankedFeed (ORDER BY computed_at DESC LIMIT 1).
--    Existing `scores_pk` is on (listing_id, profile_set_hash) which doesn't
--    help that ORDER BY.
--
-- 7. saved_listings_saved_by_idx — getSavedFor filters by saved_by + orders
--    by saved_at DESC. The existing PK is (listing_id, saved_by); a separate
--    (saved_by, saved_at DESC) index covers the saver-scoped read.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 1 + 2: feed-query coverage.
CREATE INDEX CONCURRENTLY IF NOT EXISTS listings_active_posted_at_idx
  ON listings (is_active, posted_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS listings_active_partial_posted_at_idx
  ON listings (posted_at DESC)
  WHERE is_active = true;

-- 3 + 4: HPD address fuzzy match.
CREATE INDEX CONCURRENTLY IF NOT EXISTS hpd_violations_address_lower_idx
  ON hpd_violations (lower(address));

CREATE INDEX CONCURRENTLY IF NOT EXISTS hpd_violations_address_trgm_idx
  ON hpd_violations USING gin (address gin_trgm_ops);

-- 5: rent-stab address fuzzy match.
CREATE INDEX CONCURRENTLY IF NOT EXISTS rent_stabilized_buildings_address_lower_idx
  ON rent_stabilized_buildings (lower(address));

CREATE INDEX CONCURRENTLY IF NOT EXISTS rent_stabilized_buildings_address_trgm_idx
  ON rent_stabilized_buildings USING gin (address gin_trgm_ops);

-- 6: latest-score-per-listing lookup.
CREATE INDEX CONCURRENTLY IF NOT EXISTS scores_listing_computed_at_idx
  ON scores (listing_id, computed_at DESC);

-- 7: saver-scoped saved_listings read.
CREATE INDEX CONCURRENTLY IF NOT EXISTS saved_listings_saved_by_idx
  ON saved_listings (saved_by, saved_at DESC);

-- Verify (optional): list created indexes for sanity.
-- SELECT indexname, tablename FROM pg_indexes
-- WHERE schemaname = 'public'
--   AND tablename IN ('listings', 'scores', 'saved_listings',
--                     'hpd_violations', 'rent_stabilized_buildings')
-- ORDER BY tablename, indexname;
