import Link from 'next/link'
import { ArrowLeft, Bookmark } from 'lucide-react'

/**
 * Minimal top bar for /saved and /compare. Doesn't carry filters; just a
 * wordmark, a back-to-feed link, an optional saved-count pill, and breathing
 * room. Sticky.
 */
export function SavedHeaderBar({
  title = 'Saved',
  savedCount,
}: {
  title?: string
  /** Total saved count across all savers; renders the same pill the main Header uses. */
  savedCount?: number
}) {
  return (
    <header className="sticky top-0 z-30 border-b border-border bg-background/85 backdrop-blur-md supports-[backdrop-filter]:bg-background/70">
      <div className="mx-auto flex h-14 max-w-[1480px] items-center gap-3 px-4 sm:px-6 lg:px-8">
        <Link
          href="/"
          aria-label="homeSnatch home"
          className="inline-flex shrink-0 items-baseline gap-0.5 cursor-pointer focus-visible:outline-none"
        >
          <span className="serif text-[24px] leading-none italic tracking-[-0.02em] text-foreground">
            home
          </span>
          <span className="serif text-[24px] leading-none tracking-[-0.02em] text-foreground">
            Snatch
          </span>
          <span aria-hidden className="ml-1 inline-block h-1.5 w-1.5 translate-y-[-2px] rounded-full bg-accent" />
        </Link>

        <span aria-hidden className="text-muted-foreground/40">/</span>
        <span className="text-[13px] font-medium tracking-tight text-foreground">{title}</span>

        <div className="ml-auto flex items-center gap-1.5">
          {typeof savedCount === 'number' ? (
            <Link
              href="/saved"
              aria-label={`${savedCount} saved listings`}
              className="tabular inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full border border-border bg-surface-2 px-3 text-[12px] font-medium text-foreground transition-colors hover:bg-secondary"
            >
              <Bookmark className="h-3.5 w-3.5" aria-hidden />
              <span>Saved</span>
              <span className="tabular ml-0.5 text-muted-foreground">{savedCount}</span>
            </Link>
          ) : null}
          <Link
            href="/"
            className="tabular inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full border border-border bg-surface-2 px-3 text-[12px] font-medium text-foreground transition-colors hover:bg-secondary"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
            <span>Feed</span>
          </Link>
        </div>
      </div>
    </header>
  )
}
