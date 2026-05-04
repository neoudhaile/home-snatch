# NYC Housing Finder — Plan

## Context

You and Mekonnen need a place in NYC. You want a tool — not a service subscription — that ingests apartment listings from the open web, enriches them with NYC's free public data (subway proximity, rent stabilization, HPD violations, neighborhood "vibe" signal), takes profile inputs ("Inaan: quiet, walkable, ≤25 min to FiDi, $X budget"; "Mekonnen: nightlife-tolerant, …"), and ranks listings against the joint criteria with a 2-line LLM-written rationale per result. The UI should look genuinely good — leveraging the `/impeccable` and `/ui-ux-pro-max` skills installed today. Free DB, free hosting, one-command deploy. Public repo at `damarajui/nyc-housing-finder`.

**Honest constraint surfaced from probes:** Zillow / StreetEasy / Trulia / Apartments.com are all CloudFront/Akamai-403 to direct fetches. Crawling them for free at any volume is a maintenance treadmill. The viable strategy:

1. **Crawl what's open**: Craigslist NYC (HTML, 200 OK with a browser UA), Reddit `r/NYCapartments` JSON, Listings Project (TBD — verify path during Phase 0).
2. **Enrich aggressively** with NYC Open Data — that's where this product gets its edge over "just refresh Zillow."
3. **On-demand single-URL ingest** for blocked sources: paste any Zillow/StreetEasy URL → we fetch once (low bot-detection trip risk) → Claude extracts the listing into our schema. You scout, the agent scores.

This is honest about what "scrape Zillow" means in 2026 and turns the limitation into a feature: the agent's value isn't crawl breadth, it's ranking + match quality on whatever you funnel in.

## Stack

- **Frontend**: Next.js 15 (App Router) + Tailwind + shadcn/ui
- **DB**: Supabase Postgres (free 500 MB tier; full-text search + PostGIS for geo queries — better fit than Firestore for filter/rank workloads)
- **Hosting**: Vercel (free Hobby tier)
- **Cron**: Vercel Cron (hourly scrape job)
- **LLM**: Anthropic API (Claude Sonnet 4.6 for ranking, prompt caching on the system + neighborhood-vibe context)
- **ORM**: Drizzle (small, type-safe, great with Next App Router)
- **Auth**: skip for v1 — hard-to-guess Vercel subdomain. Add Supabase Auth in Phase 2 if needed.
- **Repo**: `damarajui/nyc-housing-finder`, public (free GH Actions for public)

## Phase 0 — Scaffold (~30 min one-shot)

