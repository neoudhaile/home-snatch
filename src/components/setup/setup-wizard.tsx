'use client'

import { useReducer, useState, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, ArrowRight, Check, LoaderCircle, Plus, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Header } from '@/components/shell/header'
import { Chip } from '@/components/setup/chip'
import { Slider } from '@/components/setup/slider'
import {
  BED_OPTIONS,
  DEAL_BREAKERS,
  MUST_HAVES,
  NEIGHBORHOODS_BY_BOROUGH,
  STEPS,
  VIBE_LABELS,
  initialWizardState,
  wizardReducer,
  type WizardProfile,
  type WizardState,
  type WizardWho,
} from '@/components/setup/wizard-state'
import { cn } from '@/lib/utils'

const STEP_LABELS: Record<(typeof STEPS)[number], string> = {
  who: 'who',
  basics: 'basics',
  must: 'must-haves',
  breakers: 'deal-breakers',
  vibes: 'vibes',
  commute: 'commute',
  areas: 'areas',
  notes: 'notes',
  review: 'review',
}

type Seed = Array<{ slug: string; name: string }>

export function SetupWizard({ seed }: { seed: Seed }) {
  const router = useRouter()
  const [state, dispatch] = useReducer(
    wizardReducer,
    seed,
    (s: Seed) => initialWizardState(s),
  )
  const [submitting, setSubmitting] = useState(false)

  const stepKey = STEPS[state.step]
  const profile = state.profiles[state.activeIndex]
  const totalSteps = STEPS.length
  const profileCount = state.profiles.length
  const showWhoStep = profileCount > 1

  const isLastStep = state.step === totalSteps - 1
  const canAdvance = (() => {
    if (stepKey === 'who') return state.who !== null
    if (stepKey === 'basics') return profile.budget_max > profile.budget_min
    return true
  })()

  function selectedProfilesForSubmit(): WizardProfile[] {
    if (state.who === 'all' || !showWhoStep) return state.profiles
    if (typeof state.who === 'number') return [state.profiles[state.who]]
    return state.profiles
  }

  async function save() {
    setSubmitting(true)
    try {
      const payload = {
        who: state.who,
        profiles: selectedProfilesForSubmit(),
      }
      const res = await fetch('/api/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        toast.error('Could not save profile.')
        return
      }
      toast.success('Profile saved.')
      router.push('/')
    } catch {
      toast.error('Network error.')
    } finally {
      setSubmitting(false)
    }
  }

  function onNext() {
    if (isLastStep) {
      void save()
      return
    }
    dispatch({ type: 'next' })
  }

  // Single-profile setups skip the WhoStep entirely.
  const effectiveStepKey = stepKey === 'who' && !showWhoStep ? 'basics' : stepKey
  const effectiveStep = stepKey === 'who' && !showWhoStep ? 1 : state.step

  return (
    <>
      <Header
        state={{ freshness: 14, sources: [] }}
        onChange={() => {}}
        showFilters={false}
      />
      <main className="mx-auto w-full max-w-[820px] flex-1 px-4 py-6 sm:px-6">
        <Link
          href="/"
          className="mb-4 inline-flex cursor-pointer items-center gap-1.5 text-[12px] text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
          Skip setup
        </Link>

        <ProgressRail step={effectiveStep} total={totalSteps} stepKey={effectiveStepKey} />

        {/* Active-profile switcher when editing >1 profile in this session */}
        {state.who === 'all' && state.step > 0 && profileCount > 1 ? (
          <div className="mb-5 inline-flex flex-wrap items-center gap-0.5 rounded-full border border-border bg-surface-2 p-0.5">
            {state.profiles.map((p, i) => (
              <button
                key={p.slug}
                onClick={() => dispatch({ type: 'switch-active', index: i })}
                className={cn(
                  'tabular h-7 cursor-pointer rounded-full px-3 text-[12px] font-medium transition-colors',
                  state.activeIndex === i
                    ? 'bg-foreground text-background'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {p.name}
              </button>
            ))}
          </div>
        ) : null}

        <StepFrame stepKey={effectiveStepKey}>
          {effectiveStepKey === 'who' ? (
            <WhoStep
              who={state.who}
              profiles={state.profiles}
              setWho={(who) => {
                dispatch({ type: 'set-who', who })
                if (typeof who === 'number') {
                  dispatch({ type: 'switch-active', index: who })
                } else {
                  dispatch({ type: 'switch-active', index: 0 })
                }
              }}
            />
          ) : null}
          {effectiveStepKey === 'basics' ? (
            <BasicsStep
              profile={profile}
              onPatch={(patch) => dispatch({ type: 'patch', patch })}
            />
          ) : null}
          {effectiveStepKey === 'must' ? (
            <ChipPicker
              title="Must-haves"
              subtitle="What absolutely needs to be in the apartment."
              options={MUST_HAVES}
              selected={profile.must_have}
              onToggle={(v) =>
                dispatch({
                  type: 'patch',
                  patch: {
                    must_have: profile.must_have.includes(v)
                      ? profile.must_have.filter((x) => x !== v)
                      : [...profile.must_have, v],
                  },
                })
              }
            />
          ) : null}
          {effectiveStepKey === 'breakers' ? (
            <ChipPicker
              title="Deal-breakers"
              subtitle="What kills a listing on sight."
              options={DEAL_BREAKERS}
              selected={profile.deal_breakers}
              onToggle={(v) =>
                dispatch({
                  type: 'patch',
                  patch: {
                    deal_breakers: profile.deal_breakers.includes(v)
                      ? profile.deal_breakers.filter((x) => x !== v)
                      : [...profile.deal_breakers, v],
                  },
                })
              }
            />
          ) : null}
          {effectiveStepKey === 'vibes' ? (
            <VibesStep
              profile={profile}
              onPatch={(key, value) =>
                dispatch({ type: 'patch-vibe', key, value })
              }
            />
          ) : null}
          {effectiveStepKey === 'commute' ? (
            <CommuteStep
              profile={profile}
              onAdd={() => dispatch({ type: 'commute-add' })}
              onRemove={(i) => dispatch({ type: 'commute-remove', index: i })}
              onUpdate={(i, patch) =>
                dispatch({ type: 'commute-update', index: i, patch })
              }
            />
          ) : null}
          {effectiveStepKey === 'areas' ? (
            <AreasStep
              selected={profile.preferred_areas}
              onToggle={(v) =>
                dispatch({
                  type: 'patch',
                  patch: {
                    preferred_areas: profile.preferred_areas.includes(v)
                      ? profile.preferred_areas.filter((x) => x !== v)
                      : [...profile.preferred_areas, v],
                  },
                })
              }
            />
          ) : null}
          {effectiveStepKey === 'notes' ? (
            <NotesStep
              value={profile.notes}
              onChange={(notes) => dispatch({ type: 'patch', patch: { notes } })}
            />
          ) : null}
          {effectiveStepKey === 'review' ? (
            <ReviewStep state={state} showWhoStep={showWhoStep} />
          ) : null}
        </StepFrame>

        <NavRow
          step={effectiveStep}
          total={totalSteps}
          isLast={isLastStep}
          submitting={submitting}
          canAdvance={canAdvance}
          onPrev={() => dispatch({ type: 'prev' })}
          onNext={onNext}
        />
      </main>
    </>
  )
}

/* ---------- structure ---------- */

function ProgressRail({
  step,
  total,
  stepKey,
}: {
  step: number
  total: number
  stepKey: (typeof STEPS)[number]
}) {
  return (
    <div className="mb-6">
      <div className="mb-2 flex items-baseline justify-between">
        <span className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
          Step {step + 1} of {total}
        </span>
        <span className="text-[11px] uppercase tracking-[0.08em] text-foreground/70">
          {STEP_LABELS[stepKey]}
        </span>
      </div>
      <div className="flex gap-1">
        {Array.from({ length: total }).map((_, i) => (
          <span
            key={i}
            className={cn(
              'h-[3px] flex-1 rounded-full transition-colors duration-300',
              i <= step ? 'bg-foreground' : 'bg-secondary',
            )}
            aria-hidden
          />
        ))}
      </div>
    </div>
  )
}

function StepFrame({
  children,
  stepKey,
}: {
  children: ReactNode
  stepKey: (typeof STEPS)[number]
}) {
  return (
    <div
      key={stepKey}
      className="motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-1 motion-safe:duration-300 motion-safe:ease-out"
    >
      {children}
    </div>
  )
}

function NavRow({
  step,
  total: _total,
  isLast,
  submitting,
  canAdvance,
  onPrev,
  onNext,
}: {
  step: number
  total: number
  isLast: boolean
  submitting: boolean
  canAdvance: boolean
  onPrev: () => void
  onNext: () => void
}) {
  return (
    <div className="mt-8 flex items-center justify-between gap-3">
      <Button
        variant="ghost"
        onClick={onPrev}
        disabled={step === 0 || submitting}
        className="h-9 cursor-pointer rounded-full px-4 text-[13px]"
      >
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
        Back
      </Button>
      <Button
        onClick={onNext}
        disabled={!canAdvance || submitting}
        className="h-9 cursor-pointer rounded-full px-5 text-[13px]"
      >
        {submitting ? (
          <>
            <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden />
            Saving…
          </>
        ) : isLast ? (
          <>
            Save and continue
            <Check className="h-3.5 w-3.5" aria-hidden />
          </>
        ) : (
          <>
            Continue
            <ArrowRight className="h-3.5 w-3.5" aria-hidden />
          </>
        )}
      </Button>
    </div>
  )
}

/* ---------- steps ---------- */

function WhoStep({
  who,
  profiles,
  setWho,
}: {
  who: WizardWho | null
  profiles: WizardProfile[]
  setWho: (w: WizardWho) => void
}) {
  const allLabel = profiles.length === 2 ? 'Both' : 'All'
  const allSub =
    profiles.length === 2
      ? 'Two profiles, ranked jointly.'
      : `${profiles.length} profiles, ranked jointly.`

  return (
    <div>
      <h1 className="serif text-[34px] leading-tight tracking-[-0.01em] text-foreground sm:text-[42px]">
        Who's setting up?
      </h1>
      <p className="mt-2 max-w-[58ch] text-[14px] leading-relaxed text-muted-foreground">
        Profiles drive the ranking. If everyone is hunting together, set up all
        of them and we reconcile.
      </p>
      <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
        {profiles.map((p, i) => (
          <WhoTile
            key={p.slug}
            active={who === i}
            onClick={() => setWho(i)}
            title={p.name}
            sub="Solo profile."
          />
        ))}
        {profiles.length >= 2 ? (
          <WhoTile
            active={who === 'all'}
            onClick={() => setWho('all')}
            title={allLabel}
            sub={allSub}
            accent
          />
        ) : null}
      </div>
    </div>
  )
}

function WhoTile({
  active,
  onClick,
  title,
  sub,
  accent,
}: {
  active: boolean
  onClick: () => void
  title: string
  sub: string
  accent?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'group flex cursor-pointer flex-col items-start rounded-2xl border bg-card p-5 text-left transition-all duration-200 ease-out',
        active
          ? 'border-foreground shadow-[0_8px_24px_-12px_oklch(0.2_0.04_220/0.45)]'
          : 'border-border hover:border-foreground/30',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
      )}
    >
      <span
        className={cn(
          'mb-3 inline-block h-2 w-2 rounded-full transition-colors',
          active ? 'bg-foreground' : accent ? 'bg-accent' : 'bg-border',
        )}
      />
      <span className="serif text-[26px] leading-none tracking-tight text-foreground">
        {title}
      </span>
      <span className="mt-1.5 text-[12px] text-muted-foreground">{sub}</span>
    </button>
  )
}

