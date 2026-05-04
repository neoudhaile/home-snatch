# homeSnatch — Project rules for Claude Code

## What this is

NYC apartment-hunting tool for Inaan + Mekonnen. Reads two profiles in `src/profiles/`, ingests listings from open sources (Craigslist, Reddit, Listings Project) plus on-demand single-URL paste (Zillow / StreetEasy / Trulia / etc.), enriches with NYC Open Data, and ranks against the joint criteria with an LLM-written rationale per listing.

Read `PRODUCT.md` for users + voice + anti-references. Read `DESIGN.md` for tokens + components.

## Architecture (read before touching anything)

- **Frontend**: Next.js 15 App Router + Tailwind + shadcn/ui (already initialized). React Server Components by default; Client Components only when interactive state is needed.
- **DB**: Supabase Postgres via Drizzle ORM (`src/db/schema.ts` is the canonical schema; never freelance schema changes).
- **LLM**: Anthropic SDK (`src/lib/anthropic.ts`). Use Haiku 4.5 for cheap extraction, Sonnet 4.6 for scoring + reasoning. Always prompt-cache the system message and the neighborhood-vibe context.
- **Scrapers**: `src/scrapers/<source>.ts` — each exports `async function fetch(): Promise<NewListing[]>`. Browser User-Agent header always.
- **Ingestion failover (3-tier)**: For any URL, try in order:
  1. Direct fetch with browser UA + `cheerio` (works for Craigslist HTML, Reddit JSON, Listings Project, simple sites).
  2. Browserless.io headless Chrome (failover for sites that block direct fetch but don't have an Apify actor) — `BROWSERLESS_TOKEN` optional.
  3. Apify actor — primary path for Zillow / StreetEasy / Trulia / Apartments.com (use community actors). `APIFY_TOKEN` already in `~/.confido.env`.
  Each tier is gated on its env var; missing token = skip that tier with a logged warning.

- **Aesthetic**: Bento grid, photo-led, asymmetric. Larger cells for higher-scored listings. Vibe chips inline. Score badge prominent. Freshness badge ("3h ago", "yesterday", "5d ago"). Source badge subtle.
- **Agents**: `src/agents/extract.ts` (HTML/JSON → NewListing) and `src/agents/score.ts` (Listing + ProfileSet → Score). Pure functions; DB writes happen in their callers.

## Quality bar — non-negotiable

The user's stated bar: "It needs to be like fucking amazing." Concretely:

- Every listing surfaces **photos**, **contact info** (phone / email / agent name / agency), **application procedure** (URL, fee, required docs, broker fee), **posted-at recency**.
- Default freshness window: 14 days. Anything older than that is hidden by default but still in the DB.
- Listings without contact info or photos are *deprioritized*, not hidden — flag the gap explicitly in the UI.
- Score rationales must reference *specific* facts from the listing (e.g. "4 stops to FiDi on the F, dishwasher, $200 under your stretch budget"), never generic ("good match", "high score").

## File ownership map (parallel-agent build)

When dispatching subagents, each owns specific paths and must not touch others':

| Owner | Paths |
|---|---|
| **Data agent** | `src/scrapers/`, `src/db/seed.ts`, `src/db/seed-vibes.ts`, `src/agents/extract.ts`, `src/app/api/ingest/route.ts`, `src/app/api/cron/scrape/route.ts`, `scripts/seed-*.ts` |
| **Scoring agent** | `src/agents/score.ts`, `src/lib/nyc-vibes.ts`, `src/lib/profile-match.ts`, `src/lib/profile-set.ts`, `src/lib/geocode.ts`, `src/lib/subway.ts` |
| **UI agent** | `src/app/page.tsx`, `src/app/listing/[id]/page.tsx`, `src/app/add/page.tsx`, `src/app/setup/page.tsx`, `src/app/layout.tsx`, `src/app/globals.css`, `src/components/listing/`, `src/components/score/`, `src/components/feed/`, `src/components/shell/` |
| **Shared (do not touch in subagents)** | `src/db/schema.ts`, `src/types.ts`, `src/lib/db.ts`, `src/lib/anthropic.ts`, `src/profiles/*.json`, `package.json`, `drizzle.config.ts`, `next.config.ts`, `tsconfig.json`, `.env.local.example` |

If an agent needs a new dependency, it stops and surfaces the request. Do not run `npm install` from a subagent.

## Coding conventions

- TypeScript strict. Types come from `@/types` (re-exports schema-inferred types). Never re-declare `Listing`, `Profile`, etc.
- Server Components by default. `'use client'` only when handlers / hooks are needed.
- Prefer `unstable_cache` (Next 15) over manual memoization for DB reads.
- Tailwind utility classes only. No CSS-in-JS. Tokens come from `globals.css` (set by impeccable's design pass — do not freelance colors).
- shadcn components are imported from `@/components/ui/<name>`. Modify the source file, don't wrap.

## Testing reality

- No test runner in v0. The product loop = `npm run dev` + visit page + spot-check.
- Run `npm run build` before any commit to catch type errors.
- `npm run db:generate && npm run db:push` after schema changes.

## Next.js 15 caveat (from create-next-app's AGENTS.md)

Some Next.js APIs have changed. Before writing route handlers / server actions / metadata, consult `node_modules/next/dist/docs/` if uncertain.
