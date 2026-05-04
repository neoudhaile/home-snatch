import type { RankedListing } from '@/types'
import { ListingCard, type ListingCardVariant } from './listing-card'

/**
 * Bento layout. Asymmetric grid that breaks the "identical card grid"
 * trap (per impeccable). Top-scored listing claims a 2x2 hero cell;
 * the next two get 2x1 wides; remaining cells are 1x1 compacts.
 *
 * The mix is recomputed every 8 cards so a long feed still has rhythm.
 */
export function BentoGrid({ listings }: { listings: RankedListing[] }) {
  const variants = assignVariants(listings.length)

  return (
    <div className="bento">
      {listings.map((l, i) => (
        <ListingCard key={l.id} listing={l} variant={variants[i]} />
      ))}
    </div>
  )
}

function assignVariants(n: number): ListingCardVariant[] {
  const out: ListingCardVariant[] = []
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
