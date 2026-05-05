import type { RankedListing, Source } from '@/types'
import * as real from '@/lib/listing-helpers'
import type { NeighborhoodCounts } from '@/lib/listing-helpers'
import { canonicalize } from '@/lib/neighborhoods'
import { unstable_cache } from 'next/cache'

/**
 * Feed data — real-DB first, mock fallback.
 *
 * If `DATABASE_URL` is set and the DB query succeeds, returns real listings.
 * Otherwise (or on DB error) falls back to the 12 hardcoded mock NYC listings
 * below so design-time iteration works without provisioning Supabase.
 *
 * Photos in the mocks are Unsplash URLs (no auth). Real listings carry the
 * scraped CDN URLs — `next.config.ts` whitelist covers both.
 */

const NYC_PHOTOS = {
  brick_living: 'https://images.unsplash.com/photo-1502672260266-1c1ef2d93688?w=1600&q=80',
  loft: 'https://images.unsplash.com/photo-1513694203232-719a280e022f?w=1600&q=80',
  kitchen_white: 'https://images.unsplash.com/photo-1556909114-f6e7ad7d3136?w=1600&q=80',
  bedroom_warm: 'https://images.unsplash.com/photo-1522708323590-d24dbb6b0267?w=1600&q=80',
  brownstone_ext: 'https://images.unsplash.com/photo-1493809842364-78817add7ffb?w=1600&q=80',
  bath: 'https://images.unsplash.com/photo-1552321554-5fefe8c9ef14?w=1600&q=80',
  sunny_studio: 'https://images.unsplash.com/photo-1505691938895-1758d7feb511?w=1600&q=80',
  industrial: 'https://images.unsplash.com/photo-1494203484021-3c454daf695d?w=1600&q=80',
  prewar: 'https://images.unsplash.com/photo-1560448204-e02f11c3d0e2?w=1600&q=80',
  bk_interior: 'https://images.unsplash.com/photo-1567767292278-a4f21aa2d36e?w=1600&q=80',
  hardwood: 'https://images.unsplash.com/photo-1494526585095-c41746248156?w=1600&q=80',
  cozy_couch: 'https://images.unsplash.com/photo-1484101403633-562f891dc89a?w=1600&q=80',
  street_view: 'https://images.unsplash.com/photo-1505761671935-60b3a7427bad?w=1600&q=80',
  natural_light: 'https://images.unsplash.com/photo-1554995207-c18c203602cb?w=1600&q=80',
  nyc_street: 'https://images.unsplash.com/photo-1539367628448-4bc5c9d171c8?w=1600&q=80',
  small_kitchen: 'https://images.unsplash.com/photo-1556912173-3bb406ef7e77?w=1600&q=80',
} as const

type Mock = Omit<RankedListing, 'fetched_at' | 'last_seen_at'> & {
  fetched_at: Date
  last_seen_at: Date
}

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const now = Date.now()