1. `pnpm create next-app nyc-housing-finder --ts --tailwind --app --src-dir --import-alias '@/*'`
2. `pnpm dlx shadcn@latest init` (neutral palette to start; we'll lock tokens during `/impeccable teach`)
3. `pnpm add drizzle-orm @supabase/supabase-js postgres zod @anthropic-ai/sdk lucide-react date-fns`
4. `pnpm add -D drizzle-kit tsx`
5. Create Supabase project `nyc-housing-finder` (free tier) → grab DB URL + anon key → `.env.local`
6. Init repo, push to `damarajui/nyc-housing-finder` (public)
7. Probe Listings Project's actual public path (root or `/search`) and add to scrape list if reachable

## Phase 1 — One-shot v0 (~2-3 hours of agent build)

### Critical files to create

| File | Purpose |
|---|---|
| `PRODUCT.md` | Required by `/impeccable` — users, register=`product`, brand voice, anti-references |
| `DESIGN.md` | Generated via `/impeccable teach` after PRODUCT.md is written |
| `src/db/schema.ts` | Drizzle schema (listings, profiles, scores, nyc_open_data tables) |
| `src/db/seed.ts` | Seed NYC Open Data: subway entrances (`hvnk-aabd`), NTA polygons (`9nt8-h7nd`), rent-stabilized buildings (`tdrx-mwj7`), HPD violations (`wvxf-dwi5` — last 12 mo) |
| `src/profiles/inaan.json` | Hardcoded — budget, must-have, deal-breakers, vibes (1-10 sliders), commute targets |
| `src/profiles/mekonnen.json` | Same — you fill in his data |
| `src/scrapers/craigslist.ts` | Fetch each borough subdomain (`newyork`, `brooklyn`, `queens`, `bronx`, `statenisland.craigslist.org`) `/search/apa` w/ Safari UA. Parse cards: title, price, beds, address, posted-date, URL. Politely throttled (1 req / 3s) |
| `src/scrapers/reddit.ts` | `https://www.reddit.com/r/NYCapartments/new.json?limit=100` — LLM-classify "is this a listing?" |
| `src/scrapers/manual-url.ts` | POST `/api/ingest`: takes any URL, server-side fetches w/ browser UA, hands HTML to Claude w/ extraction prompt → returns parsed listing |
| `src/agents/score.ts` | Per-listing scoring agent. Inputs: listing + profile-pair + neighborhood-vibe-vector. Output: `{score: 0-100, headline: 1-line, concerns: 1-line}`. Prompt-cached on system + vibe vector |
| `src/agents/extract.ts` | Listing extraction agent for Reddit posts + manual URL HTML |
| `src/lib/nyc-vibes.ts` | Compute per-NTA vibe vector from Open Data: noise (311 complaints/sqkm), walkability (subway entrance density), greenness (parks polygon overlap), nightlife proxy (Yelp counts — *deferred to Phase 2 unless we add a Yelp key*) |
| `src/app/page.tsx` | Feed page — ranked listings, card grid, score chip, 2-line LLM digest, source badge |
| `src/app/listing/[id]/page.tsx` | Detail — full description, HPD violation count for the building, subway dist, "ask Claude" textbox |
| `src/app/add/page.tsx` | Paste-URL ingest flow with live preview |
| `src/app/api/cron/scrape/route.ts` | Vercel Cron handler — runs Craigslist + Reddit scrapers, scores new listings |
| `vercel.json` | `crons: [{ path: "/api/cron/scrape", schedule: "0 */2 * * *" }]` |

### Build order

1. **Scaffold + DB** (Phase 0 above)
2. **Write PRODUCT.md** (you write this — register=product, users=Inaan+Mekonnen, anti-references=Zillow/StreetEasy chrome, brand voice). Keep ≥200 chars or `/impeccable` will block.
3. **`/impeccable teach`** → generates DESIGN.md (tokens, type scale, components). Lock OKLCH palette here.
4. **`/ui-ux-pro-max --design-system "housing search tool product-first restrained" --persist -p "NYC Housing"`** → cross-references shadcn-stack-specific guidance and writes `design-system/MASTER.md`.
5. **Seed NYC Open Data** (`pnpm tsx src/db/seed.ts`) — one-time, ~5 min
6. **Craigslist scraper** + 1 score-rank pass — proves the pipeline end-to-end with real data
7. **`/impeccable shape "feed page — ranked listings with score, vibe chips, neighborhood, source badge"`** → confirm shape brief before writing UI
8. **`/impeccable craft`** → builds the feed page
9. **Detail page + add-by-URL page** (also via `craft`)
10. **`/impeccable live`** → iterate on the feed card variants in browser
11. **`/impeccable polish` + `/impeccable audit`** → final pass + a11y check
12. **Deploy** (`vercel --prod`)

### Reused / external functions to lean on

- shadcn primitives: `Card`, `Badge`, `Tabs`, `Sheet`, `ScrollArea`, `Form`
- Drizzle: `gte / lte / inArray` filter composition
- `zod` schemas for the listing extraction prompt's structured output
- Anthropic SDK: `client.messages.create({ system: [{type:'text', text:'...', cache_control:{type:'ephemeral'}}] })` — prompt cache on the system + vibe vector
- NYC Open Data Socrata API — no auth needed for our query rate; SoQL `?$where=`, `?$select=`, `?$limit=`

## Phase 2 — Iteration (post-one-shot)

- Setup UI for profiles + vibe sliders (replaces JSON files)
- NYC map view w/ NTA vibe heatmap overlay (Mapbox free tier or maplibre + OSM tiles)
- Reddit listing extraction tightened
- Listings Project source confirmed and added
- `/saved` + side-by-side compare
- Yelp Fusion API for nightlife/cafe vibe scoring (free 5k req/day)
- Email alerts via Resend (free 3k/mo)
- Auth via Supabase if you decide to share

## Verification

**Local end-to-end**:
1. `pnpm dev` → site renders empty feed
2. `pnpm tsx src/db/seed.ts` → 472 subway entrances + 263 NTAs + ~40k rent-stab buildings + 12-mo HPD violations populated
3. `pnpm tsx src/scrapers/craigslist.ts` → ≥50 fresh Craigslist listings ingested
4. Reload `/` → ranked listings appear with score chips + 2-line LLM rationale
5. Spot-check: top-ranked listing's rationale should reference *your* actual must-have or vibe (proves agent is reading the profile, not making it up)
6. POST a Zillow URL to `/api/ingest` → listing parsed and scored
7. `/impeccable audit src/app` → 0 critical a11y violations

**Production**:
- Vercel deploy succeeds, cron runs every 2h
- Spot-check 3 score rationales 24h later → still grounded, not LLM-confabulated
- Total Anthropic spend after 24h < $2 (rough budget for personal use)

## Risks + mitigations

- **Craigslist bans the IP** → switch to GH Actions cron (rotating IPs per run); throttle to ≥3s between requests; respect robots.txt for `/search/apa` (allowed)
- **Geocoding gap** — Craigslist listings often have neighborhood string but not lat/lng. Use Nominatim (OSM, free, 1 req/s rate) or a one-off pre-load of Zillow's NYC neighborhood-name → lat/lng table.
- **LLM cost creep** — prompt-cache the system prompt; cache the per-listing extraction by URL hash; only re-score when profile or listing changes
- **Profile drift** — when you change `inaan.json` or `mekonnen.json`, invalidate cached scores (key includes profile-hash)
- **`/impeccable` setup gates** — it requires a real PRODUCT.md (≥200 chars) before it'll craft anything. Don't skip this step or the design output reverts to generic.

## What's deliberately out of scope for v0

- Auth / multi-user
- Mobile-native app
- Push/email alerts
- StreetEasy / Zillow / Trulia crawling (only manual URL ingest)
- Map view (Phase 2)
- Saved + compare (Phase 2)
- Setup UI (Phase 2 — until then, edit `src/profiles/*.json`)
