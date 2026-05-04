# Scraping coverage

What we crawl, how, and what it costs. Source code lives in `src/scrapers/`;
the orchestrator is `src/scrapers/index.ts`.

## Sources at a glance

| Source            | Tier     | Runner                                     | Listings/sweep | Notes                                                  |
| ----------------- | -------- | ------------------------------------------ | -------------- | ------------------------------------------------------ |
| Craigslist        | Direct   | `src/scrapers/craigslist.ts`               | 50-200         | 5 boroughs, search + detail HTML.                      |
| Reddit            | Direct   | `src/scrapers/reddit.ts`                   | 5-50           | 17 subs, `/new` + `/search`, Haiku-classified.         |
| Listings Project  | Direct   | `src/scrapers/listings-project.ts`         | 0-100          | Next-data + JSON-LD + HTML fallback.                   |
| HotPads (direct)  | Direct   | `src/scrapers/hotpads.ts`                  | 0-50           | Probes hotpads.com; Apify failover when blocked.       |
| RentHop (direct)  | Direct   | `src/scrapers/renthop.ts`                  | 0-50           | Probes renthop.com; Apify failover when blocked.       |
| Zillow            | Apify    | `maxcopell~zillow-detail-scraper`          | 100-500        | Detail records: photos, agent, price.                  |
| StreetEasy        | Apify    | `epctex~streeteasy-scraper`                | 100-400        | NYC-native primary inventory.                          |
| Trulia            | Apify    | `epctex~trulia-scraper`                    | 50-200         | Same vendor pattern.                                   |
| Apartments.com    | Apify    | `epctex~apartments-scraper`                | 50-200         | Same vendor pattern.                                   |
| Realtor.com       | Apify    | `epctex~realtor-scraper`                   | 50-300         | Often unique vs Zillow.                                |
| Redfin            | Apify    | `epctex~redfin-scraper`                    | 30-150         | Some unique inventory.                                 |
| HotPads (Apify)   | Apify    | `epctex~hotpads-scraper`                   | 50-200         | Failover for direct probe.                             |
| RentHop (Apify)   | Apify    | `epctex~renthop-scraper`                   | 30-120         | NYC-focused; hopscore freshness signal.                |
| Twitter / X       | Apify    | `apidojo~twitter-scraper-lite`             | 10-50          | Curated NYC listing accounts; pre-filtered to offers.  |

Direct + Apify rows for the same source dedupe at the orchestrator layer
(`source_url` is unique). Direct is preferred when it works because it costs
zero; Apify is the failover when the direct probe is blocked.

## Reddit subs (17 total)

```
General NYC:          NYCapartments, AskNYC, HousingNYC
Per-borough:          Brooklyn, Manhattan, Queens
Neighborhood-deep:    Williamsburg, Bushwick, CrownHeights, BedStuy,
                      ParkSlope, Astoria, LongIslandCity,
                      UpperEastSide, UpperWestSide
Student sublets:      Columbia, NYU, CUNY
```

Each sub is hit twice per sweep: `/new.json?limit=50` and
`/search.json?q=apartment OR rent OR sublet OR lease&restrict_sr=on&sort=new`.
A regex pre-filter drops ISO / advice / discussion posts before paying for a
Haiku classification call. Classification + extraction is concurrency-capped
at `p-limit(4)` to bound Anthropic spend.

## Apify budget mode

`APIFY_BUDGET_MODE` env var controls per-actor search fan-out:

| Mode         | Per actor | Default trigger                                  |
| ------------ | --------- | ------------------------------------------------ |
| `light`      | 1 search  | `APIFY_TOKEN` missing                            |
| `standard`   | 4 borough searches | `APIFY_TOKEN` set, no override        |
| `aggressive` | up to 12 (4 borough + ≤3 bed + ≤5 neighborhood) | explicit  |

Variants in `aggressive` mode are profile-aware: bed-counts come from the
intersection of `beds_min..beds_max` across `src/profiles/*.json`, and
neighborhood searches use the union of `preferred_areas` (top 5).

### Cost estimate (per sweep)

Personal Apify $5/mo plan ≈ 100 actor-hours/month.

