import type { Metadata } from 'next'
import {
  getSavedFor,
  getSavedIntersection,
} from '@/lib/save-state'
import { SavedShell } from '@/components/saved/saved-shell'
import { SavedHeaderBar } from '@/components/saved/page-header'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Saved · homeSnatch',
}

export default async function SavedPage() {
  const [both, inaanAll, mekonnenAll] = await Promise.all([
    getSavedIntersection(),
    getSavedFor('inaan'),
    getSavedFor('mekonnen'),
  ])

  // Pull the intersection out of the per-saver lists so each card appears in
  // exactly one section. The intersection is the visual headline.
  const inSet = new Set(both.map((l) => l.id))
  const inaan = inaanAll.filter((l) => !inSet.has(l.id))
  const mekonnen = mekonnenAll.filter((l) => !inSet.has(l.id))

  return (
    <>
      <SavedHeaderBar />
      <main className="mx-auto w-full max-w-[1280px] flex-1 px-4 py-6 sm:px-6 lg:px-8">
        <SavedShell both={both} inaan={inaan} mekonnen={mekonnen} />
      </main>
    </>
  )
}