const mocks: Mock[] = [
  {
    id: 'a1f0c000-0000-4000-8000-000000000001',
    source: 'streeteasy',
    source_url: 'https://streeteasy.com/listings/example/1',
    title: 'Sun-bombed 1br over the Q at Beverley Rd',
    description:
      'Top-floor walk-up in a four-unit prewar; landlord lives downstairs. South and east exposures, working radiators, dishwasher, in-unit laundry. Dogs OK with deposit.',
    price_monthly: 2895,
    beds: '1.0',
    baths: '1.0',
    sqft: 720,
    available_date: new Date(now + 14 * DAY),
    lease_term: '12 months',
    furnished: false,
    pet_friendly: true,
    amenities: ['dishwasher', 'in-unit-laundry', 'natural-light', 'pet-friendly'],
    photos: [NYC_PHOTOS.natural_light, NYC_PHOTOS.brick_living, NYC_PHOTOS.kitchen_white, NYC_PHOTOS.bedroom_warm],
    address: '320 E 18th St',
    unit: '4R',
    neighborhood: 'Ditmas Park',
    borough: 'Brooklyn',
    zip: '11226',
    lat: 40.6346,
    lng: -73.9621,
    contact: {
      name: 'Maria Velez',
      phone: '+1-718-555-0142',
      email: 'maria@velezrealty.nyc',
      agency: 'Velez Realty',
      preferred_method: 'email',
    },
    application: {
      url: 'https://streeteasy.com/listings/example/1/apply',
      fee: 75,
      broker_fee_pct: 0,
      broker_fee_text: 'No broker fee',
      required_docs: ['Photo ID', 'Last 2 paystubs', 'Reference letter', 'Bank statement'],
      notes: 'Landlord prefers 40x rent income.',
    },
    posted_at: new Date(now - 18 * HOUR),
    fetched_at: new Date(now - 1 * HOUR),
    last_seen_at: new Date(now - 30 * 60 * 1000),
    is_active: true,
    raw: null,
    score: {
      listing_id: 'a1f0c000-0000-4000-8000-000000000001',
      profile_set_hash: 'mock',
      score: 92,
      headline: '4 stops to Atlantic on the Q, dishwasher, $200 under your stretch.',
      concerns: 'Top floor, fourth-floor walk-up. Heat is radiator-only.',
      rationale_jsonb: {
        top_facts: [
          '4 stops to Atlantic on the Q (express transfer at DeKalb)',
          'In-unit laundry + dishwasher (both in must-haves)',
          '0% broker fee, $2,895/mo (below your $3,100 stretch)',
        ],
      },
      computed_at: new Date(now - 30 * 60 * 1000),
    },
    vibe: {
      nta_code: 'BK17',
      nta_name: 'Ditmas Park',
      borough: 'Brooklyn',
      noise: 0.32,
      walkability: 0.78,
      greenness: 0.65,
      nightlife: 0.42,
      cafes: 0.71,
      family_score: 0.74,
      computed_at: new Date(),
      geom_geojson: null,
      centroid_lat: 40.6346,
      centroid_lng: -73.9621,
    },
    nearest_subway: { stop_id: 'D29', name: 'Beverley Rd', lines: ['Q'], distance_m: 180 },
    hpd_count_12mo: 2,
    rent_stabilized: true,
    freshness_hours: 18,
  },
  {
    id: 'a1f0c000-0000-4000-8000-000000000002',
    source: 'craigslist',
    source_url: 'https://newyork.craigslist.org/brk/apa/d/example/2.html',
    title: '2br railroad in Bed-Stuy, between A and J',
    description:
      'Recently painted, hardwood throughout, dishwasher, no laundry in building (laundromat 2 blocks). Owner-occupied brownstone. Quiet block.',
    price_monthly: 3200,
    beds: '2.0',
    baths: '1.0',
    sqft: 850,
    available_date: new Date(now + 21 * DAY),
    lease_term: '12 months',
    furnished: false,
    pet_friendly: false,
    amenities: ['dishwasher', 'hardwood', 'natural-light'],
    photos: [NYC_PHOTOS.brownstone_ext, NYC_PHOTOS.hardwood, NYC_PHOTOS.cozy_couch],
    address: '672 Halsey St',
    unit: '2',
    neighborhood: 'Bedford-Stuyvesant',
    borough: 'Brooklyn',
    zip: '11233',
    lat: 40.6824,
    lng: -73.9266,
    contact: {
      name: 'Jeff (owner)',
      phone: '+1-347-555-0188',
      preferred_method: 'phone',
    },
    application: {
      fee: 50,
      broker_fee_pct: 0,
      broker_fee_text: 'No broker fee',
      required_docs: ['Last 2 paystubs', 'Photo ID'],
      notes: 'Owner does informal screening, no application portal.',
    },
    posted_at: new Date(now - 6 * HOUR),
    fetched_at: new Date(now - 2 * HOUR),
    last_seen_at: new Date(now - 15 * 60 * 1000),
    is_active: true,
    raw: null,
    score: {
      listing_id: 'a1f0c000-0000-4000-8000-000000000002',
      profile_set_hash: 'mock',
      score: 86,
      headline: '2br in your range, owner-occupied brownstone, no broker fee.',
      concerns: 'No laundry in building. Closest J/Z is 12 minutes on foot.',
      rationale_jsonb: {
        top_facts: [
          '2br at $3,200 (within your joint budget)',
          'Owner-occupied = lower turnover, fewer surprises',
          '0% broker fee on a brownstone is rare',
        ],
      },
      computed_at: new Date(now - 1 * HOUR),
    },
    vibe: {
      nta_code: 'BK75',
      nta_name: 'Bedford-Stuyvesant',
      borough: 'Brooklyn',
      noise: 0.48,
      walkability: 0.82,
      greenness: 0.42,
      nightlife: 0.58,
      cafes: 0.73,
      family_score: 0.61,
      computed_at: new Date(),
      geom_geojson: null,
      centroid_lat: 40.6824,
      centroid_lng: -73.9266,
    },
    nearest_subway: { stop_id: 'A50', name: 'Utica Av', lines: ['A', 'C'], distance_m: 540 },
    hpd_count_12mo: 0,
    rent_stabilized: false,
    freshness_hours: 6,
  },
  {
    id: 'a1f0c000-0000-4000-8000-000000000003',
    source: 'listings-project',
    source_url: 'https://www.listingsproject.com/listings/example/3',
    title: 'Loft share in Greenpoint, artist building',
    description:
      'Big windows, exposed brick, freight elevator. Two existing roommates, both ceramicists. Looking for one chill person, no morning radio. Clean shared kitchen, one bath.',
    price_monthly: 1850,
    beds: '1.0',
    baths: '1.0',
    sqft: 280,
    available_date: new Date(now + 7 * DAY),
    lease_term: 'flexible',
    furnished: true,
    pet_friendly: false,
    amenities: ['elevator', 'natural-light', 'roof-access'],
    photos: [NYC_PHOTOS.loft, NYC_PHOTOS.industrial],
    address: '67 West St',
    unit: '5F',
    neighborhood: 'Greenpoint',
    borough: 'Brooklyn',
    zip: '11222',
    lat: 40.7395,
    lng: -73.957,
    contact: {
      email: 'apt67west@listingsproject.com',
      preferred_method: 'email',
    },
    application: {
      requirements: 'Coffee with the existing roommates first. Decision in a week.',
      broker_fee_pct: 0,
      required_docs: [],
      notes: 'No formal application, vibe-based.',
    },
    posted_at: new Date(now - 2 * DAY),
    fetched_at: new Date(now - 1 * DAY),
    last_seen_at: new Date(now - 30 * 60 * 1000),
    is_active: true,
    raw: null,
    score: {
      listing_id: 'a1f0c000-0000-4000-8000-000000000003',
      profile_set_hash: 'mock',
      score: 79,
      headline: '$1,850 share in Greenpoint, freight elevator, roof.',
      concerns: '280 sqft is tight. Shared kitchen with two strangers.',
      rationale_jsonb: {
        top_facts: [
          'Greenpoint is in your preferred areas',
          'No broker fee, casual screening',
          'G train + B62 bus access',
        ],
      },
      computed_at: new Date(now - 1 * HOUR),
    },
    vibe: {
      nta_code: 'BK76',
      nta_name: 'Greenpoint',
      borough: 'Brooklyn',
      noise: 0.55,
      walkability: 0.85,
      greenness: 0.55,
      nightlife: 0.72,
      cafes: 0.88,
      family_score: 0.45,
      computed_at: new Date(),
      geom_geojson: null,
      centroid_lat: 40.7395,
      centroid_lng: -73.957,
    },
    nearest_subway: { stop_id: 'G26', name: 'Greenpoint Av', lines: ['G'], distance_m: 290 },
    hpd_count_12mo: 1,
    rent_stabilized: false,
    freshness_hours: 48,
  },
  {
    id: 'a1f0c000-0000-4000-8000-000000000004',
    source: 'streeteasy',
    source_url: 'https://streeteasy.com/listings/example/4',
    title: '1br with private outdoor space, Crown Heights',
    description:
      'Garden-level with a 200 sqft patio. Brick floors in the kitchen, exposed beams. Stabilized building, low turnover.',
    price_monthly: 2750,
    beds: '1.0',
    baths: '1.0',
    sqft: 640,
    available_date: new Date(now + 30 * DAY),
    lease_term: '12 months',
    furnished: false,
    pet_friendly: true,
    amenities: ['outdoor-space', 'dishwasher', 'pet-friendly'],
    photos: [NYC_PHOTOS.bk_interior, NYC_PHOTOS.kitchen_white, NYC_PHOTOS.brownstone_ext],
    address: '1244 President St',
    unit: '1G',
    neighborhood: 'Crown Heights',
    borough: 'Brooklyn',
    zip: '11213',
    lat: 40.6716,
    lng: -73.9405,
    contact: {
      name: 'Andrea Park',
      email: 'andrea@parkrealty.com',
      agency: 'Park Realty',
      preferred_method: 'email',
    },
    application: {
      url: 'https://streeteasy.com/listings/example/4/apply',
      fee: 100,
      broker_fee_pct: 12,
      broker_fee_text: '12% broker fee',
      required_docs: ['Photo ID', 'Tax return', 'Letter of employment', 'Bank statement'],
    },
    posted_at: new Date(now - 4 * DAY),
    fetched_at: new Date(now - 3 * DAY),
    last_seen_at: new Date(now - 1 * HOUR),
    is_active: true,
    raw: null,
    score: {
      listing_id: 'a1f0c000-0000-4000-8000-000000000004',
      profile_set_hash: 'mock',
      score: 81,
      headline: 'Private patio for $2,750, rent-stabilized building.',
      concerns: '12% broker fee adds $3,960 upfront.',
      rationale_jsonb: {
        top_facts: [
          'Garden-level with 200 sqft outdoor (rare in your range)',
          'Rent-stabilized building (legal increase cap)',
          'Crown Heights is in your preferred areas',
        ],
      },
      computed_at: new Date(now - 30 * 60 * 1000),
    },
    vibe: {
      nta_code: 'BK61',
      nta_name: 'Crown Heights North',
      borough: 'Brooklyn',
      noise: 0.51,
      walkability: 0.84,
      greenness: 0.48,
      nightlife: 0.64,
      cafes: 0.79,
      family_score: 0.59,
      computed_at: new Date(),
      geom_geojson: null,
      centroid_lat: 40.6716,
      centroid_lng: -73.9405,
    },
    nearest_subway: { stop_id: '247', name: 'Kingston Av', lines: ['3'], distance_m: 410 },
    hpd_count_12mo: 4,
    rent_stabilized: true,
    freshness_hours: 4 * 24,
  },
  {
    id: 'a1f0c000-0000-4000-8000-000000000005',
    source: 'reddit',
    source_url: 'https://reddit.com/r/NYCapartments/comments/example5',
    title: 'Studio in Astoria, 5 min to N/W',
    description:
      'Compact studio, 360 sqft. Big window, hardwood. Building is mid-rise, has elevator and laundry on basement floor. Lease starts June 1.',
    price_monthly: 2100,
    beds: '0.0',
    baths: '1.0',
    sqft: 360,
    available_date: new Date(now + 14 * DAY),
    lease_term: '12 months',
    furnished: false,
    pet_friendly: false,
    amenities: ['elevator', 'laundry-in-building'],
    photos: [NYC_PHOTOS.sunny_studio, NYC_PHOTOS.small_kitchen],
    address: '30-42 31st St',
    unit: '3D',
    neighborhood: 'Astoria',
    borough: 'Queens',
    zip: '11102',
    lat: 40.7644,
    lng: -73.9235,
    contact: {
      name: 'u/queens_landlord_98',
      preferred_method: 'website',
      website: 'https://reddit.com/message/compose/?to=queens_landlord_98',
    },
    application: {
      requirements: 'DM through Reddit, open house Saturday.',
      fee: 0,
      broker_fee_pct: 0,
    },
    posted_at: new Date(now - 11 * HOUR),
    fetched_at: new Date(now - 5 * HOUR),
    last_seen_at: new Date(now - 1 * HOUR),
    is_active: true,
    raw: null,
    score: {
      listing_id: 'a1f0c000-0000-4000-8000-000000000005',
      profile_set_hash: 'mock',
      score: 73,
      headline: 'Studio at $2,100, 5 min walk to 30 Av N/W.',
      concerns: '360 sqft, no in-unit laundry, no contact phone or email.',
      rationale_jsonb: {
        top_facts: [
          'Solo unit cheap enough that one of you could take it as plan B',
          'N/W gets you to FiDi in 22 min',
          'Reddit-only contact: harder to verify',
        ],
      },
      computed_at: new Date(now - 1 * HOUR),
    },
    vibe: {
      nta_code: 'QN72',
      nta_name: 'Astoria',
      borough: 'Queens',
      noise: 0.41,
      walkability: 0.86,
      greenness: 0.39,
      nightlife: 0.69,
      cafes: 0.81,
      family_score: 0.66,
      computed_at: new Date(),
      geom_geojson: null,
      centroid_lat: 40.7644,
      centroid_lng: -73.9235,
    },
    nearest_subway: { stop_id: 'R04', name: '30 Av', lines: ['N', 'W'], distance_m: 280 },
    hpd_count_12mo: 0,
    rent_stabilized: false,
    freshness_hours: 11,
  },
  {
    id: 'a1f0c000-0000-4000-8000-000000000006',
    source: 'streeteasy',
    source_url: 'https://streeteasy.com/listings/example/6',
    title: '2br on Manhattan Ave, Greenpoint',
    description:
      'Renovated kitchen, dishwasher, in-unit washer-dryer. Building has roof access. Both bedrooms are real (separate, with windows).',
    price_monthly: 3850,
    beds: '2.0',
    baths: '1.0',
    sqft: 920,
    available_date: new Date(now + 45 * DAY),
    lease_term: '12 months',
    furnished: false,
    pet_friendly: true,
    amenities: ['dishwasher', 'in-unit-laundry', 'roof-access', 'pet-friendly'],
    photos: [NYC_PHOTOS.prewar, NYC_PHOTOS.bedroom_warm, NYC_PHOTOS.kitchen_white],
    address: '795 Manhattan Ave',
    unit: '4B',
    neighborhood: 'Greenpoint',
    borough: 'Brooklyn',
    zip: '11222',
    lat: 40.7269,
    lng: -73.9526,
    contact: {
      name: 'Liang Cho',
      email: 'liang@chorealestate.com',
      agency: 'Cho Real Estate',
      phone: '+1-718-555-0166',
      preferred_method: 'phone',
    },
    application: {
      url: 'https://streeteasy.com/listings/example/6/apply',
      fee: 75,
      broker_fee_pct: 15,
      broker_fee_text: '15% broker fee',
      required_docs: ['Photo ID', 'Last 2 paystubs', 'Tax return', 'Reference'],
    },
    posted_at: new Date(now - 7 * DAY),
    fetched_at: new Date(now - 7 * DAY),
    last_seen_at: new Date(now - 1 * HOUR),
    is_active: true,
    raw: null,
    score: {
      listing_id: 'a1f0c000-0000-4000-8000-000000000006',
      profile_set_hash: 'mock',
      score: 84,
      headline: '2br Greenpoint, both rooms real, in-unit laundry.',
      concerns: '15% broker fee = $6,930 upfront. Above your stretch by $250.',
      rationale_jsonb: {
        top_facts: [
          'Both bedrooms have windows (your deal-breaker check)',
          'In-unit washer-dryer (must-have)',
          'G train + bus to Bedford for the L',
        ],
      },
      computed_at: new Date(now - 30 * 60 * 1000),
    },
    vibe: {
      nta_code: 'BK76',
      nta_name: 'Greenpoint',
      borough: 'Brooklyn',
      noise: 0.55,
      walkability: 0.85,
      greenness: 0.55,
      nightlife: 0.72,
      cafes: 0.88,
      family_score: 0.45,
      computed_at: new Date(),
      geom_geojson: null,
      centroid_lat: 40.7269,
      centroid_lng: -73.9526,
    },
    nearest_subway: { stop_id: 'G24', name: 'Nassau Av', lines: ['G'], distance_m: 230 },
    hpd_count_12mo: 1,
    rent_stabilized: false,
    freshness_hours: 7 * 24,
  },
  {
    id: 'a1f0c000-0000-4000-8000-000000000007',
    source: 'craigslist',
    source_url: 'https://newyork.craigslist.org/mnh/apa/d/example/7.html',
    title: '1br in Hamilton Heights, sun and quiet',
    description:
      'Fourth floor walk-up, southern exposure all day. Renovated bath, original moldings. Coin laundry in basement. No dishwasher.',
    price_monthly: 2400,
    beds: '1.0',
    baths: '1.0',
    sqft: 580,
    available_date: new Date(now + 10 * DAY),
    lease_term: '12 months',
    furnished: false,
    pet_friendly: true,
    amenities: ['natural-light'],
    photos: [NYC_PHOTOS.bedroom_warm, NYC_PHOTOS.bath, NYC_PHOTOS.brownstone_ext],
    address: '470 W 145th St',
    unit: '4F',
    neighborhood: 'Hamilton Heights',
    borough: 'Manhattan',
    zip: '10031',
    lat: 40.8266,
    lng: -73.9494,
    contact: {
      name: 'Tony',
      phone: '+1-212-555-0143',
      preferred_method: 'phone',
    },
    application: {
      requirements: 'Show up at the open house Saturday at 11. First good offer takes it.',
      fee: 0,
      broker_fee_pct: 0,
    },
    posted_at: new Date(now - 36 * HOUR),
    fetched_at: new Date(now - 24 * HOUR),
    last_seen_at: new Date(now - 30 * 60 * 1000),
    is_active: true,
    raw: null,
    score: {
      listing_id: 'a1f0c000-0000-4000-8000-000000000007',
      profile_set_hash: 'mock',
      score: 71,
      headline: '1br at $2,400 a few blocks from the 1 train.',
      concerns: 'Walk-up, no dishwasher, no in-unit laundry.',
      rationale_jsonb: {
        top_facts: [
          'Cheapest 1br in Manhattan in your feed today',
          '8 minutes to 145 St on the 1',
          'No broker fee, casual screening',
        ],
      },
      computed_at: new Date(now - 1 * HOUR),
    },
    vibe: {
      nta_code: 'MN36',
      nta_name: 'Hamilton Heights',
      borough: 'Manhattan',
      noise: 0.38,
      walkability: 0.79,
      greenness: 0.62,
      nightlife: 0.36,
      cafes: 0.59,
      family_score: 0.68,
      computed_at: new Date(),
      geom_geojson: null,
      centroid_lat: 40.8266,
      centroid_lng: -73.9494,
    },
    nearest_subway: { stop_id: '116', name: '145 St', lines: ['1'], distance_m: 320 },
    hpd_count_12mo: 6,
    rent_stabilized: true,
    freshness_hours: 36,
  },
  {
    id: 'a1f0c000-0000-4000-8000-000000000008',
    source: 'streeteasy',
    source_url: 'https://streeteasy.com/listings/example/8',
    title: 'Newly gut-renovated 2br in Bushwick',
    description:
      'Stainless appliances, central air, in-unit washer-dryer. Both bedrooms separate with windows. Roof access.',
    price_monthly: 3650,
    beds: '2.0',
    baths: '2.0',
    sqft: 880,
    available_date: new Date(now + 45 * DAY),
    lease_term: '12 months',
    furnished: false,
    pet_friendly: true,
    amenities: ['dishwasher', 'in-unit-laundry', 'central-ac', 'roof-access'],
    photos: [NYC_PHOTOS.industrial, NYC_PHOTOS.hardwood, NYC_PHOTOS.kitchen_white, NYC_PHOTOS.bath],
    address: '1014 Madison St',
    unit: '3R',
    neighborhood: 'Bushwick',
    borough: 'Brooklyn',
    zip: '11221',
    lat: 40.6905,
    lng: -73.9201,
    contact: {
      name: 'Carla Russo',
      email: 'carla@russogroupnyc.com',
      agency: 'Russo Group',
      preferred_method: 'email',
    },
    application: {
      url: 'https://streeteasy.com/listings/example/8/apply',
      fee: 75,
      broker_fee_pct: 0,
      broker_fee_text: 'No broker fee',
      required_docs: ['Photo ID', 'Last 2 paystubs', 'Tax return'],
    },
    posted_at: new Date(now - 9 * DAY),
    fetched_at: new Date(now - 9 * DAY),
    last_seen_at: new Date(now - 30 * 60 * 1000),
    is_active: true,
    raw: null,
    score: {
      listing_id: 'a1f0c000-0000-4000-8000-000000000008',
      profile_set_hash: 'mock',
      score: 78,
      headline: 'Gut-renovated 2br, no broker fee, both rooms real.',
      concerns: 'New construction, no rent-stabilization protection.',
      rationale_jsonb: {
        top_facts: [
          'Central AC + in-unit laundry on a 2br, rare combo',
          '0% broker fee on a renovated unit is the catch',
          'Halsey on the J/M is 8 min walk',
        ],
      },
      computed_at: new Date(now - 1 * HOUR),
    },
    vibe: {
      nta_code: 'BK77',
      nta_name: 'Bushwick North',
      borough: 'Brooklyn',
      noise: 0.62,
      walkability: 0.81,
      greenness: 0.32,
      nightlife: 0.78,
      cafes: 0.84,
      family_score: 0.41,
      computed_at: new Date(),
      geom_geojson: null,
      centroid_lat: 40.6905,
      centroid_lng: -73.9201,
    },
    nearest_subway: { stop_id: 'M14', name: 'Halsey St', lines: ['J'], distance_m: 510 },
    hpd_count_12mo: 0,
    rent_stabilized: false,
    freshness_hours: 9 * 24,
  },
  {
    id: 'a1f0c000-0000-4000-8000-000000000009',
    source: 'manual',
    source_url: 'https://example.com/manual-paste-9',
    title: 'Sunset Park 2br on 7th Ave',
    description:
      'Top floor, lots of light, dishwasher. No in-unit laundry but there is a laundromat on the corner. Pet-friendly with deposit.',
    price_monthly: 2950,
    beds: '2.0',
    baths: '1.0',
    sqft: 800,
    available_date: new Date(now + 21 * DAY),
    lease_term: '12 months',
    furnished: false,
    pet_friendly: true,
    amenities: ['dishwasher', 'pet-friendly', 'natural-light'],
    photos: [NYC_PHOTOS.cozy_couch, NYC_PHOTOS.brick_living],
    address: '5202 7th Ave',
    unit: '4',
    neighborhood: 'Sunset Park',
    borough: 'Brooklyn',
    zip: '11220',
    lat: 40.6428,
    lng: -74.0093,
    contact: {
      name: 'Owner',
      phone: '+1-718-555-0125',
      preferred_method: 'phone',
    },
    application: {
      fee: 0,
      broker_fee_pct: 0,
      required_docs: ['Photo ID', 'Last paystub'],
    },
    posted_at: new Date(now - 13 * DAY),
    fetched_at: new Date(now - 13 * DAY),
    last_seen_at: new Date(now - 1 * HOUR),
    is_active: true,
    raw: null,
    score: {
      listing_id: 'a1f0c000-0000-4000-8000-000000000009',
      profile_set_hash: 'mock',
      score: 68,
      headline: '2br at $2,950 in Sunset Park, owner direct.',
      concerns: 'No in-unit laundry. R train to Manhattan is local-only.',
      rationale_jsonb: {
        top_facts: [
          '2br under $3k is hard to find',
          '0% broker fee, owner-direct',
          'R train at 53 St, but 35 min to Union Sq',
        ],
      },
      computed_at: new Date(now - 1 * HOUR),
    },
    vibe: {
      nta_code: 'BK28',
      nta_name: 'Sunset Park West',
      borough: 'Brooklyn',
      noise: 0.49,
      walkability: 0.83,
      greenness: 0.71,
      nightlife: 0.34,
      cafes: 0.52,
      family_score: 0.78,
      computed_at: new Date(),
      geom_geojson: null,
      centroid_lat: 40.6428,
      centroid_lng: -74.0093,
    },
    nearest_subway: { stop_id: 'R36', name: '53 St', lines: ['R'], distance_m: 240 },
    hpd_count_12mo: 3,
    rent_stabilized: false,
    freshness_hours: 13 * 24,
  },
  {
    id: 'a1f0c000-0000-4000-8000-000000000010',
    source: 'zillow',
    source_url: 'https://zillow.com/example/10',
    title: 'Park Slope garden 1br with original details',
    description:
      'Restored prewar with crown molding and original hardwood. Eat-in kitchen with dishwasher. Garden access shared with one other tenant.',
    price_monthly: 3300,
    beds: '1.0',
    baths: '1.0',
    sqft: 700,
    available_date: new Date(now + 21 * DAY),
    lease_term: '12 months',
    furnished: false,
    pet_friendly: false,
    amenities: ['dishwasher', 'outdoor-space', 'natural-light', 'hardwood'],
    photos: [NYC_PHOTOS.prewar, NYC_PHOTOS.hardwood, NYC_PHOTOS.cozy_couch],
    address: '498 6th St',
    unit: 'G',
    neighborhood: 'Park Slope',
    borough: 'Brooklyn',
    zip: '11215',
    lat: 40.6699,
    lng: -73.9839,
    contact: {
      name: 'Marc Aubrey',
      email: 'marc@aubreybrokers.com',
      agency: 'Aubrey Brokers',
      preferred_method: 'email',
    },
    application: {
      url: 'https://zillow.com/example/10/apply',
      fee: 100,
      broker_fee_pct: 12,
      broker_fee_text: '12% broker fee',
      required_docs: ['Photo ID', 'Last 2 paystubs', 'Tax return', 'Letter of employment'],
    },
    posted_at: new Date(now - 5 * DAY),
    fetched_at: new Date(now - 5 * DAY),
    last_seen_at: new Date(now - 1 * HOUR),
    is_active: true,
    raw: null,
    score: {
      listing_id: 'a1f0c000-0000-4000-8000-000000000010',
      profile_set_hash: 'mock',
      score: 75,
      headline: 'Park Slope 1br with garden, $3,300.',
      concerns: '12% broker fee + above your stretch by $200.',
      rationale_jsonb: {
        top_facts: [
          'Garden access is rare in your range',
          'F/G at 7 Av is 5 min walk',
          'Park Slope vibe: quiet, parks, family-leaning',
        ],
      },
      computed_at: new Date(now - 1 * HOUR),
    },
    vibe: {
      nta_code: 'BK37',
      nta_name: 'Park Slope-Gowanus',
      borough: 'Brooklyn',
      noise: 0.31,
      walkability: 0.88,
      greenness: 0.74,
      nightlife: 0.55,
      cafes: 0.83,
      family_score: 0.88,
      computed_at: new Date(),
      geom_geojson: null,
      centroid_lat: 40.6699,
      centroid_lng: -73.9839,
    },
    nearest_subway: { stop_id: 'F25', name: '7 Av', lines: ['F', 'G'], distance_m: 380 },
    hpd_count_12mo: 0,
    rent_stabilized: false,
    freshness_hours: 5 * 24,
  },
  {
    id: 'a1f0c000-0000-4000-8000-000000000011',
    source: 'reddit',
    source_url: 'https://reddit.com/r/NYCapartments/comments/example11',
    title: '1br LES walkup, lease takeover',
    description:
      'Lease takeover, 4 months left, then optional renewal. Tiny but bright, exposed brick, original tin ceiling. No dishwasher, laundromat next door.',
    price_monthly: 2675,
    beds: '1.0',
    baths: '1.0',
    sqft: 425,
    available_date: new Date(now + 5 * DAY),
    lease_term: '4-month takeover, then renew',
    furnished: false,
    pet_friendly: false,
    amenities: ['natural-light'],
    photos: [NYC_PHOTOS.brick_living, NYC_PHOTOS.cozy_couch],
    address: '94 Allen St',
    unit: '5C',
    neighborhood: 'Lower East Side',
    borough: 'Manhattan',
    zip: '10002',
    lat: 40.7191,
    lng: -73.9908,
    contact: {
      name: 'u/sam_lev',
      preferred_method: 'website',
      website: 'https://reddit.com/message/compose/?to=sam_lev',
    },
    application: {
      requirements: 'Talk to current tenant, then landlord re-screens.',
      broker_fee_pct: 0,
      fee: 50,
    },
    posted_at: new Date(now - 14 * HOUR),
    fetched_at: new Date(now - 12 * HOUR),
    last_seen_at: new Date(now - 30 * 60 * 1000),
    is_active: true,
    raw: null,
    score: {
      listing_id: 'a1f0c000-0000-4000-8000-000000000011',
      profile_set_hash: 'mock',
      score: 64,
      headline: 'LES 1br lease takeover, 4 months then renew.',
      concerns: '425 sqft. No dishwasher. Lease takeover = re-screening risk.',
      rationale_jsonb: {
        top_facts: [
          'Allen St is 4 min from Delancey F/J/M/Z',
          'Lease takeover = ability to test the unit before committing',
          'Original tin ceiling intact',
        ],
      },
      computed_at: new Date(now - 1 * HOUR),
    },
    vibe: {
      nta_code: 'MN28',
      nta_name: 'Lower East Side',
      borough: 'Manhattan',
      noise: 0.71,
      walkability: 0.95,
      greenness: 0.21,
      nightlife: 0.92,
      cafes: 0.91,
      family_score: 0.32,
      computed_at: new Date(),
      geom_geojson: null,
      centroid_lat: 40.7191,
      centroid_lng: -73.9908,
    },
    nearest_subway: { stop_id: 'F15', name: 'Delancey St', lines: ['F', 'J', 'M', 'Z'], distance_m: 220 },
    hpd_count_12mo: 11,
    rent_stabilized: false,
    freshness_hours: 14,
  },
  {
    id: 'a1f0c000-0000-4000-8000-000000000012',
    source: 'streeteasy',
    source_url: 'https://streeteasy.com/listings/example/12',
    title: 'Washington Heights 2br with elevator and laundry',
    description:
      'Elevator building. Laundry in basement. Both bedrooms have windows, kitchen has a window too. Newly painted, original parquet floors.',
    price_monthly: 2950,
    beds: '2.0',
    baths: '1.0',
    sqft: 870,
    available_date: new Date(now + 21 * DAY),
    lease_term: '12 months',
    furnished: false,
    pet_friendly: false,
    amenities: ['elevator', 'laundry-in-building', 'natural-light'],
    photos: [NYC_PHOTOS.bedroom_warm, NYC_PHOTOS.brick_living, NYC_PHOTOS.bath],
    address: '601 W 162nd St',
    unit: '4D',
    neighborhood: 'Washington Heights',
    borough: 'Manhattan',
    zip: '10032',
    lat: 40.8377,
    lng: -73.9404,
    contact: {
      name: 'Reuben Ortiz',
      phone: '+1-212-555-0177',
      email: 'reuben@ortizmgmt.com',
      agency: 'Ortiz Management',
      preferred_method: 'phone',
    },
    application: {
      url: 'https://streeteasy.com/listings/example/12/apply',
      fee: 50,
      broker_fee_pct: 0,
      broker_fee_text: 'No broker fee',
      required_docs: ['Photo ID', 'Last 2 paystubs', 'Bank statement'],
    },
    posted_at: new Date(now - 10 * DAY),
    fetched_at: new Date(now - 10 * DAY),
    last_seen_at: new Date(now - 30 * 60 * 1000),
    is_active: true,
    raw: null,
    score: {
      listing_id: 'a1f0c000-0000-4000-8000-000000000012',
      profile_set_hash: 'mock',
      score: 88,
      headline: '2br at $2,950, elevator and laundry, no broker fee.',
      concerns: 'A train commute is the long one to FiDi (45 min).',
      rationale_jsonb: {
        top_facts: [
          'Both bedrooms real with windows (deal-breaker check)',
          'Elevator + laundry in building (must-haves)',
          '0% broker fee, $50 app fee, owner manages directly',
        ],
      },
      computed_at: new Date(now - 1 * HOUR),
    },
    vibe: {
      nta_code: 'MN35',
      nta_name: 'Washington Heights South',
      borough: 'Manhattan',
      noise: 0.43,
      walkability: 0.81,
      greenness: 0.66,
      nightlife: 0.41,
      cafes: 0.55,
      family_score: 0.79,
      computed_at: new Date(),
      geom_geojson: null,
      centroid_lat: 40.8377,
      centroid_lng: -73.9404,
    },
    nearest_subway: { stop_id: 'A09', name: '163 St-Amsterdam Av', lines: ['C'], distance_m: 280 },
    hpd_count_12mo: 1,
    rent_stabilized: true,
    freshness_hours: 10 * 24,
  },
]