| Mode         | Actor runs / sweep | Approx Apify cost / sweep | Approx monthly @ every-2h |
| ------------ | ------------------ | ------------------------- | ------------------------- |
| `light`      | 9                  | $0.10-0.20                | $1-3                      |
| `standard`   | 32                 | $0.50-1.00                | $5-12                     |
| `aggressive` | 96                 | $1.50-2.50                | $18-30                    |

Anthropic-side cost is dominated by Reddit Haiku classification: ≈30-100
classify calls per sweep (cap=4 concurrent), ≈$0.005 each → ≈$0.15-0.50/sweep
worst case. Monthly @ every-2h: ≈$2-6.

## Failover strategy (3-tier)

For any URL we want to ingest:

1. **Direct fetch** with browser UA + cheerio. Works for Craigslist, Reddit,
   Listings Project, sometimes HotPads / RentHop.
2. **Browserless headless Chrome** (`src/scrapers/browserless.ts`). Optional;
   gated on `BROWSERLESS_TOKEN`. Used for sites that block direct fetch but
   don't have an Apify actor.
3. **Apify actor**. Primary path for Zillow / StreetEasy / Trulia / Apartments
   / Realtor / Redfin / HotPads / RentHop / Twitter. Gated on `APIFY_TOKEN`.

Each tier returns `[]` (logged warning) when its token is missing. No tier
ever throws to the orchestrator.

## Env vars

The full env-var set used by the scrapers:

| Var                       | What it does                                                |
| ------------------------- | ----------------------------------------------------------- |
| `APIFY_TOKEN`             | Apify auth. Without it, all `*:apify` runners no-op.        |
| `APIFY_BUDGET_MODE`       | `light` / `standard` / `aggressive`. Default = budget rule. |
| `APIFY_ZILLOW_ACTOR`      | Override the default Zillow actor ID.                       |
| `APIFY_STREETEASY_ACTOR`  | Override the default StreetEasy actor ID.                   |
| `APIFY_TRULIA_ACTOR`      | Override the default Trulia actor ID.                       |
| `APIFY_APARTMENTS_ACTOR`  | Override the default Apartments.com actor ID.               |
| `APIFY_REALTOR_ACTOR`     | Override the default Realtor.com actor ID.                  |
| `APIFY_REDFIN_ACTOR`      | Override the default Redfin actor ID.                       |
| `APIFY_HOTPADS_ACTOR`     | Override the default HotPads actor ID.                      |
| `APIFY_RENTHOP_ACTOR`     | Override the default RentHop actor ID.                      |
| `APIFY_TWITTER_ACTOR`     | Override the default Twitter/X actor ID.                    |
| `APIFY_TWITTER_HANDLES`   | Comma-separated handles to track (default: 5 NYC accounts). |
| `BROWSERLESS_TOKEN`       | Browserless headless Chrome auth (optional middle tier).    |
| `ANTHROPIC_API_KEY`       | Required for Reddit classification + listing extraction.    |

> **Note:** `.env.local.example` is permission-locked at the repo level. Add
> any new env vars there manually — this file is the canonical reference for
> which vars exist, but it is not the source of truth.

## Adding a new source

1. **Decide tier.** Direct first if the site doesn't block; otherwise Apify.
2. **Write the runner.** Each scraper exports `async function fetchX():
   Promise<NewListing[]>`. Failures are logged + return `[]`, never thrown.
3. **Add to `Source` union.** Append the new tag in `src/types.ts` `SOURCES`
   array. Add a label in `src/lib/format.ts` `SOURCE_LABEL`.
4. **Register in orchestrator.** Add an entry to `SOURCES` in
   `src/scrapers/index.ts` with `{ name, label, fn }`.
5. **Document.** Add a row to the table at the top of this file.
6. **Validate.** `npx tsc --noEmit` and `npm run build` before commit.

## Things we wanted but punted on

- **Facebook Marketplace.** Requires login + 2FA; no free-tier-friendly Apify
  actor that reliably bypasses. Flagged for paid-tier consideration only.
- **NYC.gov housing locator.** Probed; affordable-housing-only and lottery
  flow doesn't map cleanly to ranked-feed UX. Reconsider as a separate
  `nyc-affordable` source if/when we want a dedicated panel.
- **Naked Apartments.** Defunct (redirects to Zillow Group). Skipped.
- **Listings Project RSS.** Probed `/feed`; returns 404 — no public RSS.
- **Bushwick BK newsletter.** Manual list, not a public feed; skipped for v0.
