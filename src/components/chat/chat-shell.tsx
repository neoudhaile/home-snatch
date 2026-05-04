'use client'

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowDown, Send, Sparkles, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import {
  loadChatHistory,
  saveChatHistory,
  clearChatHistory,
  type ChatMessage,
  type ContentBlock,
} from '@/lib/chat-state'
import { MessageBubble, type ToolEvent } from './message'
import { SuggestedPrompts } from './suggested-prompts'
import { TypingIndicator } from './typing-indicator'
import { ListingsRail, type RailListing } from './listings-rail'

/**
 * The full chat surface: conversation column on the left, listings rail on
 * the right. Owns SSE stream parsing for /api/chat. Persists conversation
 * across reload via localStorage.
 */
export function ChatShell() {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [hydrated, setHydrated] = useState(false)
  const [isStreaming, setIsStreaming] = useState(false)
  const [input, setInput] = useState('')
  const [liveText, setLiveText] = useState('')
  const [liveTools, setLiveTools] = useState<ToolEvent[]>([])
  const [rail, setRail] = useState<RailListing[]>([])
  const abortRef = useRef<AbortController | null>(null)

  // Hydrate from localStorage once on mount.
  useEffect(() => {
    setMessages(loadChatHistory())
    setHydrated(true)
  }, [])

  // Persist on every change after hydration.
  useEffect(() => {
    if (!hydrated) return
    saveChatHistory(messages)
  }, [messages, hydrated])

  /* ------------------------ scroll anchoring ------------------------ */

  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const stickToBottomRef = useRef(true)
  const [showJump, setShowJump] = useState(false)

  // Track whether we are pinned to bottom so streaming auto-scrolls but a user
  // who scrolled up to read isn't yanked away.
  function onScroll() {
    const el = scrollerRef.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.clientHeight - el.scrollTop
    const atBottom = distanceFromBottom < 64
    stickToBottomRef.current = atBottom
    setShowJump(!atBottom && (isStreaming || messages.length > 0))
  }

  useLayoutEffect(() => {
    if (!stickToBottomRef.current) return
    const el = scrollerRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [messages, liveText, liveTools, isStreaming])

  function jumpToBottom() {
    const el = scrollerRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    stickToBottomRef.current = true
    setShowJump(false)
  }

  /* ------------------------ submit + stream ------------------------ */

  const submit = useCallback(
    async (raw: string) => {
      const text = raw.trim()
      if (!text || isStreaming) return

      const userMsg: ChatMessage = { role: 'user', content: text }
      const nextHistory = [...messages, userMsg]
      setMessages(nextHistory)
      setInput('')
      setLiveText('')
      setLiveTools([])
      setIsStreaming(true)
      stickToBottomRef.current = true

      const ac = new AbortController()
      abortRef.current?.abort()
      abortRef.current = ac

      try {
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ messages: nextHistory }),
          signal: ac.signal,
        })
        if (!res.ok || !res.body) {
          toast.error(`Chat failed (${res.status}).`)
          setIsStreaming(false)
          return
        }

        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        let accText = ''
        const collectedTools: ToolEvent[] = []
        const collectedRail = new Map<string, RailListing>(
          rail.map((r) => [r.id, r] as const),
        )

        while (true) {
          const { value: chunk, done } = await reader.read()
          if (done) break
          buffer += decoder.decode(chunk, { stream: true })
          const events = buffer.split('\n\n')
          buffer = events.pop() ?? ''

          for (const evt of events) {
            const eventLine = evt.split('\n').find((l) => l.startsWith('event: '))
            const eventType = eventLine ? eventLine.slice(7).trim() : ''
            const dataLines = evt
              .split('\n')
              .filter((l) => l.startsWith('data: '))
              .map((l) => l.slice(6))
            const dataText = dataLines.join('\n')

            if (eventType === 'end') {
              continue
            }
            if (eventType === 'error') {
              toast.error(dataText || 'Stream error.')
              continue
            }
            if (eventType === 'tool_use') {
              try {
                const parsed = JSON.parse(dataText) as {
                  id: string
                  name: string
                  input: unknown
                }
                collectedTools.push({ kind: 'use', ...parsed })
                setLiveTools([...collectedTools])
              } catch {
                /* ignore */
              }
              continue
            }
            if (eventType === 'tool_result') {
              try {
                const parsed = JSON.parse(dataText) as {
                  id: string
                  name: string
                  ok: boolean
                  ids: string[]
                  cards?: RailListing[]
                }
                collectedTools.push({
                  kind: 'result',
                  id: parsed.id,
                  name: parsed.name,
                  ok: parsed.ok,
                  ids: parsed.ids ?? [],
                })
                setLiveTools([...collectedTools])
                for (const c of parsed.cards ?? []) {
                  if (!collectedRail.has(c.id)) collectedRail.set(c.id, c)
                }
                setRail([...collectedRail.values()])
              } catch {
                /* ignore */
              }
              continue
            }
            // Default: text delta (no event type means it's a text payload).
            if (dataText && dataText !== '[DONE]') {
              accText += dataText
              setLiveText(accText)
            }
          }
        }

        // On stream close, persist the assistant turn. Build a structured
        // content array so re-serialisation across reloads still surfaces
        // the tool-call chips.
        const finalContent: ContentBlock[] = []
        const seenToolIds = new Set<string>()
        // Interleave tool_use/result chips between text segments. We don't
        // know exact ordering between text deltas and tool events, but the
        // user-facing render is fine with chips floating below the prose.
        if (accText.trim().length > 0) {
          finalContent.push({ type: 'text', text: accText })
        }
        for (const t of collectedTools) {
          if (t.kind === 'use' && !seenToolIds.has(t.id)) {
            finalContent.push({ type: 'tool_use', id: t.id, name: t.name, input: t.input })
            seenToolIds.add(t.id)
          }
        }

        if (finalContent.length === 0) {
          finalContent.push({ type: 'text', text: '(no response)' })
        }

        setMessages((prev) => [...prev, { role: 'assistant', content: finalContent }])
        setLiveText('')
        setLiveTools([])
      } catch (err) {
        if ((err as Error).name === 'AbortError') return
        console.error(err)
        toast.error('Network error.')
      } finally {
        setIsStreaming(false)
      }
    },
    [isStreaming, messages, rail],
  )

  function clearAll() {
    abortRef.current?.abort()
    setMessages([])
    setLiveText('')
    setLiveTools([])
    setRail([])
    setIsStreaming(false)
    clearChatHistory()
    toast.success('New chat.')
  }

  /* ------------------------ rendering ------------------------ */

  const showEmpty = hydrated && messages.length === 0 && !isStreaming
  const showTyping = isStreaming && liveText.length === 0 && liveTools.length === 0

  return (
    <div className="mx-auto flex h-[calc(100dvh-3.5rem)] w-full max-w-[1480px] flex-col px-4 sm:px-6 lg:px-8">
      <div className="grid flex-1 min-h-0 grid-cols-1 gap-6 py-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        {/* ---------- conversation column ---------- */}
        <div className="relative flex min-h-0 flex-col rounded-2xl border border-border bg-background">
          {/* header */}
          <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-2.5 sm:px-5">
            <div className="flex items-center gap-2">
              <span className="grid h-6 w-6 place-items-center rounded-full bg-secondary text-foreground">
                <Sparkles className="h-3.5 w-3.5" aria-hidden />
              </span>
              <span className="text-[13px] font-medium tracking-tight text-foreground">
                Chat
              </span>
            </div>
            <button
              type="button"
              onClick={clearAll}
              disabled={messages.length === 0 && !isStreaming}
              className="tabular inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-full border border-border bg-surface-2 px-2.5 text-[11.5px] font-medium text-foreground transition-colors hover:bg-secondary disabled:opacity-50"
            >
              <Trash2 className="h-3 w-3" aria-hidden />
              <span>New chat</span>
            </button>
          </div>

          {/* scroller */}
          <div
            ref={scrollerRef}
            onScroll={onScroll}
            className="relative flex-1 min-h-0 overflow-y-auto px-3 py-4 sm:px-5"
          >
            {showEmpty ? (
              <EmptyState onPick={(t) => void submit(t)} />
            ) : (
              <div className="mx-auto flex max-w-3xl flex-col gap-3">
                {messages.map((m, i) => (
                  <MessageBubble key={i} message={m} />
                ))}
                {/* The in-flight assistant turn: live text + chips. */}
                {isStreaming ? (
                  <MessageBubble
                    message={{
                      role: 'assistant',
                      content: liveText
                        ? [{ type: 'text', text: liveText }]
                        : [],
                    }}
                    toolEvents={liveTools}
                    isStreaming
                  />
                ) : null}
                {showTyping ? (
                  <div className="flex justify-start">
                    <div className="rounded-2xl rounded-bl-md border border-border bg-card px-4 py-2">
                      <TypingIndicator />
                    </div>
                  </div>
                ) : null}
              </div>
            )}

            {showJump ? (
              <button
                type="button"
                onClick={jumpToBottom}
                aria-label="Jump to latest"
                className="absolute bottom-3 left-1/2 z-10 inline-flex h-8 -translate-x-1/2 cursor-pointer items-center gap-1.5 rounded-full border border-border bg-background/85 px-3 text-[11.5px] font-medium text-foreground shadow-sm backdrop-blur-md transition-colors hover:bg-surface-2"
              >
                <ArrowDown className="h-3 w-3" aria-hidden />
                <span>Latest</span>
              </button>
            ) : null}
          </div>

          {/* composer */}
          <div className="shrink-0 border-t border-border bg-background px-3 py-3 sm:px-5">
            <Composer
              value={input}
              onChange={setInput}
              onSubmit={() => void submit(input)}
              disabled={isStreaming}
            />
          </div>
        </div>

        {/* ---------- listings rail ---------- */}
        <aside className="hidden min-h-0 lg:block">
          <div className="sticky top-0 h-full overflow-y-auto pb-2">
            <ListingsRail items={rail} />
          </div>
        </aside>
      </div>

      {/* mobile rail — below conversation */}
      {rail.length > 0 ? (
        <div className="border-t border-border pb-4 pt-3 lg:hidden">
          <ListingsRail items={rail} />
        </div>
      ) : null}
    </div>
  )
}

