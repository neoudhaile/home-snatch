import type { Metadata } from 'next'
import {
  getSavedFor,
  getSavedIntersection,
  getTotalSavedCount,
} from '@/lib/save-state'
import { loadAllProfileFiles } from '@/lib/profile-set'
import { SavedShell } from '@/components/saved/saved-shell'
import { SavedHeaderBar } from '@/components/saved/page-header'
import type { RankedListing } from '@/types'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Saved · homeSnatch',
}

export default async function SavedPage() {
  // Source the saver list dynamically from the profile JSONs so adding a new
  // profile file is enough. No code change needed in this page.
  const profiles = await loadAllProfileFiles()
  const both = await getSavedIntersection()
  const inSet = new Set(both.map((l) => l.id))

  const bySaver: Array<{ slug: string; name: string; listings: RankedListing[] }> =
    await Promise.all(
      profiles.map(async (p) => {
        const all = await getSavedFor(p.slug)
        // Pull intersection out so each card appears in exactly one section.
        return { slug: p.slug, name: p.name, listings: all.filter((l) => !inSet.has(l.id)) }
      }),
    )

  const savedCount = await getTotalSavedCount().catch(() => 0)

  return (
    <>
      <SavedHeaderBar savedCount={savedCount} />
      <main className="mx-auto w-full max-w-[1280px] flex-1 px-4 py-6 sm:px-6 lg:px-8">
        <SavedShell both={both} bySaver={bySaver} />
      </main>
    </>
  )
}
