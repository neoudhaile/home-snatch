import type { Source } from '@/types'

export type WizardWho = 'inaan' | 'mekonnen' | 'both'

export type CommuteEntry = {
  to: string
  lat?: number
  lng?: number
  max_minutes: number
  modes: Array<'subway' | 'walk' | 'bike'>
}

export type WizardProfile = {
  name: string
  budget_min: number
  budget_max: number
  beds: string[] // chip values: 'studio' | '1br' | '1.5br' | '2br' | '2.5br' | '3br+'
  must_have: string[]
  deal_breakers: string[]
  vibes: {
    quiet: number
    walkable: number
    trendy: number
    cafes: number
    nightlife: number
    greenness: number
    family_friendly: number
  }
  commute: CommuteEntry[]
  preferred_areas: string[]
  notes: string
}

export type WizardState = {
  step: number
  who: WizardWho | null
  /** Active profile being edited. For 'both', we sequence two profiles. */
  activeIndex: 0 | 1
  profiles: WizardProfile[]
}

export const STEPS = [
  'who',
  'basics',
  'must',
  'breakers',
  'vibes',
  'commute',
  'areas',
  'notes',
  'review',
] as const

export type StepKey = (typeof STEPS)[number]

export const MUST_HAVES: string[] = [
  'dishwasher',
  'in-unit-laundry',
  'separate-bedroom',
  'natural-light',
  'elevator',
  'doorman',
  'gym',
  'roof-access',
  'no-broker-fee',
  'rent-stabilized',
  'pet-friendly',
  'furnished',
  'washer-dryer-hookup',
]

export const DEAL_BREAKERS: string[] = [
  'ground-floor',
  'shared-bathroom',
  'walk-up-5-or-more',
  'no-windows-bedroom',
  'basement',
  'no-elevator',
  'near-elevated-train',
]

export const BED_OPTIONS = ['studio', '1br', '1.5br', '2br', '2.5br', '3br+']

export const VIBE_LABELS: Array<{
  key: keyof WizardProfile['vibes']
  label: string
  hint: string
}> = [
  { key: 'quiet', label: 'quiet', hint: '311 noise complaints, inverted.' },
  { key: 'walkable', label: 'walkable', hint: 'Street + amenity density.' },
  { key: 'trendy', label: 'trendy', hint: 'New cafes + restaurants per capita.' },
  { key: 'cafes', label: 'cafes', hint: 'Coffee + brunch density.' },
  { key: 'nightlife', label: 'nightlife', hint: 'SLA active liquor licenses.' },
  { key: 'greenness', label: 'greenness', hint: 'NYC Parks + tree canopy.' },
  { key: 'family_friendly', label: 'family-friendly', hint: 'Schools + parks proximity.' },
]

/**
 * NYC neighborhoods, grouped by borough. Subset of the ~70 the prompt mentions.
 */
export const NEIGHBORHOODS_BY_BOROUGH: Record<string, string[]> = {
  Manhattan: [
    'West Village',
    'East Village',
    'Lower East Side',
    'SoHo',
    'NoHo',
    'Tribeca',
    'Chelsea',
    'Gramercy',
    'Kips Bay',
    'Murray Hill',
    'Hell\'s Kitchen',
    'Upper West Side',
    'Upper East Side',
    'Morningside Heights',
    'Hamilton Heights',
    'Washington Heights',
    'Inwood',
    'East Harlem',
    'Harlem',
  ],
  Brooklyn: [
    'Williamsburg',
    'Greenpoint',
    'Bushwick',
    'Bedford-Stuyvesant',
    'Crown Heights',
    'Prospect Heights',
    'Park Slope',
    'Carroll Gardens',
    'Cobble Hill',
    'Boerum Hill',
    'Fort Greene',
    'Clinton Hill',
    'DUMBO',
    'Brooklyn Heights',
    'Sunset Park',
    'Windsor Terrace',
    'Kensington',
    'Ditmas Park',
    'Prospect Lefferts Gardens',
    'East Williamsburg',
    'Red Hook',
  ],
  Queens: [
    'Long Island City',
    'Astoria',
    'Sunnyside',
    'Woodside',
    'Jackson Heights',
    'Forest Hills',
    'Ridgewood',
    'Rego Park',
    'Flushing',
  ],
  Bronx: ['Mott Haven', 'Riverdale', 'Fordham', 'Belmont'],
  'Staten Island': ['St. George'],
}

export function defaultProfile(name: string): WizardProfile {
  return {
    name,
    budget_min: 1800,
    budget_max: 3500,
    beds: ['1br', '2br'],
    must_have: ['natural-light'],
    deal_breakers: [],
    vibes: {
      quiet: 6,
      walkable: 8,
      trendy: 5,
      cafes: 6,
      nightlife: 4,
      greenness: 5,
      family_friendly: 3,
    },
    commute: [],
    preferred_areas: [],
    notes: '',
  }
}

export function initialWizardState(): WizardState {
  return {
    step: 0,
    who: null,
    activeIndex: 0,
    profiles: [defaultProfile('Inaan'), defaultProfile('Mekonnen')],
  }
}

export type WizardAction =
  | { type: 'set-who'; who: WizardWho }
  | { type: 'next' }
  | { type: 'prev' }
  | { type: 'goto'; step: number }
  | { type: 'patch'; patch: Partial<WizardProfile> }
  | { type: 'patch-vibe'; key: keyof WizardProfile['vibes']; value: number }
  | { type: 'commute-add' }
  | { type: 'commute-remove'; index: number }
  | { type: 'commute-update'; index: number; patch: Partial<CommuteEntry> }
  | { type: 'switch-active'; index: 0 | 1 }

export function wizardReducer(state: WizardState, action: WizardAction): WizardState {
  switch (action.type) {
    case 'set-who':
      return { ...state, who: action.who }
    case 'next':
      return { ...state, step: Math.min(state.step + 1, STEPS.length - 1) }
    case 'prev':
      return { ...state, step: Math.max(state.step - 1, 0) }
    case 'goto':
      return { ...state, step: action.step }
    case 'switch-active':
      return { ...state, activeIndex: action.index }
    case 'patch': {
      const next = [...state.profiles]
      next[state.activeIndex] = { ...next[state.activeIndex], ...action.patch }
      return { ...state, profiles: next }
    }
    case 'patch-vibe': {
      const next = [...state.profiles]
      const p = next[state.activeIndex]
      next[state.activeIndex] = {
        ...p,
        vibes: { ...p.vibes, [action.key]: action.value },
      }
      return { ...state, profiles: next }
    }
    case 'commute-add': {
      const next = [...state.profiles]
      const p = next[state.activeIndex]
      next[state.activeIndex] = {
        ...p,
        commute: [...p.commute, { to: '', max_minutes: 35, modes: ['subway'] }],
      }
      return { ...state, profiles: next }
    }
    case 'commute-remove': {
      const next = [...state.profiles]
      const p = next[state.activeIndex]
      next[state.activeIndex] = {
        ...p,
        commute: p.commute.filter((_, i) => i !== action.index),
      }
      return { ...state, profiles: next }
    }
    case 'commute-update': {
      const next = [...state.profiles]
      const p = next[state.activeIndex]
      const commute = [...p.commute]
      commute[action.index] = { ...commute[action.index], ...action.patch }
      next[state.activeIndex] = { ...p, commute }
      return { ...state, profiles: next }
    }
  }
}

/* Re-export Source so wizard form can reference if needed */
export type { Source }