export type FeedFilters = {
  freshnessDays?: 1 | 7 | 14 | 30
  sources?: Source[]
  // ── extended filters (additive — populated by NL search) ────────────
  /** Inclusive lower bound on `price_monthly`. */
  priceMin?: number
  /** Inclusive upper bound on `price_monthly`. */
  priceMax?: number
  /** Inclusive lower bound on bedrooms (0 = studio). */
  bedsMin?: number
  /** Inclusive upper bound on bedrooms. */
  bedsMax?: number
  /** Restrict to listings whose `borough` matches one of these (case-insensitive). */
  boroughs?: string[]
  /** Restrict to listings whose `neighborhood` matches one of these (case-insensitive substring). */
  neighborhoods?: string[]
  /** All listed amenities must be present (case-insensitive substring vs `amenities`). */
  mustHave?: string[]
  /** True → drop anything without `application.broker_fee_pct === 0` or "no broker fee" text. */
  noBrokerFee?: boolean
  /** True → drop anything without `rent_stabilized === true`. */
  rentStabilizedOnly?: boolean
  /** True → drop anything without `pet_friendly === true`. */
  petFriendly?: boolean
  /** True → drop anything without `furnished === true`. */
  furnished?: boolean
  /** Free-text AND-match across title + description + amenities + neighborhood. */
  keywords?: string[]
  /** Original NL query, surfaced for highlighting / banner rendering. */
  query?: string
}

