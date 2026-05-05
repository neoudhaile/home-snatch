import Link from 'next/link'
import { ArrowUpRight, MapPin, Phone, Mail } from 'lucide-react'
import type { RankedListing } from '@/types'
import { ScoreBadge } from '@/components/score/score-badge'
import { SaveButton } from '@/components/saved/save-button'
import {
  formatBeds,
  formatFreshness,
  formatPrice,
  formatSource,
  topVibes,
} from '@/lib/format'
import { cn } from '@/lib/utils'

export type ListingCardVariant = 'featured' | 'wide' | 'compact'

const VARIANT_CLASSES: Record<ListingCardVariant, string> = {
  featured: 'bento-featured min-h-[480px] md:min-h-[500px]',
  wide: 'bento-wide min-h-[240px]',
  compact: 'bento-compact min-h-[240px]',
}

export function ListingCard({
  listing,
  variant = 'compact',
  currentProfileHash = '',
  defaultSaver,
  initialSaved = false,
}: {
  listing: RankedListing
  variant?: ListingCardVariant
  /**
   * Live profile-set hash. When this listing's score was computed against a
   * different hash, the score badge renders a faint "rescoring" shimmer to
   * tell the user we're recomputing top picks against their new profile.
   */
  currentProfileHash?: string
  /**
   * Saver slug used to wire the heart on the card. Sourced from
   * `getKnownSavers()[0]` server-side. When omitted, the heart is hidden.
   */
  defaultSaver?: string
  /** Whether this listing is already saved by `defaultSaver`. */
  initialSaved?: boolean
}) {
  const photo = listing.photos?.[0]
  const vibes = topVibes(listing.vibe, variant === 'compact' ? 2 : 3)
  const score = listing.score?.score ?? 0
  // A score is "stale" when the current profile hash is non-empty (we know
  // what the live profile set looks like) AND the score was computed against
  // some other hash (or no hash at all, e.g. mock data when DB is wired).
  // Mocks emit `profile_set_hash: 'mock'` — those should never flag stale.
  const scoreHash = listing.score?.profile_set_hash ?? ''
  const stale =
    currentProfileHash.length > 0 &&
    scoreHash.length > 0 &&
    scoreHash !== 'mock' &&
    scoreHash !== currentProfileHash

  return (
    <Link
      href={`/listing/${listing.id}`}
      aria-label={`${listing.title}, score ${score}${stale ? ', rescoring' : ''}`}
      className={cn(
        'group relative isolate flex cursor-pointer overflow-hidden rounded-2xl bg-card',
        'border border-border ring-0 ring-foreground/0',
        'transition-[transform,box-shadow,border-color] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]',
        'hover:border-foreground/15 hover:shadow-[0_18px_40px_-20px_oklch(0.15_0.014_220/0.35)]',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        VARIANT_CLASSES[variant],
      )}
    >
      {variant === 'featured' ? (
        <FeaturedCard
          listing={listing}
          photo={photo}
          vibes={vibes}
          score={score}
          stale={stale}
          defaultSaver={defaultSaver}
          initialSaved={initialSaved}
        />
      ) : variant === 'wide' ? (
        <WideCard
          listing={listing}
          photo={photo}
          vibes={vibes}
          score={score}
          stale={stale}
          defaultSaver={defaultSaver}
          initialSaved={initialSaved}
        />
      ) : (
        <CompactCard
          listing={listing}
          photo={photo}
          vibes={vibes}
          score={score}
          stale={stale}
          defaultSaver={defaultSaver}
          initialSaved={initialSaved}
        />
      )}
    </Link>
  )
}

/* ---------- variants ---------- */

