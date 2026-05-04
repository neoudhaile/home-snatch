'use client'

import { createContext, useContext } from 'react'
import type { RailListing } from './listings-rail'

/**
 * Maps listing UUID -> RailListing so inline pills (rendered inside markdown
 * prose) can show real titles + scores without prop-drilling through every
 * markdown component override.
 */
export const RailMapContext = createContext<Map<string, RailListing>>(
  new Map<string, RailListing>(),
)

export function useRailMap(): Map<string, RailListing> {
  return useContext(RailMapContext)
}
