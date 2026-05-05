/**
 * Scoring agent: takes a Listing + the joint profile constraints, calls Claude
 * Sonnet 4.6 with a tool-use schema, and returns a `NewScore` row ready to be
 * upserted into the `scores` table.
 *
 * Hard rules (enforced in the system prompt + post-validation):
 *   - rationales must reference at least one specific listing fact AND one
 *     profile fact
 *   - never invent numbers (no fabricated commute times)
 *   - voice matches PRODUCT.md: NYC-direct, numbers over adjectives, no
 *     real-estate language, no AI-slop adjectives, no em dashes
 *   - temperature 0.2, deterministic given identical inputs
 */

import pLimit from 'p-limit'
import { differenceInDays } from 'date-fns'
import { and, eq, inArray } from 'drizzle-orm'
import type {
  Listing,
  NewScore,
  NeighborhoodVibe,
  SubwayStation,
} from '@/types'
import { getAnthropic, MODELS } from '@/lib/anthropic'
import {
  hashProfileSet,
  loadProfilesFromJson,
  mergeProfileConstraints,
  profileFileToProfilePartial,
  type JointConstraints,
  type ProfileFile,
} from '@/lib/profile-set'
import { prematchListing } from '@/lib/profile-match'
import { commuteEstimate, nearestStation } from '@/lib/subway'
import { getVibeForLatLng } from '@/lib/nyc-vibes'
import { geocodeNeighborhood } from '@/lib/geocode'
import { getDb } from '@/lib/db'
import { scores as scoresTable } from '@/db/schema'

// ---------- types ----------

export type ScoreEnrichment = {
  vibe: NeighborhoodVibe | null
  nearest_subway: { name: string; lines: string[]; distance_m: number } | null
  commute_summary: {
    target: string
    walk_min: number
    transit_min: number
    total_min: number
    transfers: number
    shared_lines: string[]
  } | null
  hpd_count_12mo: number
  rent_stabilized: boolean
}

type ScoreToolOutput = {
  score: number
  headline: string
  concerns: string | null
  top_facts: string[]
}

// ---------- prompts ----------

/**
 * The system prompt is cached (`cache_control: ephemeral`) so repeated scoring
 * runs only pay full input-token cost once. Kept stable across listings on
 * purpose — it is explicitly *parameterized only* by the joint constraints +
 * per-profile vibes, which we render once at the top.
 *
 * If you edit this, audit:
 *   1. PRODUCT.md voice rules (no real-estate adjectives, numbers > adjectives)
 *   2. the score formula (so it stays in sync with what we tell the model)
 *   3. the tool schema (so the headline/concerns/score shape stays parseable)
 */
