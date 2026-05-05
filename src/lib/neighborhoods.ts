/**
 * Canonical NYC neighborhood registry + alias resolver.
 *
 * Why this exists: scrapers emit neighborhood strings in wildly different
 * spellings — "Bed-Stuy", "Bedford-Stuyvesant", "Bedford Stuyvesant", "BedStuy",
 * "SoHo", "Soho", "South of Houston". User profiles use the short colloquial
 * form ("Bed-Stuy"). The DB column is a free-text string. Without a normalizer,
 * `WHERE lower(neighborhood) ILIKE ANY (...)` misses all the equivalences and
 * the area filter (the most-important filter on the feed) returns ~0 listings.
 *
 * This module gives three primitives:
 *   - `resolveNeighborhood(input)`  — lookup → canonical record or null
 *   - `expandToAliases(displayList)` — UI inputs → ALL strings to match in SQL
 *   - `canonicalize(input)`         — used at INGEST time to normalize the column
 *
 * The registry below covers ~100 NYC neighborhoods. Coverage rule: every
 * neighborhood the user's profile lists, plus every high-volume scraper-emitted
 * name we've seen, plus every NTA the vibe layer references.
 */

export type Borough =
  | 'Manhattan'
  | 'Brooklyn'
  | 'Queens'
  | 'Bronx'
  | 'Staten Island'

export type CanonicalNeighborhood = {
  /** Authoritative form — what scrapers most commonly emit and what the DB
   *  should converge to (canonicalize() returns this). */
  canonical: string
  /** User-friendly short name — what the wizard offers and chips display. */
  display: string
  /** Every other spelling we want to resolve to this entry. Used for both
   *  alias-to-canonical lookup AND for SQL ILIKE expansion in feed queries. */
  aliases: string[]
  borough: Borough
  /** Optional centroid (mirrored from geocode.ts where overlap exists). */
  lat?: number
  lng?: number
}

// -----------------------------------------------------------------------------
// Registry
// -----------------------------------------------------------------------------
//
// Notes on tricky entries:
//   - "Stuyvesant Heights" is a sub-district inside Bedford-Stuyvesant; we
//     fold it into Bed-Stuy because users / scrapers conflate them in practice.
//   - "Crown Heights North" / "Crown Heights South" are NTAs; we collapse
//     both to Crown Heights so the user-typed "Crown Heights" matches every
//     scraped listing in the area.
//   - "FiDi" is treated as a first-class display alongside "Financial District".
//   - "SoHo" / "NoHo" / "Nolita" / "FiDi" carry their casing-stripped forms
//     because scrapers normalize away the camelcase.

