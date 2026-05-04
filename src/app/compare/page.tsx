import type { Metadata } from 'next'
import Link from 'next/link'
import { getListing } from '@/lib/feed-data'
import { getCommuteTargets, getSaversByListing } from '@/lib/save-state'
import { CompareTable } from '@/components/compare/compare-table'
import { SavedHeaderBar } from '@/components/saved/page-header'
import type { RankedListing } from '@/types'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Compare · homeSnatch',
}

type SearchParams = Promise<{ ids?: string }>

export default async function ComparePage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams
  const idsParam = (sp.ids ?? '').trim()
  const ids = idsParam ? idsParam.split(',').map((s) => s.trim()).filter(Boolean) : []

  // Fetch listings in the order requested. Anything missing is dropped.
  const listings: RankedListing[] = []
  for (const id of ids) {
    const found = await getListing(id)
    if (found) listings.push(found)
  }

  const [saversByListing, commuteTargets] = await Promise.all([
    getSaversByListing(listings.map((l) => l.id)),
    getCommuteTargets(),
  ])

  return (
    <>
      <SavedHeaderBar title="Compare" />
      <main className="mx-auto w-full max-w-[1480px] flex-1 px-4 py-6 sm:px-6 lg:px-8">
        {ids.length === 0 ? (
          <NothingPicked />
        ) : listings.length < 2 ? (
          <NotEnough found={listings.length} requested={ids.length} />
        ) : (
          <CompareTable
            listings={listings}
            saversByListing={saversByListing}
            commuteTargets={commuteTargets}
          />
        )}
      </main>
    </>
  )
}

function NothingPicked() {
  return (
    <div className="grid place-items-center px-6 py-24 text-center">
      <div className="max-w-md">
        <h1 className="serif text-[32px] italic leading-tight tracking-tight text-foreground">
          Pick listings to compare.
        </h1>
        <p className="mt-2 text-[14px] leading-relaxed text-muted-foreground">
          Open your saved list and choose at least two.
        </p>
        <Link
          href="/saved"
          className="mt-5 inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-full bg-foreground px-4 text-[13px] font-medium text-background"
        >
          Open saved
        </Link>
      </div>
    </div>
  )
}

function NotEnough({ found, requested }: { found: number; requested: number }) {
  return (
    <div className="grid place-items-center px-6 py-24 text-center">
      <div className="max-w-md">
        <h1 className="serif text-[28px] italic leading-tight tracking-tight text-foreground">
          Need at least 2 to compare.
        </h1>
        <p className="tabular mt-2 text-[13px] leading-relaxed text-muted-foreground">
          You picked {requested}, found {found}. Some IDs may be stale.
        </p>
        <Link
          href="/saved"
          className="mt-5 inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-full bg-foreground px-4 text-[13px] font-medium text-background"
        >
          Back to saved
        </Link>
      </div>
    </div>
  )
}
