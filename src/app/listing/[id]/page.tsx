import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft, MapPin, Train } from 'lucide-react'
import { getListing } from '@/lib/feed-data'
import { ScoreBadge } from '@/components/score/score-badge'
import { PhotoGallery } from '@/components/listing/photo-gallery'
import { ContactCard, SectionCard } from '@/components/listing/contact-card'
import { ApplicationCard } from '@/components/listing/application-card'
import { VibeBars } from '@/components/listing/vibe-bars'
import { PublicRecords } from '@/components/listing/public-records'
import { Description } from '@/components/listing/description'
import { AskBox } from '@/components/listing/ask-box'
import {
  formatBaths,
  formatBeds,
  formatDistance,
  formatFreshness,
  formatPrice,
  formatSource,
  formatSqft,
} from '@/lib/format'

type Props = { params: Promise<{ id: string }> }

export default async function ListingDetailPage({ params }: Props) {
  const { id } = await params
  const listing = await getListing(id)
  if (!listing) notFound()

  const score = listing.score?.score ?? 0
  const facts =
    (listing.score?.rationale_jsonb as { top_facts?: string[] } | null)?.top_facts ?? []

  return (
    <div className="min-h-screen bg-background">
      {/* Breadcrumb */}
      <div className="mx-auto w-full max-w-[1200px] px-4 pt-5 sm:px-6 lg:px-8">
        <Link
          href="/"
          className="inline-flex cursor-pointer items-center gap-1.5 text-[12px] text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to feed
        </Link>
      </div>

      <main className="mx-auto w-full max-w-[1200px] space-y-8 px-4 py-6 sm:px-6 lg:px-8">
        {/* Header strip */}
        <header className="grid grid-cols-1 gap-5 md:grid-cols-[1fr_auto] md:items-end">
          <div className="space-y-2">
            <div className="flex items-center gap-1.5">
              <span className="tabular rounded-full bg-secondary px-2 py-[3px] text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                {formatSource(listing.source)}
              </span>
              <span className="tabular text-[11px] text-muted-foreground">
                {formatFreshness(listing.freshness_hours)}
              </span>
            </div>
            <h1 className="serif max-w-[820px] text-[34px] leading-[1.05] tracking-[-0.01em] text-foreground sm:text-[44px]">
              {listing.title}
            </h1>
            <div className="tabular flex flex-wrap items-baseline gap-x-3 gap-y-1 text-foreground">
              <span className="text-[22px] font-semibold sm:text-[26px]">
                {formatPrice(listing.price_monthly)}
              </span>
              <span className="text-[14px] text-muted-foreground">/mo</span>
              <span className="text-foreground/30">·</span>
              <span className="text-[14px] font-medium text-foreground/90">
                {formatBeds(listing.beds)} {formatBaths(listing.baths)}
              </span>
              {listing.sqft ? (
                <>
                  <span className="text-foreground/30">·</span>
                  <span className="text-[14px] text-muted-foreground">
                    {formatSqft(listing.sqft)}
                  </span>
                </>
              ) : null}
              <span className="text-foreground/30">·</span>
              <span className="inline-flex items-center gap-1 text-[14px] text-muted-foreground">
                <MapPin className="h-3.5 w-3.5" />
                {listing.neighborhood}, {listing.borough}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-3 md:justify-end">
            <ScoreBadge score={score} size="xl" />
          </div>
        </header>

        {/* Photos */}
        <PhotoGallery photos={listing.photos ?? []} alt={listing.title} />

        {/* Headline + concerns */}
        <section className="grid grid-cols-1 gap-4 rounded-2xl border border-border bg-surface-2 p-5 md:grid-cols-2 md:gap-8">
          <div>
            <h2 className="serif text-[22px] leading-tight text-foreground">
              {listing.score?.headline}
            </h2>
            {listing.score?.concerns ? (
              <p className="mt-2 text-[13.5px] leading-relaxed text-muted-foreground">
                {listing.score.concerns}
              </p>
            ) : null}
          </div>
          {facts.length ? (
            <div>
              <p className="mb-2 text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
                Why this scored {score}
              </p>
              <ul className="space-y-1.5">
                {facts.map((f, i) => (
                  <li
                    key={i}
                    className="flex gap-2 text-[13.5px] leading-snug text-foreground/90"
                  >
                    <span className="tabular mt-0.5 shrink-0 text-[11px] font-semibold text-muted-foreground">
                      {String(i + 1).padStart(2, '0')}
                    </span>
                    <span>{f}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>

        {/* Two-column body */}
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1.4fr_1fr] lg:gap-7">
          <div className="space-y-5">
            <SubwayPanel
              nearestSubway={listing.nearest_subway ?? null}
              address={listing.address ?? null}
            />
            <VibeBars vibe={listing.vibe ?? null} />
            <PublicRecords
              hpdCount12mo={listing.hpd_count_12mo ?? null}
              rentStabilized={listing.rent_stabilized ?? false}
              address={listing.address ?? null}
            />
            <Description text={listing.description ?? ''} />
          </div>
          <aside className="space-y-5 lg:sticky lg:top-20 lg:self-start">
            <ContactCard contact={listing.contact ?? null} />
            <ApplicationCard application={listing.application ?? null} />
            <AskBox listingId={listing.id} />
          </aside>
        </div>
      </main>
    </div>
  )
}

function SubwayPanel({
  nearestSubway,
  address,
}: {
  nearestSubway: { stop_id: string; name: string; lines: string[]; distance_m: number } | null
  address: string | null
}) {
  return (
    <SectionCard title="Where it is" hint={address ?? null}>
      {nearestSubway ? (
        <div className="flex items-center gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-full bg-foreground text-background">
            <Train className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <div className="flex items-baseline gap-2">
              <span className="tabular text-[16px] font-semibold text-foreground">
                {formatDistance(nearestSubway.distance_m)}
              </span>
              <span className="text-[13px] text-muted-foreground">
                to {nearestSubway.name}
              </span>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-1">
              {nearestSubway.lines.map((line) => (
                <SubwayLine key={line} line={line} />
              ))}
            </div>
          </div>
        </div>
      ) : (
        <p className="text-[13px] text-muted-foreground">
          No address yet, so no subway estimate.
        </p>
      )}
    </SectionCard>
  )
}

/* MTA-style line bullets, but desaturated to fit the palette. */
function SubwayLine({ line }: { line: string }) {
  return (
    <span
      aria-label={`${line} train`}
      className="tabular grid h-6 min-w-6 place-items-center rounded-full bg-foreground px-1.5 text-[12px] font-bold text-background"
    >
      {line}
    </span>
  )
}