function BasicsStep({
  profile,
  onPatch,
}: {
  profile: WizardProfile
  onPatch: (patch: Partial<WizardProfile>) => void
}) {
  return (
    <div className="space-y-7">
      <h1 className="serif text-[34px] leading-tight tracking-[-0.01em] text-foreground sm:text-[42px]">
        The basics.
      </h1>

      <div>
        <label
          htmlFor="setup-name"
          className="mb-2 block text-[12px] font-medium uppercase tracking-[0.06em] text-muted-foreground"
        >
          Name
        </label>
        <input
          id="setup-name"
          type="text"
          value={profile.name}
          onChange={(e) => onPatch({ name: e.target.value })}
          className="block w-full rounded-xl border border-border bg-surface-2 px-3.5 py-2.5 text-[15px] text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        />
      </div>

      <div className="space-y-3">
        <span className="block text-[12px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
          Budget per month
        </span>
        <div className="flex items-center gap-3">
          <NumberInput
            value={profile.budget_min}
            onChange={(budget_min) => onPatch({ budget_min })}
            prefix="$"
            ariaLabel="Minimum budget"
          />
          <span className="text-muted-foreground">to</span>
          <NumberInput
            value={profile.budget_max}
            onChange={(budget_max) => onPatch({ budget_max })}
            prefix="$"
            ariaLabel="Maximum budget"
          />
        </div>
        <Slider
          value={profile.budget_max}
          min={1000}
          max={6000}
          step={50}
          onChange={(budget_max) => onPatch({ budget_max })}
          label="Stretch"
          hint="The most you'd pay for the right place."
          unit="/mo"
        />
      </div>

      <div className="space-y-3">
        <span className="block text-[12px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
          Bedrooms (pick what you'd consider)
        </span>
        <div className="flex flex-wrap gap-2">
          {BED_OPTIONS.map((b) => (
            <Chip
              key={b}
              active={profile.beds.includes(b)}
              onClick={() =>
                onPatch({
                  beds: profile.beds.includes(b)
                    ? profile.beds.filter((x) => x !== b)
                    : [...profile.beds, b],
                })
              }
            >
              {b}
            </Chip>
          ))}
        </div>
      </div>
    </div>
  )
}

function NumberInput({
  value,
  onChange,
  prefix,
  ariaLabel,
}: {
  value: number
  onChange: (v: number) => void
  prefix?: string
  ariaLabel?: string
}) {
  return (
    <div className="relative">
      {prefix ? (
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 tabular text-[14px] text-muted-foreground">
          {prefix}
        </span>
      ) : null}
      <input
        type="number"
        value={value}
        aria-label={ariaLabel}
        onChange={(e) => onChange(Math.max(0, Number(e.target.value || 0)))}
        className={cn(
          'tabular block w-32 rounded-xl border border-border bg-surface-2 py-2.5 text-[15px] font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
          prefix ? 'pl-7 pr-3' : 'px-3',
        )}
      />
    </div>
  )
}

function ChipPicker({
  title,
  subtitle,
  options,
  selected,
  onToggle,
}: {
  title: string
  subtitle: string
  options: string[]
  selected: string[]
  onToggle: (v: string) => void
}) {
  const [custom, setCustom] = useState('')
  return (
    <div>
      <h1 className="serif text-[34px] leading-tight tracking-[-0.01em] text-foreground sm:text-[42px]">
        {title}.
      </h1>
      <p className="mt-2 max-w-[58ch] text-[14px] leading-relaxed text-muted-foreground">
        {subtitle}
      </p>
      <div className="mt-6 flex flex-wrap gap-2">
        {options.map((o) => (
          <Chip
            key={o}
            active={selected.includes(o)}
            onClick={() => onToggle(o)}
          >
            {o.replace(/-/g, ' ')}
          </Chip>
        ))}
        {selected
          .filter((s) => !options.includes(s))
          .map((s) => (
            <Chip key={s} active onClick={() => onToggle(s)}>
              {s}
            </Chip>
          ))}
      </div>
      <div className="mt-5 flex items-center gap-2">
        <input
          type="text"
          placeholder="Add your own"
          aria-label={`Add a custom ${title.toLowerCase()}`}
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && custom.trim()) {
              onToggle(custom.trim().toLowerCase().replace(/\s+/g, '-'))
              setCustom('')
            }
          }}
          className="block w-full max-w-[280px] rounded-xl border border-border bg-surface-2 px-3 py-2 text-[13px] text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        />
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            if (custom.trim()) {
              onToggle(custom.trim().toLowerCase().replace(/\s+/g, '-'))
              setCustom('')
            }
          }}
          className="h-9 cursor-pointer rounded-full px-3 text-[12px]"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden />
          Add
        </Button>
      </div>
    </div>
  )
}

