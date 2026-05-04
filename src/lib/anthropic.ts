import Anthropic from '@anthropic-ai/sdk'

let _client: Anthropic | null = null

export function getAnthropic() {
  if (_client) return _client
  const key = process.env.ANTHROPIC_API_KEY
  if (!key) throw new Error('ANTHROPIC_API_KEY not set — see .env.local.example')
  _client = new Anthropic({ apiKey: key })
  return _client
}

export const MODELS = {
  extract: 'claude-haiku-4-5-20251001',
  score: 'claude-sonnet-4-6',
  reason: 'claude-sonnet-4-6',
} as const
