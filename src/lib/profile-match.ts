import type { Listing } from '@/types'
import type { JointConstraints } from './profile-set'

export type PrematchDecision = 'pass' | 'fail' | 'maybe'

export type PrematchResult = {
  decision: PrematchDecision
  reasons: string[]
}

/**
 * Cheap rule-based pre-filter so we don't burn Sonnet calls on listings that
 * are obviously out of scope. Three buckets:
 *   - fail   : violates a hard constraint (price, beds, deal-breaker present)
 *   - pass   : every must-have is satisfied AND no fail conditions
 *   - maybe  : within-scope but missing some must-haves; let the LLM judge
 *
 * `reasons` is for the rationale_jsonb / debugging — never user-facing.
 */
const PRICE_SLACK = 1.05 // 5% over budget_max is still in play

function lowerSafe(s: string | null | undefined): string {
  return (s ?? '').toLowerCase()
}

function num(value: unknown): number | null {
  if (value == null) return null
  if (typeof value === 'number') return value
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function containsKeyword(haystack: string, needle: string): boolean {
  // Simple case-insensitive substring match. We intentionally don't do word-
  // boundaries here because deal-breaker phrases like "ground floor" or
  // "no windows" are short prose, not regex tokens.
  if (!needle.trim()) return false
  return haystack.includes(needle.toLowerCase().trim())
}

function listingHaystack(listing: Listing): string {
  const parts: string[] = [
    listing.title ?? '',
    listing.description ?? '',
    ...(listing.amenities ?? []),
  ]
  return parts.join(' \n ').toLowerCase()
}

export function prematchListing(listing: Listing, joint: JointConstraints): PrematchResult {
  const reasons: string[] = []
  const haystack = listingHaystack(listing)

  // --- Price ---
  if (joint.budget_max != null && listing.price_monthly != null) {
    const ceiling = Math.round(joint.budget_max * PRICE_SLACK)
    if (listing.price_monthly > ceiling) {
      return {
        decision: 'fail',
        reasons: [`price $${listing.price_monthly} > joint budget_max $${joint.budget_max} (+5% slack = $${ceiling})`],
      }
    }
  }

  // --- Beds ---
  // listing.beds is `numeric` -> string. Coerce.
  const listingBeds = num(listing.beds)
  if (joint.beds_min != null && listingBeds != null && listingBeds < joint.beds_min) {
    return {
      decision: 'fail',
      reasons: [`beds ${listingBeds} < joint beds_min ${joint.beds_min}`],
    }
  }
  if (joint.beds_max != null && listingBeds != null && listingBeds > joint.beds_max) {
    return {
      decision: 'fail',
      reasons: [`beds ${listingBeds} > joint beds_max ${joint.beds_max}`],
    }
  }

  // --- Deal-breakers ---
  // Any deal-breaker phrase appearing in description/title/amenities is fatal.
  for (const breaker of joint.deal_breakers) {
    if (containsKeyword(haystack, breaker)) {
      return {
        decision: 'fail',
        reasons: [`deal-breaker matched: "${breaker}"`],
      }
    }
  }

  // --- Must-haves ---
  // Every must-have must appear somewhere in amenities OR description for `pass`.
  // Otherwise `maybe` (the LLM may infer them from other context).
  const missingMust: string[] = []
  for (const must of joint.must_have) {
    if (!containsKeyword(haystack, must)) missingMust.push(must)
  }

  if (missingMust.length === 0) {
    if (joint.must_have.length > 0) {
      reasons.push(`all ${joint.must_have.length} must-haves present in description/amenities`)
    }
    return { decision: 'pass', reasons }
  }

  reasons.push(`${missingMust.length}/${joint.must_have.length} must-haves not explicitly present: ${missingMust.join(', ')}`)
  return { decision: 'maybe', reasons }
}