export const CANONICAL_NEIGHBORHOODS: CanonicalNeighborhood[] = [
  // ── Manhattan ──────────────────────────────────────────────────────────────
  {
    canonical: 'West Village',
    display: 'West Village',
    aliases: ['West Village', 'WV'],
    borough: 'Manhattan',
    lat: 40.7359,
    lng: -74.0036,
  },
  {
    canonical: 'East Village',
    display: 'East Village',
    aliases: ['East Village', 'EV'],
    borough: 'Manhattan',
    lat: 40.7264,
    lng: -73.9818,
  },
  {
    canonical: 'Greenwich Village',
    display: 'Greenwich Village',
    aliases: ['Greenwich Village', 'The Village', 'Village'],
    borough: 'Manhattan',
    lat: 40.7335,
    lng: -74.0027,
  },
  {
    canonical: 'Lower East Side',
    display: 'Lower East Side',
    aliases: ['Lower East Side', 'LES'],
    borough: 'Manhattan',
    lat: 40.715,
    lng: -73.9843,
  },
  {
    canonical: 'SoHo',
    display: 'SoHo',
    aliases: ['SoHo', 'Soho', 'South of Houston', 'So-Ho'],
    borough: 'Manhattan',
    lat: 40.7233,
    lng: -74.003,
  },
  {
    canonical: 'NoHo',
    display: 'NoHo',
    aliases: ['NoHo', 'Noho', 'North of Houston'],
    borough: 'Manhattan',
    lat: 40.728,
    lng: -73.9931,
  },
  {
    canonical: 'Nolita',
    display: 'Nolita',
    aliases: ['Nolita', 'NoLita', 'North of Little Italy'],
    borough: 'Manhattan',
    lat: 40.722,
    lng: -73.995,
  },
  {
    canonical: 'Tribeca',
    display: 'Tribeca',
    aliases: ['Tribeca', 'TriBeCa', 'Triangle Below Canal'],
    borough: 'Manhattan',
    lat: 40.7163,
    lng: -74.0086,
  },
  {
    canonical: 'Chinatown',
    display: 'Chinatown',
    aliases: ['Chinatown'],
    borough: 'Manhattan',
    lat: 40.7158,
    lng: -73.997,
  },
  {
    canonical: 'Little Italy',
    display: 'Little Italy',
    aliases: ['Little Italy'],
    borough: 'Manhattan',
    lat: 40.7191,
    lng: -73.9973,
  },
  {
    canonical: 'Two Bridges',
    display: 'Two Bridges',
    aliases: ['Two Bridges'],
    borough: 'Manhattan',
    lat: 40.7115,
    lng: -73.9925,
  },
  {
    canonical: 'Financial District',
    display: 'FiDi',
    aliases: ['Financial District', 'FiDi', 'Fidi', 'Wall Street'],
    borough: 'Manhattan',
    lat: 40.7075,
    lng: -74.0094,
  },
  {
    canonical: 'Battery Park City',
    display: 'Battery Park City',
    aliases: ['Battery Park City', 'BPC'],
    borough: 'Manhattan',
    lat: 40.7115,
    lng: -74.0163,
  },
  {
    canonical: 'Chelsea',
    display: 'Chelsea',
    aliases: ['Chelsea'],
    borough: 'Manhattan',
    lat: 40.7465,
    lng: -74.0014,
  },
  {
    canonical: "Hell's Kitchen",
    display: "Hell's Kitchen",
    aliases: ["Hell's Kitchen", 'Hells Kitchen', 'Clinton', 'Midtown West'],
    borough: 'Manhattan',
    lat: 40.7638,
    lng: -73.9918,
  },
  {
    canonical: 'Hudson Yards',
    display: 'Hudson Yards',
    aliases: ['Hudson Yards'],
    borough: 'Manhattan',
    lat: 40.7536,
    lng: -74.0014,
  },
  {
    canonical: 'Midtown',
    display: 'Midtown',
    aliases: ['Midtown', 'Midtown Manhattan'],
    borough: 'Manhattan',
    lat: 40.7549,
    lng: -73.984,
  },
  {
    canonical: 'Midtown East',
    display: 'Midtown East',
    aliases: ['Midtown East', 'Turtle Bay'],
    borough: 'Manhattan',
    lat: 40.7549,
    lng: -73.9712,
  },
  {
    canonical: 'Murray Hill',
    display: 'Murray Hill',
    aliases: ['Murray Hill'],
    borough: 'Manhattan',
    lat: 40.7479,
    lng: -73.9759,
  },
  {
    canonical: 'Kips Bay',
    display: 'Kips Bay',
    aliases: ['Kips Bay', "Kip's Bay"],
    borough: 'Manhattan',
    lat: 40.7421,
    lng: -73.9786,
  },
  {
    canonical: 'Gramercy',
    display: 'Gramercy',
    aliases: ['Gramercy', 'Gramercy Park'],
    borough: 'Manhattan',
    lat: 40.737,
    lng: -73.9813,
  },
  {
    canonical: 'Flatiron',
    display: 'Flatiron',
    aliases: ['Flatiron', 'Flatiron District'],
    borough: 'Manhattan',
    lat: 40.7411,
    lng: -73.9897,
  },
  {
    canonical: 'Union Square',
    display: 'Union Square',
    aliases: ['Union Square'],
    borough: 'Manhattan',
    lat: 40.7359,
    lng: -73.9911,
  },
  {
    canonical: 'Upper East Side',
    display: 'Upper East Side',
    aliases: ['Upper East Side', 'UES'],
    borough: 'Manhattan',
    lat: 40.7736,
    lng: -73.9566,
  },
  {
    canonical: 'Upper West Side',
    display: 'Upper West Side',
    aliases: ['Upper West Side', 'UWS'],
    borough: 'Manhattan',
    lat: 40.787,
    lng: -73.9754,
  },
  {
    canonical: 'Morningside Heights',
    display: 'Morningside Heights',
    aliases: ['Morningside Heights'],
    borough: 'Manhattan',
    lat: 40.809,
    lng: -73.9626,
  },
  {
    canonical: 'Harlem',
    display: 'Harlem',
    aliases: ['Harlem', 'Central Harlem'],
    borough: 'Manhattan',
    lat: 40.8116,
    lng: -73.9465,
  },
  {
    canonical: 'East Harlem',
    display: 'East Harlem',
    aliases: ['East Harlem', 'Spanish Harlem', 'El Barrio'],
    borough: 'Manhattan',
    lat: 40.7957,
    lng: -73.9389,
  },
  {
    canonical: 'Hamilton Heights',
    display: 'Hamilton Heights',
    aliases: ['Hamilton Heights'],
    borough: 'Manhattan',
    lat: 40.8266,
    lng: -73.9494,
  },
  {
    canonical: 'Washington Heights',
    display: 'Washington Heights',
    aliases: ['Washington Heights', 'Washington Heights South', 'Washington Heights North'],
    borough: 'Manhattan',
    lat: 40.8417,
    lng: -73.9393,
  },
  {
    canonical: 'Inwood',
    display: 'Inwood',
    aliases: ['Inwood'],
    borough: 'Manhattan',
    lat: 40.8677,
    lng: -73.9212,
  },
  {
    canonical: 'Roosevelt Island',
    display: 'Roosevelt Island',
    aliases: ['Roosevelt Island'],
    borough: 'Manhattan',
    lat: 40.7615,
    lng: -73.9501,
  },

  // ── Brooklyn ──────────────────────────────────────────────────────────────
  {
    // The most-important entry. Scraper outputs are all over the map, the user
    // profile says "Bed-Stuy", and there are 25+ active listings in the DB. We
    // canonicalize on "Bedford-Stuyvesant" because that's what the NTA tables
    // and most aggregator scrapers emit.
    canonical: 'Bedford-Stuyvesant',
    display: 'Bed-Stuy',
    aliases: [
      'Bedford-Stuyvesant',
      'Bedford Stuyvesant',
      'Bed-Stuy',
      'Bed Stuy',
      'BedStuy',
      'Bed-stuy',
      'Stuyvesant Heights',
    ],
    borough: 'Brooklyn',
    lat: 40.6872,
    lng: -73.9418,
  },
  {
    canonical: 'Williamsburg',
    display: 'Williamsburg',
    aliases: [
      'Williamsburg',
      'East Williamsburg',
      'South Williamsburg',
      'North Williamsburg',
      'Williamsburg North',
      'Williamsburg South',
    ],
    borough: 'Brooklyn',
    lat: 40.7081,
    lng: -73.9571,
  },
  {
    canonical: 'Greenpoint',
    display: 'Greenpoint',
    aliases: ['Greenpoint'],
    borough: 'Brooklyn',
    lat: 40.7295,
    lng: -73.9536,
  },
  {
    canonical: 'Bushwick',
    display: 'Bushwick',
    aliases: ['Bushwick', 'Bushwick North', 'Bushwick South', 'East Bushwick'],
    borough: 'Brooklyn',
    lat: 40.6944,
    lng: -73.9213,
  },
  {
    canonical: 'Crown Heights',
    display: 'Crown Heights',
    aliases: ['Crown Heights', 'Crown Heights North', 'Crown Heights South'],
    borough: 'Brooklyn',
    lat: 40.6694,
    lng: -73.9442,
  },
  {
    canonical: 'Prospect Heights',
    display: 'Prospect Heights',
    aliases: ['Prospect Heights'],
    borough: 'Brooklyn',
    lat: 40.6779,
    lng: -73.9682,
  },
  {
    canonical: 'Park Slope',
    display: 'Park Slope',
    aliases: ['Park Slope', 'North Park Slope', 'South Park Slope', 'Park Slope-Gowanus'],
    borough: 'Brooklyn',
    lat: 40.671,
    lng: -73.9814,
  },
  {
    canonical: 'Gowanus',
    display: 'Gowanus',
    aliases: ['Gowanus'],
    borough: 'Brooklyn',
    lat: 40.6735,
    lng: -73.9897,
  },
  {
    canonical: 'Carroll Gardens',
    display: 'Carroll Gardens',
    aliases: ['Carroll Gardens'],
    borough: 'Brooklyn',
    lat: 40.6797,
    lng: -73.9986,
  },
  {
    canonical: 'Cobble Hill',
    display: 'Cobble Hill',
    aliases: ['Cobble Hill'],
    borough: 'Brooklyn',
    lat: 40.6864,
    lng: -73.9965,
  },
  {
    canonical: 'Boerum Hill',
    display: 'Boerum Hill',
    aliases: ['Boerum Hill'],
    borough: 'Brooklyn',
    lat: 40.6849,
    lng: -73.9846,
  },
  {
    canonical: 'Brooklyn Heights',
    display: 'Brooklyn Heights',
    aliases: ['Brooklyn Heights'],
    borough: 'Brooklyn',
    lat: 40.6961,
    lng: -73.9959,
  },
  {
    canonical: 'DUMBO',
    display: 'DUMBO',
    aliases: ['DUMBO', 'Dumbo', 'Down Under the Manhattan Bridge Overpass'],
    borough: 'Brooklyn',
    lat: 40.7033,
    lng: -73.9881,
  },
  {
    canonical: 'Vinegar Hill',
    display: 'Vinegar Hill',
    aliases: ['Vinegar Hill'],
    borough: 'Brooklyn',
    lat: 40.7034,
    lng: -73.9826,
  },
  {
    canonical: 'Fort Greene',
    display: 'Fort Greene',
    aliases: ['Fort Greene', 'Ft Greene', 'Ft. Greene'],
    borough: 'Brooklyn',
    lat: 40.6909,
    lng: -73.9743,
  },
  {
    canonical: 'Clinton Hill',
    display: 'Clinton Hill',
    aliases: ['Clinton Hill'],
    borough: 'Brooklyn',
    lat: 40.6884,
    lng: -73.9665,
  },
  {
    canonical: 'Flatbush',
    display: 'Flatbush',
    aliases: ['Flatbush', 'Prospect Lefferts Gardens', 'PLG'],
    borough: 'Brooklyn',
    lat: 40.6404,
    lng: -73.9573,
  },
  {
    canonical: 'East Flatbush',
    display: 'East Flatbush',
    aliases: ['East Flatbush'],
    borough: 'Brooklyn',
    lat: 40.6499,
    lng: -73.9342,
  },
  {
    canonical: 'Ditmas Park',
    display: 'Ditmas Park',
    aliases: ['Ditmas Park'],
    borough: 'Brooklyn',
    lat: 40.6356,
    lng: -73.9602,
  },
  {
    canonical: 'Sunset Park',
    display: 'Sunset Park',
    aliases: ['Sunset Park', 'Sunset Park West', 'Sunset Park East'],
    borough: 'Brooklyn',
    lat: 40.6481,
    lng: -74.0107,
  },
  {
    canonical: 'Red Hook',
    display: 'Red Hook',
    aliases: ['Red Hook'],
    borough: 'Brooklyn',
    lat: 40.6743,
    lng: -74.0102,
  },
  {
    canonical: 'Windsor Terrace',
    display: 'Windsor Terrace',
    aliases: ['Windsor Terrace'],
    borough: 'Brooklyn',
    lat: 40.6553,
    lng: -73.978,
  },
  {
    canonical: 'Kensington',
    display: 'Kensington',
    aliases: ['Kensington'],
    borough: 'Brooklyn',
    lat: 40.6395,
    lng: -73.9728,
  },
  {
    canonical: 'Bay Ridge',
    display: 'Bay Ridge',
    aliases: ['Bay Ridge'],
    borough: 'Brooklyn',
    lat: 40.6258,
    lng: -74.029,
  },
  {
    canonical: 'Bensonhurst',
    display: 'Bensonhurst',
    aliases: ['Bensonhurst'],
    borough: 'Brooklyn',
    lat: 40.6027,
    lng: -73.9986,
  },
  {
    canonical: 'Borough Park',
    display: 'Borough Park',
    aliases: ['Borough Park', 'Boro Park'],
    borough: 'Brooklyn',
    lat: 40.6336,
    lng: -73.9905,
  },
  {
    canonical: 'Sheepshead Bay',
    display: 'Sheepshead Bay',
    aliases: ['Sheepshead Bay'],
    borough: 'Brooklyn',
    lat: 40.5862,
    lng: -73.9527,
  },
  {
    canonical: 'Brighton Beach',
    display: 'Brighton Beach',
    aliases: ['Brighton Beach'],
    borough: 'Brooklyn',
    lat: 40.5781,
    lng: -73.9608,
  },
  {
    canonical: 'Coney Island',
    display: 'Coney Island',
    aliases: ['Coney Island'],
    borough: 'Brooklyn',
    lat: 40.5755,
    lng: -73.9707,
  },
  {
    canonical: 'Gravesend',
    display: 'Gravesend',
    aliases: ['Gravesend'],
    borough: 'Brooklyn',
    lat: 40.5953,
    lng: -73.9706,
  },

  // ── Queens ────────────────────────────────────────────────────────────────
  {
    canonical: 'Astoria',
    display: 'Astoria',
    aliases: ['Astoria'],
    borough: 'Queens',
    lat: 40.772,
    lng: -73.9302,
  },
  {
    canonical: 'Long Island City',
    display: 'LIC',
    aliases: ['Long Island City', 'LIC', 'L.I.C.'],
    borough: 'Queens',
    lat: 40.7447,
    lng: -73.9485,
  },
  {
    canonical: 'Hunters Point',
    display: 'Hunters Point',
    aliases: ['Hunters Point', "Hunter's Point"],
    borough: 'Queens',
    lat: 40.7432,
    lng: -73.9573,
  },
  {
    canonical: 'Sunnyside',
    display: 'Sunnyside',
    aliases: ['Sunnyside'],
    borough: 'Queens',
    lat: 40.7434,
    lng: -73.9196,
  },
  {
    canonical: 'Woodside',
    display: 'Woodside',
    aliases: ['Woodside'],
    borough: 'Queens',
    lat: 40.7459,
    lng: -73.9054,
  },
  {
    canonical: 'Jackson Heights',
    display: 'Jackson Heights',
    aliases: ['Jackson Heights'],
    borough: 'Queens',
    lat: 40.7556,
    lng: -73.883,
  },
  {
    canonical: 'Elmhurst',
    display: 'Elmhurst',
    aliases: ['Elmhurst'],
    borough: 'Queens',
    lat: 40.737,
    lng: -73.877,
  },
  {
    canonical: 'Corona',
    display: 'Corona',
    aliases: ['Corona'],
    borough: 'Queens',
    lat: 40.7462,
    lng: -73.8636,
  },
  {
    canonical: 'Forest Hills',
    display: 'Forest Hills',
    aliases: ['Forest Hills'],
    borough: 'Queens',
    lat: 40.7187,
    lng: -73.8448,
  },
  {
    canonical: 'Rego Park',
    display: 'Rego Park',
    aliases: ['Rego Park'],
    borough: 'Queens',
    lat: 40.728,
    lng: -73.8615,
  },
  {
    canonical: 'Flushing',
    display: 'Flushing',
    aliases: ['Flushing'],
    borough: 'Queens',
    lat: 40.7654,
    lng: -73.8318,
  },
  {
    canonical: 'Ridgewood',
    display: 'Ridgewood',
    aliases: ['Ridgewood'],
    borough: 'Queens',
    lat: 40.7022,
    lng: -73.9035,
  },
  {
    canonical: 'Maspeth',
    display: 'Maspeth',
    aliases: ['Maspeth'],
    borough: 'Queens',
    lat: 40.7222,
    lng: -73.909,
  },

  // ── Bronx ─────────────────────────────────────────────────────────────────
  {
    canonical: 'Mott Haven',
    display: 'Mott Haven',
    aliases: ['Mott Haven'],
    borough: 'Bronx',
    lat: 40.8095,
    lng: -73.9226,
  },
  {
    canonical: 'South Bronx',
    display: 'South Bronx',
    aliases: ['South Bronx', 'SoBro'],
    borough: 'Bronx',
    lat: 40.816,
    lng: -73.9088,
  },
  {
    canonical: 'Concourse',
    display: 'Concourse',
    aliases: ['Concourse', 'Grand Concourse'],
    borough: 'Bronx',
    lat: 40.8311,
    lng: -73.9211,
  },
  {
    canonical: 'Fordham',
    display: 'Fordham',
    aliases: ['Fordham'],
    borough: 'Bronx',
    lat: 40.8617,
    lng: -73.899,
  },
  {
    canonical: 'Belmont',
    display: 'Belmont',
    aliases: ['Belmont', 'Little Italy of the Bronx'],
    borough: 'Bronx',
    lat: 40.854,
    lng: -73.886,
  },
  {
    canonical: 'Riverdale',
    display: 'Riverdale',
    aliases: ['Riverdale'],
    borough: 'Bronx',
    lat: 40.899,
    lng: -73.912,
  },
  {
    canonical: 'Kingsbridge',
    display: 'Kingsbridge',
    aliases: ['Kingsbridge'],
    borough: 'Bronx',
    lat: 40.881,
    lng: -73.902,
  },
  {
    canonical: 'Pelham Bay',
    display: 'Pelham Bay',
    aliases: ['Pelham Bay'],
    borough: 'Bronx',
    lat: 40.854,
    lng: -73.833,
  },

  // ── Staten Island ─────────────────────────────────────────────────────────
  {
    canonical: 'St. George',
    display: 'St. George',
    aliases: ['St. George', 'St George', 'Saint George'],
    borough: 'Staten Island',
    lat: 40.6437,
    lng: -74.0764,
  },
  {
    canonical: 'Stapleton',
    display: 'Stapleton',
    aliases: ['Stapleton'],
    borough: 'Staten Island',
    lat: 40.6271,
    lng: -74.0758,
  },
]