/**
 * Apply the additive filter fields above on top of an already-fetched
 * RankedListing[]. The base data layer (`listing-helpers.getRankedFeed`)
 * doesn't know about these — we apply in JS so the contract there stays
 * stable.
 */
function applyExtendedFilters(rows: RankedListing[], opts: FeedFilters): RankedListing[] {
  let out = rows
  if (opts.priceMin != null) {
    const min = opts.priceMin
    out = out.filter((l) => l.price_monthly != null && l.price_monthly >= min)
  }
  if (opts.priceMax != null) {
    const max = opts.priceMax
    out = out.filter((l) => l.price_monthly != null && l.price_monthly <= max)
  }
  if (opts.bedsMin != null || opts.bedsMax != null) {
    const min = opts.bedsMin ?? -Infinity
    const max = opts.bedsMax ?? Infinity
    out = out.filter((l) => {
      if (l.beds == null) return false
      const b = typeof l.beds === 'string' ? Number.parseFloat(l.beds) : (l.beds as unknown as number)
      if (Number.isNaN(b)) return false
      return b >= min && b <= max
    })
  }
  if (opts.boroughs && opts.boroughs.length > 0) {
    const allowed = new Set(opts.boroughs.map((b) => b.toLowerCase()))
    out = out.filter((l) => l.borough != null && allowed.has(l.borough.toLowerCase()))
  }
  if (opts.neighborhoods && opts.neighborhoods.length > 0) {
    const needles = opts.neighborhoods.map((n) => n.toLowerCase())
    out = out.filter((l) => {
      if (!l.neighborhood) return false
      const hay = l.neighborhood.toLowerCase()
      return needles.some((n) => hay.includes(n) || n.includes(hay))
    })
  }
  if (opts.mustHave && opts.mustHave.length > 0) {
    const needles = opts.mustHave.map((m) => m.toLowerCase())
    out = out.filter((l) => {
      const have = (l.amenities ?? []).map((a) => a.toLowerCase())
      return needles.every((n) => have.some((h) => h.includes(n) || n.includes(h)))
    })
  }
  if (opts.noBrokerFee) {
    out = out.filter((l) => {
      const a = l.application
      if (!a) return false
      if (a.broker_fee_pct === 0) return true
      if (a.broker_fee_text && /no\s*broker\s*fee/i.test(a.broker_fee_text)) return true
      return false
    })
  }
  if (opts.rentStabilizedOnly) {
    out = out.filter((l) => l.rent_stabilized === true)
  }
  if (opts.petFriendly) {
    out = out.filter((l) => l.pet_friendly === true)
  }
  if (opts.furnished) {
    out = out.filter((l) => l.furnished === true)
  }
  if (opts.keywords && opts.keywords.length > 0) {
    const needles = opts.keywords.map((k) => k.toLowerCase()).filter((k) => k.length > 0)
    if (needles.length > 0) {
      out = out.filter((l) => {
        const hay = [
          l.title ?? '',
          l.description ?? '',
          (l.amenities ?? []).join(' '),
          l.neighborhood ?? '',
        ]
          .join(' ')
          .toLowerCase()
        return needles.every((n) => hay.includes(n))
      })
    }
  }
  return out
}