/* ---------------------------- composer --------------------------------- */

function Composer({
  value,
  onChange,
  onSubmit,
  disabled,
}: {
  value: string
  onChange: (v: string) => void
  onSubmit: () => void
  disabled: boolean
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null)

  // auto-grow
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`
  }, [value])

  return (
    <div className="relative mx-auto max-w-3xl">
      <Textarea
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={1}
        aria-label="Message"
        placeholder="Ask anything about your NYC apartment search."
        disabled={disabled}
        className="min-h-[44px] max-h-[220px] resize-none rounded-2xl border-border bg-surface-2 pr-12 text-[14px] leading-relaxed placeholder:text-muted-foreground"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            onSubmit()
          }
        }}
      />
      <button
        type="button"
        onClick={onSubmit}
        disabled={!value.trim() || disabled}
        aria-label="Send"
        className={cn(
          'absolute bottom-2 right-2 grid h-8 w-8 cursor-pointer place-items-center rounded-full transition-all',
          value.trim() && !disabled
            ? 'bg-foreground text-background hover:opacity-90'
            : 'bg-secondary text-muted-foreground',
          disabled && 'animate-pulse',
        )}
      >
        <Send className="h-3.5 w-3.5" aria-hidden />
      </button>
    </div>
  )
}

/* ---------------------------- empty state ------------------------------ */

function EmptyState({ onPick }: { onPick: (text: string) => void }) {
  return (
    <div className="mx-auto flex h-full max-w-2xl flex-col items-center justify-center gap-6 py-10 text-center">
      <div className="space-y-2">
        <h2 className="serif text-[34px] italic leading-tight tracking-[-0.01em] text-foreground sm:text-[42px]">
          Ask anything
        </h2>
        <p className="text-[14px] leading-relaxed text-muted-foreground">
          About your NYC apartment search.
        </p>
      </div>
      <SuggestedPrompts className="w-full" onPick={onPick} />
    </div>
  )
}
