import Link from 'next/link'
import { Heart } from 'lucide-react'

type Saver = 'inaan' | 'mekonnen'

const COPY: Record<Saver, { title: string; body: string }> = {
  inaan: {
    title: 'Nothing saved yet.',
    body: 'Go to the feed and tap the heart on listings you want to track.',
  },
  mekonnen: {
    title: "Mekonnen hasn't saved anything yet.",
    body: 'Share this link with him so he can mark the ones he likes.',
  },
}

const BOTH_COPY = {
  title: 'No overlap yet.',
  body: 'Once you both save the same listing, it shows up here. This is the row that matters.',
}

export function SavedEmpty({ kind }: { kind: Saver | 'both' }) {
  const copy = kind === 'both' ? BOTH_COPY : COPY[kind]
  return (
    <div className="flex items-start gap-3 rounded-xl border border-dashed border-border bg-surface-2/60 px-4 py-5">
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-secondary text-muted-foreground">
        <Heart className="h-4 w-4" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[14px] font-medium leading-snug text-foreground">{copy.title}</p>
        <p className="mt-0.5 text-[13px] leading-relaxed text-muted-foreground">{copy.body}</p>
        {kind !== 'both' ? (
          <Link
            href="/"
            className="mt-2.5 inline-flex h-7 cursor-pointer items-center gap-1 rounded-full border border-border bg-background px-2.5 text-[12px] font-medium text-foreground transition-colors hover:bg-secondary"
          >
            Open feed
          </Link>
        ) : null}
      </div>
    </div>
  )
}
