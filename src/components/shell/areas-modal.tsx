'use client'

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { Search, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  neighborhoodsByBorough,
  resolveNeighborhood,
  type Borough,
} from '@/lib/neighborhoods'

/**
 * Quick "Edit my areas" modal. Opens from the chip row's "Edit defaults"
 * link (and could be wired into the header). Lets the user multi-select
 * canonical neighborhoods, then POSTs the updated `preferred_areas` to the
 * FIRST profile via `/api/profile`.
 *
 * v1: just edits the first profile in `GET /api/profile`. Multi-profile
 * setups would need a profile picker — flagged as a TODO at the call site
 * since the product spec deferred multi-profile editing here.
 *
 * On save: shows a toast → calls `router.refresh()` so the page revalidates
 * with the new joint preferred_areas. The background rescore wired into
 * `/api/profile` then re-ranks within ~60s.
 */
export function AreasModal({ trigger }: { trigger: ReactNode }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [profile, setProfile] = useState<{
    slug: string
    name: string
    preferred_areas: string[]
  } | null>(null)
  const [profileCount, setProfileCount] = useState(0)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const grouped = useMemo(() => neighborhoodsByBorough(), [])

  // Pull the first profile when the modal opens. We stay close to GET /api/profile's
  // shape — it returns merged file + DB profiles.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    setError(null)
    fetch('/api/profile')
      .then((r) => r.json())
      .then((j: { profiles: Array<Record<string, unknown>> }) => {
        if (cancelled) return
        const list = j.profiles ?? []
        setProfileCount(list.length)
        const first = list[0] as
          | { slug?: string; name?: string; preferred_areas?: string[] }
          | undefined
        if (!first || !first.slug || !first.name) {
          setError('No profiles found. Run setup first.')
          setProfile(null)
          return
        }
        const p = {
          slug: first.slug,
          name: first.name,
          preferred_areas: Array.isArray(first.preferred_areas)
            ? first.preferred_areas
            : [],
        }
        setProfile(p)
        // Seed selection from the loaded profile, mapped to canonicals so the
        // checkboxes track stably.
        const seed = new Set<string>()
        for (const a of p.preferred_areas) {
          const hit = resolveNeighborhood(a)
          if (hit) seed.add(hit.canonical)
        }
        setSelected(seed)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Load failed')
      })
      .finally(() => {
        if (cancelled) return
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return grouped
    const out: Record<Borough, typeof grouped[Borough]> = {
      Manhattan: [],
      Brooklyn: [],
      Queens: [],
      Bronx: [],
      'Staten Island': [],
    }
    for (const b of Object.keys(grouped) as Borough[]) {
      out[b] = grouped[b].filter((n) => {
        const names = [n.canonical, n.display, ...n.aliases]
        return names.some((x) => x.toLowerCase().includes(q))
      })
    }
    return out
  }, [grouped, query])

  function toggle(canonical: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(canonical)) next.delete(canonical)
      else next.add(canonical)
      return next
    })
  }

  async function save() {
    if (!profile) return
    setSaving(true)
    setError(null)
    try {
      // Save in display form — matches the shape the wizard writes and what
      // the alias-aware feed query expects on the read side.
      const display = Array.from(selected)
        .map((c) => resolveNeighborhood(c)?.display)
        .filter((s): s is string => typeof s === 'string')

      const body = {
        profiles: [
          {
            // /api/profile validates slug + name. Forward the loaded slug + name,
            // overwrite preferred_areas. The endpoint upserts.
            slug: profile.slug,
            name: profile.name,
            preferred_areas: display,
          },
        ],
      }
      const res = await fetch('/api/profile', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { message?: string }
        throw new Error(j.message ?? `HTTP ${res.status}`)
      }
      toast.success('Areas updated. Re-ranking…', {
        description: 'Top picks refresh within a minute.',
      })
      setOpen(false)
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={trigger as React.ReactElement} />
      <DialogContent className="max-w-md sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit your areas</DialogTitle>
          <DialogDescription>
            {profileCount > 1
              ? `Updates ${profile?.name ?? 'the first profile'} only — multi-profile editing isn't wired yet.`
              : 'Pick the neighborhoods to filter your feed by.'}
          </DialogDescription>
        </DialogHeader>

        <div className="-mx-1 flex items-center gap-2 rounded-md border border-border px-3 py-2">
          <Search className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search neighborhoods…"
            className="w-full bg-transparent text-[13px] outline-none placeholder:text-muted-foreground"
          />
          <span className="tabular text-[11px] text-muted-foreground">
            {selected.size} selected
          </span>
        </div>

        <div className="max-h-[360px] overflow-y-auto rounded-md border border-border">
          {loading ? (
            <div className="grid place-items-center py-12 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            </div>
          ) : error ? (
            <div className="px-4 py-6 text-center text-[13px] text-destructive">
              {error}
            </div>
          ) : (
            (Object.keys(filtered) as Borough[]).map((borough) => {
              const list = filtered[borough]
              if (list.length === 0) return null
              return (
                <div key={borough} className="px-2 py-2">
                  <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    {borough}
                  </div>
                  <div className="grid grid-cols-2 gap-1">
                    {list.map((n) => {
                      const active = selected.has(n.canonical)
                      return (
                        <button
                          key={n.canonical}
                          onClick={() => toggle(n.canonical)}
                          type="button"
                          className={cn(
                            'flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors',
                            active
                              ? 'bg-foreground text-background'
                              : 'text-foreground hover:bg-secondary',
                          )}
                          aria-pressed={active}
                        >
                          <span
                            className={cn(
                              'inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm border',
                              active
                                ? 'border-background bg-background'
                                : 'border-border',
                            )}
                            aria-hidden
                          >
                            {active ? (
                              <span className="h-1.5 w-1.5 rounded-[1px] bg-foreground" />
                            ) : null}
                          </span>
                          <span className="truncate">{n.display}</span>
                        </button>
                      )
                    })}
                  </div>
                </div>
              )
            })
          )}
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => setOpen(false)}
            disabled={saving}
            type="button"
          >
            Cancel
          </Button>
          <Button onClick={save} disabled={saving || loading || !profile} type="button">
            {saving ? (
              <>
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden />
                Saving
              </>
            ) : (
              'Save'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
