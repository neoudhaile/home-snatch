# homeSnatch — Deployment

Two-platform deployment:

- **Vercel** for the Next.js app (free Hobby tier)
- **GitHub Actions** for the heavy scrape cron (Vercel Hobby has 60s function cap; full scrape can take 5-10 min)

## Prerequisites

- Working `~/P/homeSnatch/.env.local` with all keys filled
- A Vercel account (sign in with GitHub)
- The repo pushed to `damarajui/homeSnatch` on GitHub

## 1. Vercel — Web app

### One-time setup

```bash
npm i -g vercel
cd ~/P/homeSnatch
vercel link               # links the local dir to a Vercel project
                          # accept the project name `homesnatch` or pick your own
```

### Push env vars

The dashboard's UI is fastest. Go to:
**vercel.com/dashboard → homesnatch → Settings → Environment Variables**

Add each of these (Environment: **All** unless noted):

| Variable | Value |
|---|---|
| `DATABASE_URL` | the URI from `.env.local` (Supabase Transaction pooler, port 6543) |
| `SUPABASE_URL` | `https://qzmehypsxgpkrcwxuzaw.supabase.co` |
| `SUPABASE_ANON_KEY` | `sb_publishable_...` |
| `ANTHROPIC_API_KEY` | `sk-ant-...` |
| `APIFY_TOKEN` | `apify_api_...` |
| `APIFY_BUDGET_MODE` | `standard` |
| `APIFY_ZILLOW_ACTOR` | `parseforge~zillow-rentals-scraper` |
| `APIFY_STREETEASY_ACTOR` | `shahidirfan~StreetEasy-Scraper` |
| `APIFY_APARTMENTS_ACTOR` | `sovereigntaylor~apartments-scraper` |
| `APIFY_REALTOR_ACTOR` | `sovereigntaylor~realtor-scraper` |
| `CRON_SECRET` | a random 32-char string (e.g. `openssl rand -hex 16`) |
| `ADMIN_PASS` | a random 16+ char string (used to gate `/admin` actions) |

Or via CLI (faster for many vars):

```bash
vercel env add DATABASE_URL production
# paste value when prompted; repeat for each
```

### Deploy

```bash
vercel --prod
```

Output gives you a URL like `https://homesnatch-xxxxx.vercel.app`. Visit it — feed should load with whatever's already in your DB.

### Per-deploy verification

After every push, hit the URL and confirm:
1. `/` renders the feed
2. `/setup` loads the wizard
3. `/api/profile` returns your profiles in JSON
4. `/api/search` extracts filters from a test query (POST `{"query":"1br brooklyn"}`)
5. `/admin` AI Insights renders within ~5s (with real listings, the Sonnet call takes 3-8s)

## 2. GitHub Actions — Scrape cron

The repo already has three workflows in `.github/workflows/`:

- `scrape.yml` — every 2h at :30 (offset from Vercel cron at :00)
- `refresh.yml` — every hour at :15 (re-fetches stale listings)
- `dedupe.yml` — daily at 05:00 UTC (cross-source duplicate detection)

### Add secrets to the GitHub repo

Go to **github.com/damarajui/homeSnatch → Settings → Secrets and variables → Actions → New repository secret**.

Add each of:

| Secret | Value | Used by |
|---|---|---|
| `DATABASE_URL` | same as Vercel | scrape, refresh, dedupe |
| `ANTHROPIC_API_KEY` | same as Vercel | scrape (Reddit classifier + extractor) |
| `APIFY_TOKEN` | same as Vercel | scrape |
| `BROWSERLESS_TOKEN` | (optional) | scrape failover |

The Apify actor IDs read from env at runtime — by default they fall back to the agent's choices (which require paid actors). To override in GH Actions, edit `.github/workflows/scrape.yml` and add:

```yaml
env:
  APIFY_ZILLOW_ACTOR: parseforge~zillow-rentals-scraper
  APIFY_STREETEASY_ACTOR: shahidirfan~StreetEasy-Scraper
  APIFY_APARTMENTS_ACTOR: sovereigntaylor~apartments-scraper
  APIFY_REALTOR_ACTOR: sovereigntaylor~realtor-scraper
```

(Or set them as repo-level "Variables" instead of secrets — same `${{ vars.* }}` syntax in the workflow.)

### First manual run

After adding secrets, trigger a manual run:
**Actions → scrape → Run workflow → Run**.

Watch the live log. Successful run looks like:

```
[scrape] starting
[scrape] fetched 280 unique listings; by source: { craigslist: 80, reddit: 40, ... }
[scrape] upserted 280/280
[scrape] done in 215s
[rescore] scored 240 new listings
```

## 3. Vercel Cron — Lightweight failover

`vercel.json` already declares `/api/cron/scrape` runs every 2h at :00. Vercel Hobby caps function duration at 60s, so this path runs a *bounded* slice (only the direct-fetch sources, no Apify; respects timeouts). The full scrape comes from GH Actions at :30. They're complementary, not redundant.

Vercel Cron sends `Authorization: Bearer ${CRON_SECRET}` automatically when `CRON_SECRET` is set as an env var.

## 4. Custom domain (optional)

Vercel → Settings → Domains. Add `homesnatch.io` (or whatever) and follow the DNS prompts. Free with the project.

## 5. Cost summary

| Service | Tier | Cost |
|---|---|---|
| Vercel | Hobby | $0 |
| Supabase | Free | $0 |
| Anthropic | Pay-as-you-go | ~$2-8/mo (depends on chat usage; scoring is small) |
| Apify | Free $5/mo credit | $0-5 (FREE actors keep us under) |
| GitHub Actions | Public repo or 2000min/mo | $0 |
| **Total** | | **~$2-13/mo** |

## 6. Disaster recovery

- Schema is in code (`src/db/schema.ts`) — `npm run db:push` recreates it
- Listings re-scrape on the next cron tick — no critical data loss if DB rolls back
- Profiles in `src/profiles/*.json` are git-tracked
- Vercel rolls back to any prior deployment from the dashboard (no data loss)

## 7. Operational checks

Run these once a week (or wire to `/admin` data-quality dashboard):

```bash
# Listings count + freshness distribution
npm run rescore -- --dry-run    # not implemented yet; TODO

# Coverage gaps (no contact, no photos)
# Visit /admin or curl /api/admin/dq?type=metrics
```

## 8. What to do when scrape coverage drops

If a source returns 0 for several runs:
1. Check `/admin → AI Insights → Anomalies` for "no_contact" / "missing_address" spikes
2. Probe the source manually (`curl -A 'Mozilla/...' <source-url>`)
3. If Apify actor 404s or fails: rotate to one of the alternates listed in `docs/SCRAPING.md`
4. If direct fetch fails (Cloudflare 403): swap to the Apify-tier failover path

## 9. Updating in production

```bash
# Pull latest code
git pull origin main

# Apply schema changes (rare)
npm run db:push

# Redeploy app
vercel --prod

# Cron picks up new code on next tick automatically (GH Actions checks out HEAD)
```
