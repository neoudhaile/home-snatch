import { getRankedFeed } from '@/lib/feed-data'
import { FeedShell } from '@/components/feed/feed-shell'

export default async function HomePage() {
  // Fetch the widest window once; the client filters in-memory.
  const listings = await getRankedFeed({ freshnessDays: 30 })
  return <FeedShell initial={listings} />
}