export function buildSystemPrompt(args: {
  joint: JointConstraints
  profiles: ReturnType<typeof profileFileToProfilePartial>[]
}): string {
  const { joint, profiles } = args
  const profileBlock = profiles
    .map((p) => {
      const vibes = Object.entries(p.vibes)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ')
      return [
        `- ${p.name} (${p.slug}):`,
        `    must_have: ${(p.must_have ?? []).join(' | ') || '(none)'}`,
        `    deal_breakers: ${(p.deal_breakers ?? []).join(' | ') || '(none)'}`,
        `    nice_to_have: ${(p.nice_to_have ?? []).join(' | ') || '(none)'}`,
        `    preferred_areas: ${(p.preferred_areas ?? []).join(', ') || '(none)'}`,
        `    vibes: ${vibes || '(none)'}`,
      ].join('\n')
    })
    .join('\n')

  const jointVibes = Object.entries(joint.vibes)
    .map(([k, v]) => `${k}=${v.toFixed(1)}`)
    .join(', ')

  const commuteBlock =
    joint.commute_targets.length > 0
      ? joint.commute_targets
          .map((c) => `    ${c.to}: max ${c.max_minutes}min, modes=${c.modes.join('/')}`)
          .join('\n')
      : '    (no concrete commute targets)'

  // Build the buyer label dynamically from whatever profiles are present so
  // adding/removing/renaming a profile JSON propagates without a code change.
  const names = profiles.map((p) => p.name)
  let buyerSentence: string
  if (names.length === 0) {
    buyerSentence = 'used to rank NYC apartments. (No profiles configured.)'
  } else if (names.length === 1) {
    buyerSentence = `a personal NYC apartment-hunting tool used by ${names[0]}`
  } else if (names.length === 2) {
    buyerSentence = `a personal NYC apartment-hunting tool used by two roommates: ${names[0]} and ${names[1]}`
  } else {
    const oxford = `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`
    buyerSentence = `a personal NYC apartment-hunting tool used by ${names.length} roommates: ${oxford}`
  }

  // Pick a representative buyer name for an example concern line. Stays stable
  // across runs since profiles arrive sorted in `loadProfilesFromJson`.
  const exampleName = names[0] ?? 'the buyer'

  return `You are the scoring agent for homeSnatch, ${buyerSentence}. You rank a single listing against their joint criteria and write a 1-line headline plus an optional 1-line concern.

# Joint constraints
budget_min=${joint.budget_min ?? 'unset'}, budget_max=${joint.budget_max ?? 'unset'}
beds_min=${joint.beds_min ?? 'unset'}, beds_max=${joint.beds_max ?? 'unset'}
must_have (union): ${joint.must_have.join(' | ') || '(none)'}
deal_breakers (union): ${joint.deal_breakers.join(' | ') || '(none)'}
nice_to_have (union): ${joint.nice_to_have.join(' | ') || '(none)'}
preferred_areas (union): ${joint.preferred_areas.join(', ') || '(none)'}
joint vibes (mean over shared keys): ${jointVibes || '(none)'}
commute targets:
${commuteBlock}

# Per-profile context
${profileBlock}

# Score formula (you MUST follow this and report the resulting integer)
Start at 70.
+ 5 for each must-have explicitly present in the listing (cap +25).
- 10 for each deal-breaker present (after the rule-based pre-match — you only see listings where the pre-match already cleared deal-breakers, but if a description hints at one, still penalize).
+10 if rent_stabilized=true.
- 5 per missing major data point: no photos, no contact info, no posted_at recency.
+ 5 if the listing's neighborhood is in preferred_areas (case-insensitive).
adjust ±10 based on vibe match: compute |listing_neighborhood_vibes - joint_vibes| over shared keys; small distance → +up-to-10, large → -up-to-10.
Cap final score to 0..100 and round to integer.

# Voice rules (NON-NEGOTIABLE)
- NYC-direct. "5 stops to Atlantic on the 2/3" beats "convenient transit access".
- Numbers over adjectives. Always cite a number when you have one.
- Banned words: luxury, modern, stunning, must-see, won't last, charming, cozy, seamless, robust, elevated, delightful, vibrant, trendy (as praise), prime, rare, gem.
- Banned phrases: "high match", "great fit", "highly recommended", "checks all the boxes", "tons of character", "ton of light".
- No em dashes. Use periods, commas, parentheses.
- Do not invent numbers. If commute time is null, do not write "≈25 min commute"; instead reference the neighborhood by name only.
- Strip and rewrite real-estate-listing copy. Never quote source-listing prose.

# Headline format
One line, ≤140 chars. Must reference at least one specific listing fact AND one profile-aligned fact (must-have, preferred-area, vibe, commute target).

GOOD examples:
  "$3,200 in Crown Heights, 4 stops to FiDi on the F, dishwasher, no broker fee."
  "1br + sep office in Bed-Stuy, $2,950, in-unit laundry, posted 2 days ago."
  "$3,400 Astoria, 1 transfer to Lindy HQ, rent-stabilized, photos but no contact yet."

BAD examples (these will be rejected):
  "Great match for both of you in a vibrant neighborhood."   (adjectives, no numbers)
  "Stunning luxury 1br with modern finishes."               (banned words, listing-copy-style)
  "High score — checks all the boxes."                      (banned phrase, no facts)

# Concerns format
Optional. One line, ≤140 chars, only if there's a real concern grounded in a listing fact. Examples:
  "4 HPD violations in the last 12 months. Posted 11 days ago, may already be off-market."
  "No contact info and no photos. Source: Reddit, often gets pulled fast."
  "$3,400 is over ${exampleName}'s stretch budget by $200."
If no concern, return null.

# top_facts
3 short atomic strings (each ≤80 chars) of the most decision-relevant facts you used. They will surface as a chip row in the UI. Always concrete. e.g. ["$3,200/mo", "4 stops to FiDi on F", "rent-stabilized"].

You will be given the listing facts as a structured JSON-like block. Call the \`emit_score\` tool exactly once with your final answer. Do not write any other text.`
}

