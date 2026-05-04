'use client'

import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'

export function PhotoGallery({
  photos,
  alt,
}: {
  photos: string[]
  alt: string
}) {
  const [active, setActive] = useState(0)
  const trackRef = useRef<HTMLDivElement>(null)

  // Sync scroll position with active index on mobile
  useEffect(() => {
    const track = trackRef.current
    if (!track) return
    const onScroll = () => {
      const idx = Math.round(track.scrollLeft / track.clientWidth)
      if (idx !== active) setActive(idx)
    }
    track.addEventListener('scroll', onScroll, { passive: true })
    return () => track.removeEventListener('scroll', onScroll)
  }, [active])

  if (!photos.length) {
    return (
      <div className="aspect-[16/9] w-full overflow-hidden rounded-2xl bg-secondary">
        <div className="grid h-full place-items-center text-muted-foreground">
          <span className="text-sm">No photos</span>
        </div>
      </div>
    )
  }

  function go(delta: number) {
    const next = Math.max(0, Math.min(photos.length - 1, active + delta))
    setActive(next)
    const track = trackRef.current
    if (track) track.scrollTo({ left: next * track.clientWidth, behavior: 'smooth' })
  }

  return (
    <div className="space-y-3">
      <div className="group relative overflow-hidden rounded-2xl bg-secondary">
        <div
          ref={trackRef}
          className="flex aspect-[16/9] w-full snap-x snap-mandatory overflow-x-auto scroll-smooth [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          aria-label="Photo gallery"
        >
          {photos.map((src, i) => (
            <div key={src + i} className="relative h-full w-full shrink-0 snap-center">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={src}
                alt={`${alt}, photo ${i + 1} of ${photos.length}`}
                loading={i === 0 ? 'eager' : 'lazy'}
                className="absolute inset-0 h-full w-full object-cover"
              />
            </div>
          ))}
        </div>
        {/* Desktop arrows */}
        {photos.length > 1 ? (
          <>
            <button
              aria-label="Previous photo"
              onClick={() => go(-1)}
              disabled={active === 0}
              className={cn(
                'absolute left-3 top-1/2 hidden h-9 w-9 -translate-y-1/2 cursor-pointer place-items-center rounded-full',
                'border border-foreground/10 bg-background/80 text-foreground backdrop-blur-md',
                'opacity-0 transition-opacity duration-300 hover:bg-background group-hover:opacity-100',
                'disabled:cursor-not-allowed disabled:opacity-30',
                'md:grid',
              )}
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              aria-label="Next photo"
              onClick={() => go(1)}
              disabled={active === photos.length - 1}
              className={cn(
                'absolute right-3 top-1/2 hidden h-9 w-9 -translate-y-1/2 cursor-pointer place-items-center rounded-full',
                'border border-foreground/10 bg-background/80 text-foreground backdrop-blur-md',
                'opacity-0 transition-opacity duration-300 hover:bg-background group-hover:opacity-100',
                'disabled:cursor-not-allowed disabled:opacity-30',
                'md:grid',
              )}
            >
              <ChevronRight className="h-4 w-4" />
            </button>
            <div className="tabular absolute bottom-3 right-3 rounded-full border border-foreground/10 bg-background/80 px-2 py-[3px] text-[11px] font-medium text-foreground backdrop-blur-sm">
              {active + 1} / {photos.length}
            </div>
          </>
        ) : null}
      </div>

      {/* Thumbs (desktop) */}
      {photos.length > 1 ? (
        <div className="hidden gap-2 md:grid md:grid-cols-6">
          {photos.slice(0, 6).map((src, i) => (
            <button
              key={src + i}
              onClick={() => {
                setActive(i)
                const track = trackRef.current
                if (track) track.scrollTo({ left: i * track.clientWidth, behavior: 'smooth' })
              }}
              aria-label={`Show photo ${i + 1}`}
              className={cn(
                'relative aspect-[4/3] cursor-pointer overflow-hidden rounded-md ring-1 ring-inset transition-all',
                i === active
                  ? 'ring-2 ring-foreground'
                  : 'ring-border hover:ring-foreground/30',
              )}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={src}
                alt=""
                loading="lazy"
                className="absolute inset-0 h-full w-full object-cover"
              />
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
