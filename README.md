# homeSnatch

A personal NYC apartment-hunting tool for two roommates. Reads two profiles, ingests listings from Craigslist / Reddit / Listings Project (and pasted single URLs from Zillow / StreetEasy / Trulia), enriches with NYC Open Data (subway distance, HPD violations, rent stabilization, neighborhood vibe from 311 + Parks + liquor licenses), and ranks them with a 2-line LLM rationale grounded in the actual facts.

Not a public product. No signup, no marketing surface, no pricing. Two people deploy it on a hard-to-guess Vercel subdomain and use it to make a real-life decision.

> Screenshots: TODO.

## Quickstart

```bash
# 1. Clone + env
cp .env.local.example .env.local
# fill in DATABASE_URL, SUPABASE_URL, SUPABASE_ANON_KEY, ANTHROPIC_API_KEY,
# (optional) APIFY_TOKEN, BROWSERLESS_TOKEN

# 2. Provision Supabase
#    Create a new project at https://supabase.com → Project Settings → Database.
#    Paste the connection string into DATABASE_URL.
#    Project API keys → SUPABASE_URL + SUPABASE_ANON_KEY.

# 3. Anthropic key
#    https://console.anthropic.com → API Keys → Create. Paste into ANTHROPIC_API_KEY.

# 4. (Optional) Apify token for Zillow / StreetEasy / Trulia bypass
#    https://apify.com → Settings → Integrations → API Token.
#    Free tier ships with $5/mo credit, plenty for personal use.

# 5. Install
npm install

# 6. Push schema
npm run db:push

# 7. Seed NYC Open Data (NTAs + subway stations + HPD + rent stabilized + vibes)
#    Takes ~5 minutes; hits 311, parks, licenses, Overpass.
npm run seed

# 8. Edit profiles
#    src/profiles/inaan.json
#    src/profiles/mekonnen.json
#    Replace every "FILL_ME ..." string. Or visit /setup once running.

# 9. Run
npm run dev
# open http://localhost:3000

# 10. Deploy (Vercel)
#     Connect the repo, set env vars in the Vercel dashboard, then:
vercel --prod
```

## Architecture

Three tiers, in order:

1. **Ingestion** — `src/scrapers/<source>.ts` for periodic crawls (Craigslist, Reddit, Listings Project), plus `src/app/api/ingest` for paste-a-URL. Failover ladder: direct fetch → Browserless headless Chrome → Apify actor (for Zillow / StreetEasy / Trulia / Apartments.com).
2. **Enrichment + scoring** — `src/agents/score.ts` calls Sonnet 4.6 with the joint constraints + listing facts + nearest subway + neighborhood vibe + HPD + stabilization, and emits a 0-100 score plus a one-line headline and an optional one-line concern.
3. **UI** — Next.js 15 App Router. Server Components by default. Bento-grid feed (`/`), single-listing detail with streaming follow-up Q&A (`/listing/[id]`), paste-URL ingest (`/add`), and an optional setup wizard (`/setup`).

See [PRODUCT.md](./PRODUCT.md) for voice, anti-references, and out-of-scope. See [CLAUDE.md](./CLAUDE.md) for the file-ownership map and conventions.

### Cost (personal use, two roommates, ~6 weeks)

- Anthropic Sonnet 4.6 with prompt caching: **$2-5/mo** at the expected scoring volume (~500 listings/week, plus a few dozen `/api/ask` follow-ups).
- Vercel: **free** (hobby tier handles streaming + cron just fine).
- Supabase: **free** (Postgres rows fit comfortably in the 500MB limit).
- Apify: **$5/mo** via the free-tier credit; only consumed when Zillow / StreetEasy / Trulia URLs get pasted.

### Honest limitations

- **Zillow / StreetEasy / Trulia**: bypass quality is only as good as the Apify community actor. Expect occasional empty extractions; reach for the URL again or paste the listing manually if the actor flakes.
- **Listings Project**: extraction is heuristic-based — the page structure changes a few times a year, and we don't pay for their API.
- **Commute estimate**: `walk_to_nearest_station + stops * 2 min + transfer_penalty`. Not Google-Maps-accurate. Good enough for a rationale line, not for door-to-door minute precision.
- **HPD / rent stabilization match**: substring-based against the open-data tables' raw `address` field. Misses listings without an address (most of Reddit, some of Craigslist). Never reports a false positive on a building it can't see.
- **Neighborhood vibe**: `family_score` is left null in v0; computing it needs an ACS Census tract join we punted.

## Where things live (the file-ownership map at a glance)

- `src/app/api/profile`, `src/app/api/profile/[slug]` — profile CRUD
- `src/app/api/geocode` — address → lat/lng/neighborhood (Nominatim, 24h cache, 5 rps rate limit)
- `src/app/api/ask` — streaming SSE follow-up Q&A
- `src/app/api/save` — toggle save state per saver
- `src/app/api/ingest` — paste-a-URL extraction
- `src/app/api/cron/scrape` — periodic crawler entry point (Vercel cron)
- `src/lib/listing-helpers.ts` — `getRankedFeed`, `getListingDetail`, address-based HPD + stabilization helpers
- `src/lib/profile-set.ts`, `src/lib/profile-match.ts` — joint-constraint merge + rule-based pre-match
- `src/lib/geocode.ts`, `src/lib/subway.ts`, `src/lib/nyc-vibes.ts` — open-data primitives
- `src/agents/extract.ts`, `src/agents/score.ts` — pure functions; DB writes happen in their callers
- `src/db/schema.ts` — Drizzle. The contract.
- `src/profiles/*.json` — joint-decision inputs. Edited as code, version-controlled.