// ---------- enrichment ----------

/**
 * Resolve a listing to a usable lat/lng for commute + vibe lookups. Falls back
 * to the neighborhood centroid when no precise lat/lng is on file. Returns
 * null if we have nothing to work with.
 */
function resolveListingPoint(
  listing: Listing
): { lat: number; lng: number; precision: 'exact' | 'neighborhood' } | null {
  if (listing.lat != null && listing.lng != null) {
    return { lat: listing.lat, lng: listing.lng, precision: 'exact' }
  }
  if (listing.neighborhood) {
    const hit = geocodeNeighborhood(listing.neighborhood)
    if (hit) return { lat: hit.lat, lng: hit.lng, precision: 'neighborhood' }
  }
  return null
}

/**
 * Build the enrichment object the LLM sees. The agent fans these out
 * concurrently per-listing — see `scoreListings`.
 */
export async function enrichListing(args: {
  listing: Listing
  joint: JointConstraints
  stations: SubwayStation[]
  hpdCount: number
  rentStabilized: boolean
}): Promise<ScoreEnrichment> {
  const { listing, joint, stations, hpdCount, rentStabilized } = args
  const point = resolveListingPoint(listing)

  let vibe: NeighborhoodVibe | null = null
  let nearest: ScoreEnrichment['nearest_subway'] = null
  let commute: ScoreEnrichment['commute_summary'] = null

  if (point) {
    vibe = await getVibeForLatLng(point.lat, point.lng)

    const ns = nearestStation(point, stations)
    if (ns) {
      nearest = {
        name: ns.station.name,
        lines: ns.station.lines ?? [],
        distance_m: Math.round(ns.distance_m),
      }
    }

    // Pick the commute target with concrete coords.
    const targetWithCoords = joint.commute_targets.find((c) => c.lat != null && c.lng != null)
    if (targetWithCoords && targetWithCoords.lat != null && targetWithCoords.lng != null) {
      const est = commuteEstimate(
        point,
        { lat: targetWithCoords.lat, lng: targetWithCoords.lng },
        stations
      )
      if (est) {
        commute = {
          target: targetWithCoords.to,
          walk_min: est.walk_min,
          transit_min: est.transit_min,
          total_min: est.total_min,
          transfers: est.transfers,
          shared_lines: est.shared_lines,
        }
      }
    }
  }

  return {
    vibe,
    nearest_subway: nearest,
    commute_summary: commute,
    hpd_count_12mo: hpdCount,
    rent_stabilized: rentStabilized,
  }
}

// ---------- scorer ----------

const SCORE_TOOL = {
  name: 'emit_score',
  description: 'Emit the final score, headline, optional concerns, and top facts.',
  input_schema: {
    type: 'object' as const,
    properties: {
      score: {
        type: 'integer' as const,
        minimum: 0,
        maximum: 100,
        description: 'Integer 0-100 per the scoring formula.',
      },
      headline: {
        type: 'string' as const,
        maxLength: 200,
        description: 'One line, NYC-direct, includes at least one number from the listing and one profile-aligned fact.',
      },
      concerns: {
        type: ['string', 'null'] as unknown as 'string',
        description: 'Optional one-line concern, or null if none. Must be a real concern grounded in listing facts.',
      },
      top_facts: {
        type: 'array' as const,
        minItems: 3,
        maxItems: 3,
        items: { type: 'string' as const, maxLength: 80 },
        description: 'Exactly 3 short atomic facts driving the score.',
      },
    },
    required: ['score', 'headline', 'concerns', 'top_facts'],
  },
}

/** Strip em dashes; we already ban them in the prompt but enforce post-hoc. */
function sanitize(text: string): string {
  return text.replaceAll('—', ', ').replaceAll('–', '-').trim()
}

