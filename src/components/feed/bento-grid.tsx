import type { RankedListing } from '@/types'
import { ListingCard, type ListingCardVariant } from './listing-card'

/**
 * Bento layout. Asymmetric grid that breaks the "identical card grid"
 * trap (per impeccable). Top-scored listing claims a 2x2 hero cell;
 * the next two get 2x1 wides; remaining cells are 1x1 compacts.
 *
 * The mix is recomputed every 8 cards so a long feed still has rhythm.
 *
 * `currentProfileHash` (optional) is the live profile-set hash. Each card
 * compares its score's `profile_set_hash` against this — mismatch means a
 * background rescore is in flight, surfaced as a faint shimmer on the score.
 */
export function BentoGrid({
  listings,
  currentProfileHash = '',
  defaultSaver,
  savedIds,
}: {
  listings: RankedListing[]
  currentProfileHash?: string
  /** Saver slug used to wire the heart on each card (undefined → heart hidden). */
  defaultSaver?: string
  /** Set of listing IDs already saved by `defaultSaver`. */
  savedIds?: Set<string>
}) {
  const variants = assignVariants(listings.length)

  return (
    <div className="bento">
      {listings.map((l, i) => (
        <ListingCard
          key={l.id}
          listing={l}
          variant={variants[i]}
          currentProfileHash={currentProfileHash}
          defaultSaver={defaultSaver}
          initialSaved={savedIds?.has(l.id) ?? false}
        />
      ))}
    </div>
  )
}

function assignVariants(n: number): ListingCardVariant[] {
  const out: ListingCardVariant[] = []
  // When there are fewer than 4 listings, the asymmetric featured + wide
  // pattern looks lopsided — render uniform compact tiles instead so the
  // grid feels intentional rather than half-baked.
  if (n < 4) {
    for (let i = 0; i < n; i++) out.push('compact')
    return out
  }
  // Pattern per 8-card chunk:
  //   0: featured (2x2)
  //   1, 2: wide   (2x1)
  //   3, 4, 5, 6, 7: compact (1x1)
  // After chunk 0, each chunk's "featured" is downgraded to wide so the
  // grid only has one true hero. Variety still comes from the wide rows.
  for (let i = 0; i < n; i++) {
    const local = i % 8
    if (i === 0) out.push('featured')
    else if (local === 0) out.push('wide')
    else if (local === 1 || local === 2) out.push('wide')
    else out.push('compact')
  }
  return out
}
