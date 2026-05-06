import Anthropic from '@anthropic-ai/sdk'

let _client: Anthropic | null = null

export function getAnthropic() {
  if (_client) return _client
  const key = process.env.ANTHROPIC_API_KEY
  if (!key) throw new Error('ANTHROPIC_API_KEY not set — see .env.local.example')
  _client = new Anthropic({ apiKey: key })
  return _client
}

// Cost posture: Haiku 4.5 ($1/$5 per MTok) everywhere. Haiku 4.5 is strong
// enough for the chat/ranking workload here, and the structured tool_use we
// rely on lands well below the model's ceiling. If a specific call site
// regresses on quality we'll bump that one to Sonnet 4.6, not all of them.
export const MODELS = {
  extract: 'claude-haiku-4-5-20251001',
  score: 'claude-haiku-4-5-20251001',
  summarize: 'claude-haiku-4-5-20251001',
  reason: 'claude-haiku-4-5-20251001',
} as const
