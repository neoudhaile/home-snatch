import type {
  listings,
  profiles,
  scores,
  neighborhood_vibes,
  subway_stations,
  hpd_violations,
  rent_stabilized_buildings,
  saved_listings,
  Contact,
  Application,
} from '@/db/schema'

export type Listing = typeof listings.$inferSelect
export type NewListing = typeof listings.$inferInsert
export type Profile = typeof profiles.$inferSelect
export type NewProfile = typeof profiles.$inferInsert
export type Score = typeof scores.$inferSelect
export type NewScore = typeof scores.$inferInsert
export type NeighborhoodVibe = typeof neighborhood_vibes.$inferSelect
export type SubwayStation = typeof subway_stations.$inferSelect
export type HpdViolation = typeof hpd_violations.$inferSelect
export type RentStabilizedBuilding = typeof rent_stabilized_buildings.$inferSelect
export type SavedListing = typeof saved_listings.$inferSelect

export type { Contact, Application }

export type RankedListing = Listing & {
  score: Score
  vibe: NeighborhoodVibe | null
  nearest_subway?: { stop_id: string; name: string; lines: string[]; distance_m: number } | null
  hpd_count_12mo?: number | null
  rent_stabilized?: boolean
  freshness_hours?: number
}

export type ProfileSet = {
  profiles: Profile[]
  hash: string
}

export const SOURCES = [
  'craigslist',
  'reddit',
  'listings-project',
  'streeteasy',
  'zillow',
  'trulia',
  'apartments',
  'manual',
] as const
export type Source = (typeof SOURCES)[number]
