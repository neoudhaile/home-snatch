import type { Metadata } from 'next'
import { loadAllProfileFiles } from '@/lib/profile-set'
import { SetupWizard } from '@/components/setup/setup-wizard'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Setup · homeSnatch',
}

/**
 * Server Component shell. Reads the live profile JSONs from src/profiles/ and
 * seeds the wizard with one wizard-profile per file. Adding a JSON shows up
 * here as a new "who-step" tile + a new section in the multi-edit flow.
 */
export default async function SetupPage() {
  const profiles = await loadAllProfileFiles()
  const seed = profiles.map((p) => ({ slug: p.slug, name: p.name }))
  return <SetupWizard seed={seed} />
}
