# homeSnatch — DESIGN.md (baseline)

This is the starter design system. The UI agent will refine it via `/impeccable shape` and `/impeccable craft`. Tokens here are intentionally restrained; they get committed to a register during the agent's first pass.

## Register

`product` (per PRODUCT.md). Reads with the calmness of Linear/Raycast/Stripe; not a marketing site.

## Color (placeholder — UI agent finalizes)

OKLCH-based, neutral-leaning. No #000 / #fff. Tokens to be set in `src/app/globals.css`:

- `--bg`: near-black w/ a 0.005-chroma blue tint, light variant near-paper w/ same hue
- `--surface`: one step lighter than bg
- `--border`: low-contrast, both themes
- `--ink`: 10% L (body)
- `--charcoal`: 25% L (headings)
- `--ash`: 55% L (secondary)
- `--accent`: one saturated hue, used ≤10% of surface (Restrained strategy per impeccable)

Strategy choice: **Restrained**. App-shell tool, not a brand surface. UI agent confirms in shape brief.

## Theme

Light + dark, both first-class. Default = system preference. Apartment-hunting happens at 11pm; dark mode must be carefully calibrated. Per impeccable: *"a renter scrolling listings on their phone in bed at 11pm in low light"* — that's the dark mode anchor scene.

## Typography

- One sans for body + UI
- One mono for prices, addresses, posted-at timestamps, and any data that benefits from tabular numerals
- Scale: 12 / 13 / 14 / 16 / 18 / 24 / 32 (1.25 ratio between primary steps)
- Body line-height 1.55, headings 1.15
- Body line length capped at 65–75ch (per impeccable)
- Tabular nums on price + sqft + days-ago

## Layout

- Max content width: vary by surface. Feed = wide (1400+ for grid), detail = narrow (720ch).
- 8px spacing scale. Vary spacing for rhythm — *not* same padding everywhere.
- Cards used sparingly (impeccable: "Cards are the lazy answer"). For listings, the card is justified — discrete units that belong together. No nested cards.

## Motion

- All transitions ease-out-quart, 150–250ms.
- No animating layout (width/height/top/left); transform + opacity only.
- `prefers-reduced-motion` respected for everything beyond a 100ms hover state.

## Components inventory (shadcn — already added)

Available: `button`, `card`, `badge`, `input`, `label`, `select`, `textarea`, `separator`, `dialog`, `sheet`, `tabs`, `scroll-area`, `skeleton`, `sonner`, `dropdown-menu`, `popover`, `tooltip`, `switch`, `form`, `table`, `avatar`.

If the UI agent needs more, run `npx shadcn@latest add <name> -y`.

## Copy laws (from PRODUCT.md, restated for the agent)

- No real-estate adjectives ("luxury", "modern", "stunning", "must-see", "won't last", "charming", "cozy" as a euphemism)
- No em dashes (use commas, colons, semicolons, periods, parentheses)
- No "seamless", "robust", "elevated", "delightful"
- Numbers over adjectives. "$3,200/mo, 4 stops to FiDi" beats "great value, convenient transit"
- Honest about uncertainty. Listings missing contact info / address say so explicitly

## Anti-pattern reminders (from impeccable's absolute bans)

- No side-stripe borders (`border-left` or `border-right` >1px as accent)
- No gradient text
- No glassmorphism as default
- No hero-metric template
- No identical card grids (vary card density / aspect by content type — full-image cards for listings with photos, sparse text-only cards for listings without)
- No modal-as-first-thought (prefer inline / progressive)

## What the UI agent should do first

1. Run `python3 ~/.claude/skills/ui-ux-pro-max/scripts/search.py "apartment search tool product housing real estate restrained dark-friendly" --design-system --persist -p "homeSnatch"` to anchor the design system in this project.
2. Run `/impeccable shape "feed page — ranked NYC apartment listings with photos, contact, application, vibe chips, score, days-ago freshness badge, source badge"`.
3. Wait for shape brief approval (per impeccable's gate).
4. Run `/impeccable craft` to build the feed page.
5. Iterate via `/impeccable live` if the dev server is running.
6. Final pass: `/impeccable polish` + `/impeccable audit`.
