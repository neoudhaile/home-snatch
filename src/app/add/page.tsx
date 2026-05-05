'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { ArrowLeft, ArrowRight, LoaderCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { ListingCard } from '@/components/feed/listing-card'
import { Header } from '@/components/shell/header'
import type { RankedListing } from '@/types'

type Status = 'idle' | 'fetching' | 'ready' | 'error'

export default function AddPage() {
  const router = useRouter()
  const [url, setUrl] = useState('')
  const [status, setStatus] = useState<Status>('idle')
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<RankedListing | null>(null)

  async function ingest() {
    if (!url.trim() || status === 'fetching') return
    setStatus('fetching')
    setError(null)
    setPreview(null)
    try {
      const res = await fetch('/api/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url.trim() }),
      })
      if (!res.ok) {
        const txt = await res.text().catch(() => '')
        setError(txt || 'Could not extract a listing from that URL.')
        setStatus('error')
        return
      }
      const data = (await res.json()) as { listing: RankedListing }
      if (!data.listing) {
        setError('Extraction returned nothing.')
        setStatus('error')
        return
      }
      setPreview(data.listing)
      setStatus('ready')
    } catch {
      setError('Network error. Try again.')
      setStatus('error')
    }
  }

  function reset() {
    setStatus('idle')
    setPreview(null)
    setUrl('')
    setError(null)
  }

  return (
    <>
      <Header
        state={{ freshness: 14, sources: [] }}
        onChange={() => {}}
        showFilters={false}
      />
      <main className="mx-auto w-full max-w-[820px] flex-1 px-4 py-8 sm:px-6">
        <Link
          href="/"
          className="mb-5 inline-flex cursor-pointer items-center gap-1.5 text-[12px] text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
          Back to feed
        </Link>

        <h1 className="serif text-[34px] leading-tight tracking-[-0.01em] text-foreground sm:text-[44px]">
          Paste a listing URL.
        </h1>
        <p className="mt-2 max-w-[58ch] text-[14px] leading-relaxed text-muted-foreground">
          Zillow, StreetEasy, Trulia, Craigslist, Listings Project, anything with a
          public URL. We extract the basics, score it against your profile, and drop it
          into the feed.
        </p>

        <div className="mt-6 space-y-3">
          <textarea
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            rows={3}
            placeholder="https://streeteasy.com/building/..."
            disabled={status === 'fetching'}
            aria-label="Listing URL"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                void ingest()
              }
            }}
            className="block w-full resize-none rounded-2xl border border-border bg-surface-2 p-4 text-[15px] leading-relaxed text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:opacity-60"
          />
          <div className="flex items-center justify-between gap-3">
            <span className="text-[11px] text-muted-foreground">
              Press{' '}
              <kbd className="rounded border border-border bg-surface-2 px-1 text-[10px]">⌘</kbd>+
              <kbd className="rounded border border-border bg-surface-2 px-1 text-[10px]">Enter</kbd>{' '}
              to extract.
            </span>
            <Button
              onClick={ingest}
              disabled={!url.trim() || status === 'fetching'}
              className="h-9 cursor-pointer rounded-full px-4 text-[13px]"
            >
              {status === 'fetching' ? (
                <>
                  <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden />
                  Extracting…
                </>
              ) : (
                <>
                  Extract
                  <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                </>
              )}
            </Button>
          </div>
        </div>

        <section className="mt-8">
          {status === 'fetching' ? <ExtractSkeleton /> : null}
          {status === 'error' && error ? (
            <div className="rounded-2xl border border-destructive/30 bg-destructive/5 p-4 text-[13.5px] text-destructive">
              {error}
            </div>
          ) : null}
          {status === 'ready' && preview ? (
            <div className="space-y-3">
              <p className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
                Added to your feed
              </p>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,420px)]">
                <ListingCard listing={preview} variant="compact" />
              </div>
              <div className="flex items-center gap-3">
                <Button
                  onClick={() => router.push(`/listing/${preview.id}`)}
                  className="h-9 cursor-pointer rounded-full px-4 text-[13px]"
                >
                  Open in feed
                  <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                </Button>
                <button
                  type="button"
                  onClick={reset}
                  className="cursor-pointer text-[12.5px] text-muted-foreground underline-offset-[3px] transition-colors hover:text-foreground hover:underline"
                >
                  Add another
                </button>
              </div>
            </div>
          ) : null}
        </section>
      </main>
    </>
  )
}

function ExtractSkeleton() {
  return (
    <div className="space-y-3">
      <p className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
        Extracting...
      </p>
      <div className="overflow-hidden rounded-2xl border border-border bg-card">
        <Skeleton className="aspect-[4/3] w-full max-w-[420px]" />
        <div className="space-y-2 p-3.5">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-3 w-1/2" />
          <div className="flex items-center justify-between pt-2">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-3 w-24" />
          </div>
        </div>
      </div>
    </div>
  )
}
