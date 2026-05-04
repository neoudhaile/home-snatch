/**
 * Formatting helpers. Voice rules per PRODUCT.md: numbers over adjectives,
 * NYC-direct, no real-estate language, terse. No em dashes anywhere.
 */

export function formatPrice(monthly: number | null | undefined): string {
  if (monthly == null) return 'price unknown'
  return `$${monthly.toLocaleString('en-US')}`
}

export function formatBeds(beds: string | null | undefined): string {
  if (beds == null) return ''
  const n = Number(beds)
  if (n === 0) return 'studio'
  if (n === 1) return '1br'
  if (n === 1.5) return '1.5br'
  if (n === 2) return '2br'
  if (n === 2.5) return '2.5br'
  if (n >= 3) return `${n}br`
  return `${n}br`
}

export function formatBaths(baths: string | null | undefined): string {
  if (baths == null) return ''
  const n = Number(baths)
  if (n === 1) return '1ba'
  return `${n}ba`
}

export function formatFreshness(hours: number | null | undefined): string {
  if (hours == null) return 'unknown'
  if (hours < 1) return 'just now'
  if (hours < 24) return `${Math.round(hours)}h ago`
  const days = Math.floor(hours / 24)
  if (days === 1) return 'yesterday'
  if (days < 7) return `${days}d ago`
  if (days < 14) return '1w ago'
  if (days < 30) return `${Math.floor(days / 7)}w ago`
  return `${Math.floor(days / 30)}mo ago`
}

export function formatDistance(meters: number | null | undefined): string {
  if (meters == null) return ''
  if (meters < 100) return `${meters}m`
  if (meters < 1000) return `${Math.round(meters / 10) * 10}m`
  return `${(meters / 1000).toFixed(1)}km`
}

export function formatSqft(sqft: number | null | undefined): string {
  if (sqft == null) return ''
  return `${sqft.toLocaleString('en-US')} sqft`
}

const SOURCE_LABEL: Record<string, string> = {
  craigslist: 'Craigslist',
  reddit: 'Reddit',
  'listings-project': 'Listings Project',
  streeteasy: 'StreetEasy',
  zillow: 'Zillow',
  trulia: 'Trulia',
  apartments: 'Apartments.com',
  realtor: 'Realtor.com',
  redfin: 'Redfin',
  hotpads: 'HotPads',
  renthop: 'RentHop',
  twitter: 'Twitter/X',
  manual: 'Pasted',
}

export function formatSource(source: string): string {
  return SOURCE_LABEL[source] ?? source
}

export function scoreClass(score: number): 'low' | 'mid' | 'high' {
  if (score >= 85) return 'high'
  if (score >= 70) return 'mid'
  return 'low'
}

/**
 * Pick the best vibe chips to show inline on a card. Returns the top N
 * vibes that exceed `threshold`, paired with a one-word label.
 */
export function topVibes(
  vibe: { walkability?: number | null; greenness?: number | null; cafes?: number | null; nightlife?: number | null; family_score?: number | null; noise?: number | null } | null | undefined,
  n = 3,
  threshold = 0.6,
): string[] {
  if (!vibe) return []
  const candidates: Array<[string, number | null | undefined]> = [
    ['walkable', vibe.walkability],
    ['cafe-rich', vibe.cafes],
    ['green', vibe.greenness],
    ['nightlife', vibe.nightlife],
    ['family', vibe.family_score],
    ['quiet', vibe.noise != null ? 1 - vibe.noise : null],
  ]
  return candidates
    .filter(([, v]) => v != null && v >= threshold)
    .sort(([, a], [, b]) => (b as number) - (a as number))
    .slice(0, n)
    .map(([label]) => label)
}

export function formatBrokerFee(application: { broker_fee_pct?: number; broker_fee_text?: string } | null | undefined): string {
  if (!application) return ''
  if (application.broker_fee_text) return application.broker_fee_text
  if (application.broker_fee_pct === 0) return 'No broker fee'
  if (application.broker_fee_pct != null) return `${application.broker_fee_pct}% broker fee`
  return ''
}