/**
 * Cached real-feed fetch. Keyed on (freshnessDays, sources, neighborhoods)
 * since those are the inputs that affect the underlying SQL. Extended filters
 * (keywords, priceMin, etc.) are applied in JS after this returns, so the
 * same cached payload backs every search variant within the TTL.
 *
 * Tag: `feed`. Invalidate via `revalidateTag('feed')` after a scrape/refresh
 * upsert so the dashboard reflects fresh listings without waiting for the
 * 60-second TTL.
 */
const _cachedRealFeed = unstable_cache(
  async (
    freshnessDays: number | undefined,
    sources: Source[] | undefined,
    neighborhoods: string[] | undefined,
  ) => {
    return real.getRankedFeedWithCounts({
      freshness_days: freshnessDays,
      sources,
      neighborhoods,
    })
  },
  ['ranked-feed-v3'],
  { revalidate: 60, tags: ['feed'] },
)

export async function getRankedFeed(opts: FeedFilters = {}): Promise<RankedListing[]> {
  const { listings } = await getRankedFeedWithCounts(opts)
  return listings
}

/**
 * Same as `getRankedFeed` but also returns neighborhood counts for the chip
 * row. Counts are computed off the unfiltered (no-neighborhoods-filter)
 * candidate set so chips show real inventory regardless of selection.
 */
