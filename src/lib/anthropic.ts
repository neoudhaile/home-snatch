import Anthropic from '@anthropic-ai/sdk'

let _client: Anthropic | null = null

export function getAnthropic() {
  if (_client) return _client
  const key = process.env.ANTHROPIC_API_KEY
  if (!key) throw new Error('ANTHROPIC_API_KEY not set — see .env.local.example')
  _client = new Anthropic({ apiKey: key })
  return _client
}

// Cost posture: default to Haiku 4.5 ($1/$5 per MTok). Sonnet 4.6 ($3/$15)
// is reserved for `reason` — user-facing chat where conversational quality
// matters most. Scoring + structured summaries are tool-use calls with
// constrained outputs, where Haiku 4.5 matches Sonnet quality at 1/3 cost.
export const MODELS = {
  extract: 'claude-haiku-4-5-20251001',
  score: 'claude-haiku-4-5-20251001',
  summarize: 'claude-haiku-4-5-20251001',
  reason: 'claude-sonnet-4-6',
} as const