function FeaturedCard({
  listing,
  photo,
  vibes,
  score,
  stale,
  defaultSaver,
  initialSaved,
}: {
  listing: RankedListing
  photo?: string
  vibes: string[]
  score: number
  stale: boolean
  defaultSaver?: string
  initialSaved: boolean
}) {
  return (
    <div className="relative flex h-full w-full flex-col">
      <div className="relative h-[64%] w-full overflow-hidden bg-secondary">
        {photo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={photo}
            alt={listing.title}
            loading="eager"
            className="absolute inset-0 h-full w-full object-cover transition-transform duration-700 ease-[cubic-bezier(0.22,1,0.36,1)] group-hover:scale-[1.03]"
          />
        ) : (
          <PhotoMissing />
        )}
        <div className="photo-overlay pointer-events-none absolute inset-0" />
        <div className="absolute right-4 top-4 flex items-center gap-2">
          {defaultSaver && listing.score?.profile_set_hash !== 'mock' ? (
            <SaveButton
              listing_id={listing.id}
              saved_by={defaultSaver}
              initial={initialSaved}
              variant="onPhoto"
              compact
            />
          ) : null}
          <RescoringWrap stale={stale} size="xl">
            <ScoreBadge score={score} size="xl" />
          </RescoringWrap>
        </div>
        <div className="absolute left-4 top-4 flex items-center gap-1.5">
          <SourceBadge source={listing.source} variant="onPhoto" />
          <FreshnessPill hours={listing.freshness_hours} variant="onPhoto" />
        </div>
        <div className="absolute inset-x-0 bottom-0 p-5">
          <div className="flex flex-wrap items-center gap-1.5">
            {vibes.map((v) => (
              <VibeChip key={v} label={v} variant="onPhoto" />
            ))}
          </div>
        </div>
      </div>
      <div className="flex h-[36%] flex-col justify-between p-5">
        <div>
          <p className="text-[15px] font-medium leading-snug text-card-foreground">
            {listing.score?.headline}
          </p>
          {listing.score?.concerns ? (
            <p className="mt-1.5 text-[13px] leading-snug text-muted-foreground">
              {listing.score.concerns}
            </p>
          ) : null}
        </div>
        <MetaRow listing={listing} prominent />
      </div>
    </div>
  )
}

function WideCard({
  listing,
  photo,
  vibes,
  score,
  stale,
  defaultSaver,
  initialSaved,
}: {
  listing: RankedListing
  photo?: string
  vibes: string[]
  score: number
  stale: boolean
  defaultSaver?: string
  initialSaved: boolean
}) {
  return (
    <div className="relative flex h-full w-full">
      <div className="relative aspect-[4/3] w-[44%] shrink-0 overflow-hidden bg-secondary sm:w-[40%]">
        {photo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={photo}
            alt={listing.title}
            loading="lazy"
            className="absolute inset-0 h-full w-full object-cover transition-transform duration-700 ease-[cubic-bezier(0.22,1,0.36,1)] group-hover:scale-[1.03]"
          />
        ) : (
          <PhotoMissing />
        )}
        <div className="absolute right-2 top-2 flex items-center gap-1.5">
          {defaultSaver && listing.score?.profile_set_hash !== 'mock' ? (
            <SaveButton
              listing_id={listing.id}
              saved_by={defaultSaver}
              initial={initialSaved}
              variant="onPhoto"
              compact
            />
          ) : null}
          <RescoringWrap stale={stale} size="md">
            <ScoreBadge score={score} size="md" />
          </RescoringWrap>
        </div>
      </div>
      <div className="flex min-w-0 flex-1 flex-col justify-between p-4">
        <div className="space-y-2">
          <div className="flex items-center gap-1.5">
            <SourceBadge source={listing.source} />
            <FreshnessPill hours={listing.freshness_hours} />
          </div>
          <p className="line-clamp-2 text-[14px] font-medium leading-snug text-card-foreground">
            {listing.score?.headline}
          </p>
          <div className="flex flex-wrap gap-1">
            {vibes.map((v) => (
              <VibeChip key={v} label={v} />
            ))}
          </div>
        </div>
        <MetaRow listing={listing} />
      </div>
    </div>
  )
}