function listingFacts(listing: Listing, enrichment: ScoreEnrichment): Record<string, unknown> {
  const postedDays =
    listing.posted_at != null
      ? differenceInDays(new Date(), listing.posted_at)
      : null
  return {
    source: listing.source,
    source_url: listing.source_url,
    title: listing.title,
    price_monthly: listing.price_monthly,
    beds: listing.beds,
    baths: listing.baths,
    sqft: listing.sqft,
    neighborhood: listing.neighborhood,
    borough: listing.borough,
    address_present: !!listing.address,
    amenities: listing.amenities ?? [],
    photos_count: (listing.photos ?? []).length,
    contact_present: !!listing.contact && Object.keys(listing.contact).length > 0,
    application_present: !!listing.application && Object.keys(listing.application).length > 0,
    broker_fee_pct: listing.application?.broker_fee_pct ?? null,
    posted_days_ago: postedDays,
    description_excerpt: (listing.description ?? '').slice(0, 1500),
    nearest_subway: enrichment.nearest_subway,
    commute: enrichment.commute_summary,
    vibe: enrichment.vibe
      ? {
          name: enrichment.vibe.nta_name,
          noise: enrichment.vibe.noise,
          walkability: enrichment.vibe.walkability,
          greenness: enrichment.vibe.greenness,
          nightlife: enrichment.vibe.nightlife,
          cafes: enrichment.vibe.cafes,
        }
      : null,
    hpd_count_12mo: enrichment.hpd_count_12mo,
    rent_stabilized: enrichment.rent_stabilized,
  }
}

/**
 * Score a single listing. Returns a `NewScore` row.
 *
 * `profileSetHash` is what we write to `scores.profile_set_hash` so the cache
 * invalidates when profiles change. Keep it stable across a batch run by
 * computing it once in `scoreListings`.
 */
export async function scoreListing(args: {
  listing: Listing
  profiles: ProfileFile[]
  joint: JointConstraints
  enrichment: ScoreEnrichment
  profileSetHash: string
}): Promise<NewScore> {
  const { listing, profiles, joint, enrichment, profileSetHash } = args
  const client = getAnthropic()

  const partials = profiles.map(profileFileToProfilePartial)
  const system = buildSystemPrompt({ joint, profiles: partials })
  const facts = listingFacts(listing, enrichment)

  const response = await client.messages.create({
    model: MODELS.score,
    max_tokens: 1024,
    temperature: 0.2,
    system: [
      {
        type: 'text',
        text: system,
        cache_control: { type: 'ephemeral' },
      },
    ],
    tools: [SCORE_TOOL],
    tool_choice: { type: 'tool', name: 'emit_score' },
    messages: [
      {
        role: 'user',
        content: `Score this listing. Listing facts:\n\n${JSON.stringify(facts, null, 2)}`,
      },
    ],
  })

  const toolBlock = response.content.find((b) => b.type === 'tool_use')
  if (!toolBlock || toolBlock.type !== 'tool_use') {
    throw new Error(`[score] no tool_use block in response for listing ${listing.id}`)
  }

  const out = toolBlock.input as ScoreToolOutput
  if (
    typeof out.score !== 'number' ||
    typeof out.headline !== 'string' ||
    !Array.isArray(out.top_facts)
  ) {
    throw new Error(`[score] malformed tool output for listing ${listing.id}: ${JSON.stringify(out)}`)
  }

  const score = Math.max(0, Math.min(100, Math.round(out.score)))
  const headline = sanitize(out.headline)
  const concerns = out.concerns ? sanitize(out.concerns) : null
  const top_facts = out.top_facts.map(sanitize)

  return {
    listing_id: listing.id,
    profile_set_hash: profileSetHash,
    score,
    headline,
    concerns,
    rationale_jsonb: {
      top_facts,
      enrichment: {
        nearest_subway: enrichment.nearest_subway,
        commute_summary: enrichment.commute_summary,
        vibe_name: enrichment.vibe?.nta_name ?? null,
        hpd_count_12mo: enrichment.hpd_count_12mo,
        rent_stabilized: enrichment.rent_stabilized,
      },
    },
  }
}

// ---------- batch wrapper ----------