export async function getRankedFeedWithCounts(
  opts: FeedFilters = {},
): Promise<{ listings: RankedListing[]; neighborhood_counts: NeighborhoodCounts }> {
  // Normalize neighborhoods so the cache key is stable across [a,b] / [b,a].
  const normalizedNbhds =
    opts.neighborhoods && opts.neighborhoods.length > 0
      ? [...new Set(opts.neighborhoods.map((n) => n.toLowerCase()))].sort()
      : undefined

  if (process.env.DATABASE_URL) {
    try {
      const result = await _cachedRealFeed(
        opts.freshnessDays,
        opts.sources,
        normalizedNbhds,
      )
      if (result.listings.length > 0) {
        // Drop `neighborhoods` from the JS-side post-filter — already applied at SQL.
        const { neighborhoods: _drop, ...rest } = opts
        return {
          listings: applyExtendedFilters(result.listings, rest),
          neighborhood_counts: result.neighborhood_counts,
        }
      }
      // PRODUCTION: when DATABASE_URL is set we trust the DB. Empty result is
      // an honest empty (let the empty-state CTA handle it) — never paper
      // over with mocks because mock UUIDs aren't in `listings` and saving
      // them 422s. Counts ship through so chips show real availability.
      const { neighborhoods: _drop, ...rest } = opts
      return {
        listings: applyExtendedFilters(result.listings, rest),
        neighborhood_counts: result.neighborhood_counts,
      }
    } catch (err) {
      console.warn('[feed-data] DB read failed, falling back to mocks:', (err as Error).message)
      // Only path that still uses mocks: DB literally unreachable.
    }
  }
  const { freshnessDays = 14, sources } = opts
  const cutoff = freshnessDays * 24
  let filtered = mocks.filter((l) => (l.freshness_hours ?? Infinity) <= cutoff)
  if (sources && sources.length) {
    filtered = filtered.filter((l) => sources.includes(l.source as Source))
  }
  filtered.sort((a, b) => {
    if (b.score.score !== a.score.score) return b.score.score - a.score.score
    return (a.freshness_hours ?? 0) - (b.freshness_hours ?? 0)
  })
  const ranked = filtered as unknown as RankedListing[]
  // Mock-mode counts: build from the mocks pre-extended-filters so chip
  // numbers don't lie about what's available.
  const counts: NeighborhoodCounts = {}
  for (const m of mocks) {
    if (!m.neighborhood) continue
    const k = canonicalize(m.neighborhood) ?? m.neighborhood
    counts[k] = (counts[k] ?? 0) + 1
  }
  return {
    listings: applyExtendedFilters(ranked, opts),
    neighborhood_counts: counts,
  }
}

export async function getListing(id: string): Promise<RankedListing | null> {
  if (process.env.DATABASE_URL) {
    try {
      const r = await real.getListingDetail(id)
      if (r) return r
    } catch (err) {
      console.warn('[feed-data] DB read failed, falling back to mock:', (err as Error).message)
    }
  }
  const found = mocks.find((m) => m.id === id)
  return (found as unknown as RankedListing) ?? null
}