function CompactCard({
  listing,
  photo,
  vibes,
  score,
  stale,
  defaultSaver,
  initialSaved,
}: {
  listing: RankedListing
  photo?: string
  vibes: string[]
  score: number
  stale: boolean
  defaultSaver?: string
  initialSaved: boolean
}) {
  return (
    <div className="relative flex h-full w-full flex-col">
      <div className="relative aspect-[4/3] w-full overflow-hidden bg-secondary">
        {photo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={photo}
            alt={listing.title}
            loading="lazy"
            className="absolute inset-0 h-full w-full object-cover transition-transform duration-700 ease-[cubic-bezier(0.22,1,0.36,1)] group-hover:scale-[1.03]"
          />
        ) : (
          <PhotoMissing />
        )}
        <div className="absolute right-2.5 top-2.5 flex items-center gap-1.5">
          {defaultSaver && listing.score?.profile_set_hash !== 'mock' ? (
            <SaveButton
              listing_id={listing.id}
              saved_by={defaultSaver}
              initial={initialSaved}
              variant="onPhoto"
              compact
            />
          ) : null}
          <RescoringWrap stale={stale} size="md">
            <ScoreBadge score={score} size="md" />
          </RescoringWrap>
        </div>
        <div className="absolute left-2.5 top-2.5">
          <SourceBadge source={listing.source} variant="onPhoto" />
        </div>
      </div>
      <div className="flex flex-1 flex-col justify-between gap-2 p-3.5">
        <div className="space-y-1.5">
          <p className="line-clamp-2 text-[13.5px] font-medium leading-snug text-card-foreground">
            {listing.score?.headline}
          </p>
          {vibes.length ? (
            <div className="flex flex-wrap gap-1">
              {vibes.map((v) => (
                <VibeChip key={v} label={v} />
              ))}
            </div>
          ) : null}
        </div>
        <MetaRow listing={listing} compact />
      </div>
    </div>
  )
}

/* ---------- inner pieces ---------- */

/**
 * Wraps a `<ScoreBadge>` with a faint, slow-pulsing ring + tooltip when the
 * underlying score was computed against a different profile_set_hash. Signals
 * "we are recomputing this against your new profile, hang tight." Subtle —
 * the score number is still legible and accurate-as-of-last-batch.
 */
function RescoringWrap({
  stale,
  size,
  children,
}: {
  stale: boolean
  size: 'md' | 'xl'
  children: React.ReactNode
}) {
  if (!stale) return <>{children}</>
  // Outer halo sized one tier larger than the badge so the ring feels integral
  // rather than slapped on. md→44px wrap, xl→72px wrap.
  const wrapSize = size === 'xl' ? 'h-[72px] w-[72px]' : 'h-11 w-11'
  return (
    <span
      title="Rescoring against your updated profile"
      aria-label="Rescoring against your updated profile"
      className={cn(
        'relative inline-grid place-items-center rounded-full',
        'ring-1 ring-foreground/20 motion-safe:animate-pulse',
        wrapSize,
      )}
    >
      {children}
      <span
        aria-hidden
        className="absolute -bottom-0.5 -right-0.5 grid h-3 w-3 place-items-center rounded-full bg-background ring-1 ring-foreground/20"
      >
        <span className="block h-1 w-1 rounded-full bg-muted-foreground motion-safe:animate-pulse" />
      </span>
    </span>
  )
}

function PhotoMissing() {
  return (
    <div className="absolute inset-0 grid place-items-center bg-[linear-gradient(135deg,oklch(0.95_0.008_210),oklch(0.92_0.012_220))] dark:bg-[linear-gradient(135deg,oklch(0.27_0.014_220),oklch(0.22_0.014_220))]">
      <div className="flex flex-col items-center gap-1.5 text-muted-foreground">
        <MapPin className="h-5 w-5 opacity-60" aria-hidden />
        <span className="text-[11px]">No photo</span>
      </div>
    </div>
  )
}

