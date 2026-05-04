# homeSnatch — PRODUCT.md

## Register

product

(Design serves the product. App UI, not a marketing site. Earned familiarity over distinctiveness — fluent users of Linear / Raycast / Notion / Stripe should trust the surface.)

## Users

Two roommates apartment-hunting in NYC together — primarily Inaan (the maintainer) and Mekonnen (his friend / future co-tenant). They are both technical, both impatient, and have used Zillow / StreetEasy / Trulia enough times to know that none of them rank well for *their* actual criteria. They want a tool that:

- Reads two profiles (their must-haves, deal-breakers, vibe preferences, budget, commute targets) and *reconciles* them.
- Pulls listings from open sources continuously (Craigslist, Reddit r/NYCapartments, Listings Project) plus on-demand single-URL ingest of any link they paste (Zillow / StreetEasy / Trulia / etc.).
- Enriches every listing with NYC Open Data: subway distance, HPD violations, rent stabilization status, neighborhood noise/walkability/greenness signal computed from 311 and Parks data.
- Returns a ranked feed with a 2-line LLM rationale per listing — one thing the agent likes about it for *them*, one concern.
- Lets either of them paste a link and get a score in <10s.

It is **not** a public product. There is no marketing surface, no signup, no pricing page. It is a tool the two of them deploy on Vercel under a hard-to-guess subdomain and use to make a real-life decision over the next 6–10 weeks.

## Voice

- NYC-direct. "5 stops to Atlantic" not "convenient transit access."
- Numbers over adjectives. "$3,200/mo, 2br, 8 HPD violations last year" beats "great value with some maintenance history."
- No real-estate language. No "luxury," "modern," "stunning," "must-see," "won't last," or "charming." If a listing's source copy uses that, the agent should strip and rewrite.
- Terse. Cards are at most one tight paragraph; rationales are one sentence each.
- Honest about uncertainty. If a Craigslist listing has no address, say so — don't pretend to score commute precision the data can't support.

## Anti-references

Hard nos for the visual + interaction language. The product should feel like the *opposite* of these:

- **Zillow / StreetEasy / Trulia / Apartments.com chrome** — heavy filter bars, generic property cards in identical 3-column grids, listing photos compressed to thumbnails, vague "neighborhood scores" with no provenance, paywalled premium features, "5 people are viewing this listing" panic UI.
- **"Luxury rental" templates** — gold accents, serif headlines on cream backgrounds, high-contrast hero photos, gradient overlays, "live elevated" copy.
- **SaaS dashboard reflexes** — chart-everything, hero-metric cards (big number + small label + 12% delta arrow), the navy-and-white tech aesthetic, sidebar-nav-with-icons-only.
- **Notion-template real estate trackers** — endless table view, manually-typed-cells, no scoring, no automation.
- **AI slop** — gradient text, glass cards as default, identical-card grids, side-stripe borders, modal-as-first-thought, em dashes, "seamless," "robust," "delightful," "elevated."

## Strategic principles

1. **Match quality > crawl breadth.** The honest reality of free scraping in 2026 is that Zillow / StreetEasy / Trulia are CloudFront/Akamai-blocked. The product's edge is *not* "we crawl every site" — it's "the agent reads two profiles and the listing's neighborhood signal and produces a ranking grounded in real public data." This is a defensible thing only an LLM-native tool can do well.

2. **Show your work.** Every score has a rationale that names a specific thing — "4 stops to FiDi, dishwasher, in your stretch budget" — never "high match." Every neighborhood vibe is computed from a named NYC Open Data source, not vibes-coded by the model.

3. **Profiles are the unit of personalization, not user accounts.** Two JSON files in `src/profiles/` (one per person), edited as code. No setup wizard in v0. The friction of editing JSON is the feature — it forces clarity.

4. **Real numbers, no fake precision.** Commute time = subway-station distance + average headway + transfer count. Don't pretend to door-to-door minute-accuracy when we don't have either address.

5. **The dev loop is the product loop.** When a listing scores wrong, edit the prompt or the profile and re-run. There is no settings UI to maintain. Every preference is in a file under version control.

## Out of scope (v0)

- Auth, multi-user, sharing
- Mobile-native app (responsive web only)
- Email / SMS alerts
- Map view (Phase 2)
- Saved + side-by-side compare (Phase 2)
- Setup UI for profiles / vibes (Phase 2 — until then, edit the JSON files)
