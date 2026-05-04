import Link from 'next/link'
import { ArrowRight, Plus } from 'lucide-react'

export function EmptyState({
  title = 'Nothing yet',
  body = 'Set up your profile and run a scrape, or paste a listing URL to start.',
  primary = { label: 'Set up profile', href: '/setup' },
  secondary = { label: 'Paste a URL', href: '/add' },
}: {
  title?: string
  body?: string
  primary?: { label: string; href: string }
  secondary?: { label: string; href: string }
}) {
  return (
    <div className="grid place-items-center px-6 py-24">
      <div className="max-w-md text-center">
        {/* Editorial mark instead of an emoji or stock icon */}
        <div
          aria-hidden
          className="mx-auto mb-6 grid h-14 w-14 place-items-center rounded-full border border-border bg-surface-2"
        >
          <span className="serif text-[26px] italic leading-none text-foreground/70">
            ø
          </span>
        </div>
        <h1 className="serif text-[28px] italic leading-tight tracking-tight text-foreground">
          {title}
        </h1>
        <p className="mt-2 text-[14px] leading-relaxed text-muted-foreground">
          {body}
        </p>
        <div className="mt-6 flex items-center justify-center gap-2">
          <Link
            href={primary.href}
            className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-full bg-foreground px-4 text-[13px] font-medium text-background transition-opacity hover:opacity-90"
          >
            {primary.label}
            <ArrowRight className="h-3.5 w-3.5" aria-hidden />
          </Link>
          <Link
            href={secondary.href}
            className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-full border border-border bg-surface-2 px-4 text-[13px] font-medium text-foreground transition-colors hover:bg-secondary"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden />
            {secondary.label}
          </Link>
        </div>
      </div>
    </div>
  )
}
