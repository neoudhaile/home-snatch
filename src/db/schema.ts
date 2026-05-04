import {
  pgTable,
  uuid,
  text,
  integer,
  numeric,
  timestamp,
  jsonb,
  boolean,
  real,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core'

export type Contact = {
  name?: string
  phone?: string
  email?: string
  agency?: string
  website?: string
  preferred_method?: 'phone' | 'email' | 'website' | 'in-person'
}

export type Application = {
  url?: string
  requirements?: string
  fee?: number
  broker_fee_pct?: number
  broker_fee_text?: string
  required_docs?: string[]
  notes?: string
}

export const listings = pgTable(
  'listings',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    source: text('source').notNull(),
    source_url: text('source_url').notNull(),
    title: text('title').notNull(),
    description: text('description'),
    price_monthly: integer('price_monthly'),
    beds: numeric('beds', { precision: 3, scale: 1 }),
    baths: numeric('baths', { precision: 3, scale: 1 }),
    sqft: integer('sqft'),
    available_date: timestamp('available_date'),
    lease_term: text('lease_term'),
    furnished: boolean('furnished'),
    pet_friendly: boolean('pet_friendly'),
    amenities: jsonb('amenities').$type<string[]>().default([]),
    photos: jsonb('photos').$type<string[]>().notNull().default([]),
    address: text('address'),
    unit: text('unit'),
    neighborhood: text('neighborhood'),
    borough: text('borough'),
    zip: text('zip'),
    lat: real('lat'),
    lng: real('lng'),
    contact: jsonb('contact').$type<Contact>(),
    application: jsonb('application').$type<Application>(),
    posted_at: timestamp('posted_at'),
    fetched_at: timestamp('fetched_at').defaultNow().notNull(),
    last_seen_at: timestamp('last_seen_at').defaultNow().notNull(),
    is_active: boolean('is_active').notNull().default(true),
    raw: jsonb('raw'),
  },
  (t) => ({
    source_url_unique: uniqueIndex('listings_source_url_unique').on(t.source_url),
    posted_at_idx: index('listings_posted_at_idx').on(t.posted_at),
    borough_idx: index('listings_borough_idx').on(t.borough),
    is_active_idx: index('listings_is_active_idx').on(t.is_active),
  })
)

export const profiles = pgTable('profiles', {
  id: uuid('id').defaultRandom().primaryKey(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  budget_min: integer('budget_min'),
  budget_max: integer('budget_max'),
  beds_min: numeric('beds_min', { precision: 3, scale: 1 }),
  beds_max: numeric('beds_max', { precision: 3, scale: 1 }),
  must_have: jsonb('must_have').$type<string[]>().default([]),
  nice_to_have: jsonb('nice_to_have').$type<string[]>().default([]),
  deal_breakers: jsonb('deal_breakers').$type<string[]>().default([]),
  vibes: jsonb('vibes').$type<Record<string, number>>().default({}),
  commute: jsonb('commute')
    .$type<{ to: string; lat?: number; lng?: number; max_minutes: number; modes: ('subway' | 'walk' | 'bike')[] }[]>()
    .default([]),
  preferred_areas: jsonb('preferred_areas').$type<string[]>().default([]),
  notes: text('notes'),
  raw_jsonb: jsonb('raw_jsonb'),
})

export const scores = pgTable(
  'scores',
  {
    listing_id: uuid('listing_id')
      .notNull()
      .references(() => listings.id, { onDelete: 'cascade' }),
    profile_set_hash: text('profile_set_hash').notNull(),
    score: integer('score').notNull(),
    headline: text('headline').notNull(),
    concerns: text('concerns'),
    rationale_jsonb: jsonb('rationale_jsonb'),
    computed_at: timestamp('computed_at').defaultNow().notNull(),
  },
  (t) => ({
    pk: uniqueIndex('scores_pk').on(t.listing_id, t.profile_set_hash),
    score_desc_idx: index('scores_score_desc_idx').on(t.score),
  })
)

export const neighborhood_vibes = pgTable('neighborhood_vibes', {
  nta_code: text('nta_code').primaryKey(),
  nta_name: text('nta_name').notNull(),
  borough: text('borough').notNull(),
  noise: real('noise'),
  walkability: real('walkability'),
  greenness: real('greenness'),
  nightlife: real('nightlife'),
  cafes: real('cafes'),
  family_score: real('family_score'),
  computed_at: timestamp('computed_at').defaultNow().notNull(),
  geom_geojson: jsonb('geom_geojson'),
  centroid_lat: real('centroid_lat'),
  centroid_lng: real('centroid_lng'),
})

export const subway_stations = pgTable('subway_stations', {
  stop_id: text('stop_id').primaryKey(),
  name: text('name').notNull(),
  lat: real('lat').notNull(),
  lng: real('lng').notNull(),
  lines: jsonb('lines').$type<string[]>().default([]),
})

export const hpd_violations = pgTable('hpd_violations', {
  bbl: text('bbl').primaryKey(),
  address: text('address'),
  count_12mo: integer('count_12mo').notNull(),
  last_seen: timestamp('last_seen'),
})

export const rent_stabilized_buildings = pgTable('rent_stabilized_buildings', {
  bbl: text('bbl').primaryKey(),
  address: text('address'),
  units: integer('units'),
})

export const saved_listings = pgTable(
  'saved_listings',
  {
    listing_id: uuid('listing_id')
      .notNull()
      .references(() => listings.id, { onDelete: 'cascade' }),
    saved_by: text('saved_by').notNull(),
    saved_at: timestamp('saved_at').defaultNow().notNull(),
    notes: text('notes'),
  },
  (t) => ({
    pk: uniqueIndex('saved_listings_pk').on(t.listing_id, t.saved_by),
  })
)
