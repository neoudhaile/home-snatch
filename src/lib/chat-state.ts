/**
 * Browser-only localStorage helpers for the /chat conversation.
 *
 * Schema is mirrored from the API route's ChatMessage. We cap at 50 messages so
 * a long thread doesn't blow past the localStorage quota.
 */

export type TextBlock = { type: 'text'; text: string }
export type ToolUseBlock = { type: 'tool_use'; id: string; name: string; input: unknown }
export type ToolResultBlock = {
  type: 'tool_result'
  tool_use_id: string
  content: string
  is_error?: boolean
}
export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock

export type ChatMessage = {
  role: 'user' | 'assistant'
  content: string | ContentBlock[]
}

const KEY = 'homesnatch:chat:messages'
const CAP = 50

export function loadChatHistory(): ChatMessage[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    // Light validation; ignore malformed entries.
    return parsed.filter(isChatMessage).slice(-CAP)
  } catch {
    return []
  }
}

export function saveChatHistory(msgs: ChatMessage[]): void {
  if (typeof window === 'undefined') return
  try {
    const trimmed = msgs.slice(-CAP)
    window.localStorage.setItem(KEY, JSON.stringify(trimmed))
  } catch {
    /* quota exceeded — silently drop */
  }
}

export function clearChatHistory(): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(KEY)
  } catch {
    /* ignore */
  }
}

function isChatMessage(x: unknown): x is ChatMessage {
  if (!x || typeof x !== 'object') return false
  const m = x as { role?: unknown; content?: unknown }
  if (m.role !== 'user' && m.role !== 'assistant') return false
  if (typeof m.content === 'string') return true
  return Array.isArray(m.content)
}