function VibeChip({ label, variant }: { label: string; variant?: 'onPhoto' }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-[3px] text-[11px] font-medium tracking-tight',
        variant === 'onPhoto'
          ? 'border border-foreground/15 bg-background/80 text-foreground backdrop-blur-sm'
          : 'bg-cool text-cool-fg',
      )}
    >
      {label}
    </span>
  )
}

function SourceBadge({ source, variant }: { source: string; variant?: 'onPhoto' }) {
  return (
    <span
      className={cn(
        'tabular inline-flex items-center rounded-full px-1.5 py-[2px] text-[10px] font-medium uppercase tracking-[0.06em]',
        variant === 'onPhoto'
          ? 'border border-foreground/10 bg-background/80 text-muted-foreground backdrop-blur-sm'
          : 'bg-secondary text-muted-foreground',
      )}
    >
      {formatSource(source)}
    </span>
  )
}

function FreshnessPill({
  hours,
  variant,
}: {
  hours?: number | null
  variant?: 'onPhoto'
}) {
  return (
    <span
      className={cn(
        'tabular inline-flex items-center rounded-full px-1.5 py-[2px] text-[10px] font-medium tracking-tight',
        variant === 'onPhoto'
          ? 'border border-foreground/10 bg-background/80 text-foreground backdrop-blur-sm'
          : 'text-muted-foreground',
      )}
    >
      {formatFreshness(hours)}
    </span>
  )
}

function MetaRow({
  listing,
  prominent = false,
  compact = false,
}: {
  listing: RankedListing
  prominent?: boolean
  compact?: boolean
}) {
  const hasContact = !!(listing.contact?.phone || listing.contact?.email)
  return (
    <div className="flex items-end justify-between gap-2">
      <div className="min-w-0">
        <div
          className={cn(
            'tabular flex items-baseline gap-1.5 text-foreground',
            prominent ? 'text-[18px] font-semibold' : compact ? 'text-[14px] font-semibold' : 'text-[15px] font-semibold',
          )}
        >
          <span>{formatPrice(listing.price_monthly)}</span>
          <span className="text-muted-foreground/70">/mo</span>
        </div>
        <div
          className={cn(
            'tabular mt-0.5 flex items-center gap-1 text-muted-foreground',
            compact ? 'text-[11px]' : 'text-[12px]',
          )}
        >
          <span className="font-medium text-foreground/80">
            {formatBeds(listing.beds)}
          </span>
          <span aria-hidden>·</span>
          <span className="truncate">{listing.neighborhood}</span>
          {!compact && listing.nearest_subway ? (
            <>
              <span aria-hidden>·</span>
              <span className="truncate">
                {listing.nearest_subway.lines.join('/')} {listing.nearest_subway.name}
              </span>
            </>
          ) : null}
        </div>
      </div>
      {/* Hover-revealed contact CTAs (featured + wide only) */}
      {!compact ? (
        <div
          aria-hidden
          className="hidden translate-y-1 items-center gap-1 opacity-0 transition-[opacity,transform] duration-300 ease-out group-hover:translate-y-0 group-hover:opacity-100 sm:flex"
        >
          {listing.contact?.phone ? (
            <span className="grid h-7 w-7 place-items-center rounded-full bg-secondary text-muted-foreground">
              <Phone className="h-3.5 w-3.5" />
            </span>
          ) : null}
          {listing.contact?.email ? (
            <span className="grid h-7 w-7 place-items-center rounded-full bg-secondary text-muted-foreground">
              <Mail className="h-3.5 w-3.5" />
            </span>
          ) : null}
          <span className="grid h-7 w-7 place-items-center rounded-full bg-foreground text-background">
            <ArrowUpRight className="h-3.5 w-3.5" />
          </span>
        </div>
      ) : null}
      {compact && !hasContact ? (
        <span className="tabular shrink-0 rounded-full bg-warm px-1.5 py-[2px] text-[10px] font-medium text-warm-fg">
          no contact
        </span>
      ) : null}
    </div>
  )
}