function VibesStep({
  profile,
  onPatch,
}: {
  profile: WizardProfile
  onPatch: (key: keyof WizardProfile['vibes'], value: number) => void
}) {
  return (
    <div>
      <h1 className="serif text-[34px] leading-tight tracking-[-0.01em] text-foreground sm:text-[42px]">
        Neighborhood vibe.
      </h1>
      <p className="mt-2 max-w-[58ch] text-[14px] leading-relaxed text-muted-foreground">
        Slide each from 0 (don't care) to 10 (matters a lot). We compute these from
        public NYC data: Parks, 311, SLA, street network.
      </p>
      <div className="mt-6 grid grid-cols-1 gap-5 sm:grid-cols-2">
        {VIBE_LABELS.map(({ key, label, hint }) => (
          <Slider
            key={key}
            label={label}
            hint={hint}
            value={profile.vibes[key]}
            onChange={(v) => onPatch(key, v)}
            min={0}
            max={10}
          />
        ))}
      </div>
    </div>
  )
}

function CommuteStep({
  profile,
  onAdd,
  onRemove,
  onUpdate,
}: {
  profile: WizardProfile
  onAdd: () => void
  onRemove: (i: number) => void
  onUpdate: (i: number, patch: Partial<WizardProfile['commute'][number]>) => void
}) {
  const MODES: Array<'subway' | 'walk' | 'bike'> = ['subway', 'walk', 'bike']
  return (
    <div>
      <h1 className="serif text-[34px] leading-tight tracking-[-0.01em] text-foreground sm:text-[42px]">
        Commute targets.
      </h1>
      <p className="mt-2 max-w-[58ch] text-[14px] leading-relaxed text-muted-foreground">
        Where do you go often? Each address gets a separate ranking signal.
      </p>
      <div className="mt-6 space-y-4">
        {profile.commute.map((c, i) => (
          <div
            key={i}
            className="rounded-2xl border border-border bg-card p-4 space-y-4"
          >
            <div className="flex items-start gap-3">
              <input
                type="text"
                value={c.to}
                onChange={(e) => onUpdate(i, { to: e.target.value })}
                placeholder="Address or place name"
                aria-label={`Destination ${i + 1}`}
                className="flex-1 rounded-xl border border-border bg-surface-2 px-3 py-2 text-[14px] text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              />
              <button
                type="button"
                onClick={() => onRemove(i)}
                aria-label="Remove destination"
                className="grid h-9 w-9 cursor-pointer place-items-center rounded-full border border-border bg-surface-2 text-muted-foreground transition-colors hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" aria-hidden />
              </button>
            </div>
            <Slider
              value={c.max_minutes}
              onChange={(max_minutes) => onUpdate(i, { max_minutes })}
              min={10}
              max={75}
              step={5}
              label="Max time"
              unit=" min"
            />
            <div>
              <div className="mb-2 text-[12px] uppercase tracking-[0.06em] text-muted-foreground">
                Modes
              </div>
              <div className="flex gap-2">
                {MODES.map((m) => (
                  <Chip
                    key={m}
                    size="sm"
                    active={c.modes.includes(m)}
                    onClick={() =>
                      onUpdate(i, {
                        modes: c.modes.includes(m)
                          ? c.modes.filter((x) => x !== m)
                          : [...c.modes, m],
                      })
                    }
                  >
                    {m}
                  </Chip>
                ))}
              </div>
            </div>
          </div>
        ))}
        <Button
          type="button"
          variant="ghost"
          onClick={onAdd}
          className="h-9 cursor-pointer rounded-full px-4 text-[13px]"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden />
          Add destination
        </Button>
      </div>
    </div>
  )
}

function AreasStep({
  selected,
  onToggle,
}: {
  selected: string[]
  onToggle: (v: string) => void
}) {
  return (
    <div>
      <h1 className="serif text-[34px] leading-tight tracking-[-0.01em] text-foreground sm:text-[42px]">
        Preferred areas.
      </h1>
      <p className="mt-2 max-w-[58ch] text-[14px] leading-relaxed text-muted-foreground">
        Pick neighborhoods you'd actually live in. Skip if no preference.
      </p>
      <div className="mt-6 space-y-6">
        {Object.entries(NEIGHBORHOODS_BY_BOROUGH).map(([boro, nbhds]) => (
          <div key={boro}>
            <h3 className="mb-2 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
              {boro}
            </h3>
            <div className="flex flex-wrap gap-1.5">
              {nbhds.map((n) => (
                <Chip
                  key={n}
                  size="sm"
                  active={selected.includes(n)}
                  onClick={() => onToggle(n)}
                >
                  {n}
                </Chip>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function NotesStep({
  value,
  onChange,
}: {
  value: string
  onChange: (v: string) => void
}) {
  return (
    <div>
      <h1 className="serif text-[34px] leading-tight tracking-[-0.01em] text-foreground sm:text-[42px]">
        Anything else?
      </h1>
      <p className="mt-2 max-w-[58ch] text-[14px] leading-relaxed text-muted-foreground">
        Free-form notes the agent sees on every score. Constraints, soft preferences,
        weird requirements: write whatever helps.
      </p>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={8}
        aria-label="Free-form notes"
        className="mt-6 block w-full resize-none rounded-2xl border border-border bg-surface-2 p-4 text-[14px] leading-relaxed text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        placeholder="e.g., I work nights so I'd rather be on a quiet block; we're cat people; ground floor is fine if there's a stoop and a deadbolt; no broker fee unless the unit is unusually well-priced..."
      />
    </div>
  )
}

function ReviewStep({
  state,
  showWhoStep,
}: {
  state: WizardState
  showWhoStep: boolean
}) {
  const profiles =
    !showWhoStep || state.who === 'all'
      ? state.profiles
      : typeof state.who === 'number'
        ? [state.profiles[state.who]]
        : state.profiles

  return (
    <div>
      <h1 className="serif text-[34px] leading-tight tracking-[-0.01em] text-foreground sm:text-[42px]">
        Looks right?
      </h1>
      <p className="mt-2 max-w-[58ch] text-[14px] leading-relaxed text-muted-foreground">
        Save to start ranking. You can edit any of this later in <code className="rounded bg-secondary px-1.5 py-0.5 text-[12px]">src/profiles/</code>.
      </p>
      <pre className="mt-6 max-h-[420px] overflow-auto rounded-2xl border border-border bg-surface-2 p-4 font-mono text-[12px] leading-relaxed text-foreground/90">
{JSON.stringify(profiles, null, 2)}
      </pre>
    </div>
  )
}