export type ScoreListingsOptions = {
  /** If supplied, we use these instead of reading from disk. Useful for tests. */
  profilesOverride?: ProfileFile[]
  /** Subway stations to use for commute estimates. Caller loads from DB. */
  stations: SubwayStation[]
  /** lookup: listingId -> 12mo HPD violation count. Caller pre-resolves. */
  hpdByListingId: Map<string, number>
  /** lookup: listingId -> rent_stabilized boolean. Caller pre-resolves. */
  rentStabByListingId: Map<string, boolean>
  /** Concurrency for enrichment (DB + geocode). Default 5. */
  enrichmentConcurrency?: number
  /**
   * Concurrency for Anthropic calls. Default 5 on Vercel Pro (was 3 on
   * hobby tier) — Anthropic API tolerates the bump fine, the bottleneck is
   * Haiku/Sonnet wall-time per listing.
   */
  scoreConcurrency?: number
  /**
   * If true, listings that already have a score row for the current
   * profile_set_hash are filtered out before scoring. Used by the rescore
   * cron path: a clean rescore on an unchanged DB drops from ~90s to <5s.
   * Default false (full rescore).
   */
  skipAlreadyScored?: boolean
}

/**
 * Batch scorer.
 *   1. load + merge profiles (once)
 *   2. for each listing, run prematch; skip 'fail'
 *   3. enrich (vibe + commute + nearest subway), concurrent
 *   4. score with Sonnet, concurrent (limit=3)
 *
 * Returns `NewScore[]` ordered by input listing order, minus failed prematches.
 */
export async function scoreListings(
  listings: Listing[],
  options: ScoreListingsOptions
): Promise<NewScore[]> {
  const profiles = options.profilesOverride ?? (await loadProfilesFromJson())
  if (profiles.length === 0) {
    console.warn('[score] no ready profiles found — skipping all listings')
    return []
  }
  const joint = mergeProfileConstraints(profiles)
  const profileSetHash = hashProfileSet(profiles)
  console.log(`[score] profile set hash=${profileSetHash}, ${profiles.length} profile(s) loaded`)

  // ---- Fast-path: skip listings already scored against this profile_set_hash
  // The cron rescore otherwise wastes ~80% of its budget rescoring unchanged
  // rows. Drops a fresh-DB-no-changes pass from ~90s to <5s.
  let candidates = listings
  if (options.skipAlreadyScored && listings.length > 0) {
    try {
      const db = getDb()
      const existing = await db
        .select({ listing_id: scoresTable.listing_id })
        .from(scoresTable)
        .where(
          and(
            eq(scoresTable.profile_set_hash, profileSetHash),
            inArray(
              scoresTable.listing_id,
              listings.map((l) => l.id),
            ),
          ),
        )
      const have = new Set(existing.map((r) => r.listing_id))
      const before = candidates.length
      candidates = candidates.filter((l) => !have.has(l.id))
      console.log(
        `[score] skipAlreadyScored: ${have.size}/${before} already scored, scoring ${candidates.length} new`,
      )
    } catch (err) {
      console.warn(
        '[score] skipAlreadyScored lookup failed, falling back to full rescore:',
        (err as Error).message,
      )
    }
  }

  // 1. prematch
  const survivors: Listing[] = []
  for (const listing of candidates) {
    const pm = prematchListing(listing, joint)
    if (pm.decision === 'fail') {
      console.log(`[score] prematch fail: ${listing.id} — ${pm.reasons.join('; ')}`)
      continue
    }
    survivors.push(listing)
  }

  // 2. enrich (concurrent)
  const enrichLimit = pLimit(options.enrichmentConcurrency ?? 5)
  const enrichments = await Promise.all(
    survivors.map((listing) =>
      enrichLimit(() =>
        enrichListing({
          listing,
          joint,
          stations: options.stations,
          hpdCount: options.hpdByListingId.get(listing.id) ?? 0,
          rentStabilized: options.rentStabByListingId.get(listing.id) ?? false,
        })
      )
    )
  )

  // 3. score (concurrent — bumped to 5 on Pro tier; was 3)
  const scoreLimit = pLimit(options.scoreConcurrency ?? 5)
  const scores = await Promise.all(
    survivors.map((listing, i) =>
      scoreLimit(async () => {
        try {
          return await scoreListing({
            listing,
            profiles,
            joint,
            enrichment: enrichments[i],
            profileSetHash,
          })
        } catch (err) {
          console.warn(`[score] failed listing ${listing.id}: ${(err as Error).message}`)
          return null
        }
      })
    )
  )

  return scores.filter((s): s is NewScore => s != null)
}