// -----------------------------------------------------------------------------
// Internal: O(1) lookup index built once at module load.
// -----------------------------------------------------------------------------

/** Lowercased + punctuation-collapsed key → canonical record. */
const ALIAS_INDEX: Map<string, CanonicalNeighborhood> = (() => {
  const m = new Map<string, CanonicalNeighborhood>()
  for (const n of CANONICAL_NEIGHBORHOODS) {
    // Index canonical, display, AND every alias.
    const keys = new Set([n.canonical, n.display, ...n.aliases])
    for (const k of keys) {
      const norm = normalizeKey(k)
      if (norm) m.set(norm, n)
    }
  }
  return m
})()

/**
 * Lower-case, strip punctuation, collapse whitespace. The same shape we
 * compare against for both lookup and SQL alias expansion.
 */
function normalizeKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/[.'`]/g, '')
    .replace(/[-_/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

/**
 * Resolve any user / scraper-emitted neighborhood string to the canonical
 * record. Returns null when nothing matches — caller decides whether to drop
 * the listing, leave the column null, or keep the original string.
 */
export function resolveNeighborhood(
  input: string | null | undefined,
): CanonicalNeighborhood | null {
  if (!input) return null
  const norm = normalizeKey(input)
  if (!norm) return null
  return ALIAS_INDEX.get(norm) ?? null
}

/**
 * Used at INGEST time. Returns the canonical name (not the display) so the
 * `listings.neighborhood` column converges to one form per area over time.
 * Returns null on miss — caller should keep the original string OR null.
 */
export function canonicalize(
  input: string | null | undefined,
): string | null {
  const hit = resolveNeighborhood(input)
  return hit ? hit.canonical : null
}

/**
 * Expand a list of UI-friendly display names to the FULL alias set used by the
 * SQL filter. The feed query does `lower(neighborhood) ILIKE ANY (...)` against
 * the returned strings — so once a neighborhood resolves, every alias is in
 * play (covering both legacy un-canonicalized DB rows and freshly-canonicalized
 * ones).
 *
 * Example:
 *   expandToAliases(['Bed-Stuy', 'SoHo'])
 *   → ['Bedford-Stuyvesant', 'Bedford Stuyvesant', 'Bed-Stuy', 'Bed Stuy',
 *      'BedStuy', 'Stuyvesant Heights', 'SoHo', 'Soho', 'South of Houston', ...]
 *
 * Unknown inputs pass through unchanged so a user-typed neighborhood we
 * haven't catalogued still matches by raw substring.
 */
export function expandToAliases(displayNames: string[]): string[] {
  const out = new Set<string>()
  for (const name of displayNames) {
    if (!name || typeof name !== 'string') continue
    const trimmed = name.trim()
    if (!trimmed) continue
    const hit = resolveNeighborhood(trimmed)
    if (hit) {
      out.add(hit.canonical)
      out.add(hit.display)
      for (const a of hit.aliases) out.add(a)
    } else {
      // Pass unknown neighborhoods through as-is. Better to over-match than
      // miss the user's intent.
      out.add(trimmed)
    }
  }
  return Array.from(out)
}

/**
 * Group canonical neighborhoods by borough — used by the "+ Add area" picker
 * and the areas-modal so the user can navigate by borough first.
 */
export function neighborhoodsByBorough(): Record<Borough, CanonicalNeighborhood[]> {
  const out: Record<Borough, CanonicalNeighborhood[]> = {
    Manhattan: [],
    Brooklyn: [],
    Queens: [],
    Bronx: [],
    'Staten Island': [],
  }
  for (const n of CANONICAL_NEIGHBORHOODS) out[n.borough].push(n)
  for (const b of Object.keys(out) as Borough[]) {
    out[b].sort((a, b) => a.display.localeCompare(b.display))
  }
  return out
}

/**
 * Display-name lookup — used by the chip row to map a stored canonical
 * neighborhood name (from the DB count aggregate) back to the friendly form.
 */
export function displayName(input: string | null | undefined): string | null {
  if (!input) return null
  const hit = resolveNeighborhood(input)
  return hit ? hit.display : input.trim() || null
}
