'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Check, Copy, Loader2, Wrench } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import type { ChatMessage, ContentBlock } from '@/lib/chat-state'

/* ---------------------------- public types ------------------------------ */

export type ToolEvent =
  | { kind: 'use'; id: string; name: string; input: unknown }
  | { kind: 'result'; id: string; name: string; ok: boolean; ids: string[] }

export function MessageBubble({
  message,
  toolEvents,
  isStreaming,
}: {
  message: ChatMessage
  /** Tool-call events tied to this assistant message, in order. */
  toolEvents?: ToolEvent[]
  /** True only for the in-flight assistant message currently being streamed. */
  isStreaming?: boolean
}) {
  if (message.role === 'user') return <UserBubble content={message.content} />
  return (
    <AssistantBubble
      content={message.content}
      toolEvents={toolEvents ?? []}
      isStreaming={!!isStreaming}
    />
  )
}

/* ---------------------------- user ------------------------------------- */

function UserBubble({ content }: { content: ChatMessage['content'] }) {
  const text = blocksToText(content)
  return (
    <div className="flex justify-end">
      <div className="max-w-[80%] rounded-2xl rounded-br-md border border-border bg-surface-2 px-4 py-2.5 text-[14px] leading-relaxed text-foreground">
        <p className="whitespace-pre-wrap">{text}</p>
      </div>
    </div>
  )
}

/* ---------------------------- assistant -------------------------------- */

function AssistantBubble({
  content,
  toolEvents,
  isStreaming,
}: {
  content: ChatMessage['content']
  toolEvents: ToolEvent[]
  isStreaming: boolean
}) {
  const blocks: ContentBlock[] =
    typeof content === 'string'
      ? [{ type: 'text', text: content }]
      : (content as ContentBlock[])

  // Pair tool_use events from the SDK stream with their results so we render
  // a single chip per call. Live events (toolEvents) take precedence over
  // saved blocks because the saved blocks may not have a paired result yet.
  const liveUses = toolEvents.filter((e) => e.kind === 'use') as Extract<ToolEvent, { kind: 'use' }>[]
  const liveResults = toolEvents.filter((e) => e.kind === 'result') as Extract<
    ToolEvent,
    { kind: 'result' }
  >[]

  return (
    <div className="flex justify-start">
      <div className="max-w-[88%] space-y-2">
        {blocks.map((b, i) => {
          if (b.type === 'text') {
            const text = b.text.trim()
            if (!text) return null
            return <TextBlockView key={i} text={b.text} />
          }
          if (b.type === 'tool_use') {
            const result = liveResults.find((r) => r.id === b.id)
            return (
              <ToolChip
                key={`tu-${b.id}`}
                name={b.name}
                done={!!result}
                ok={result?.ok ?? true}
                count={result?.ids.length}
              />
            )
          }
          return null
        })}

        {/* Live tool events for this turn: render any not yet baked into the
            persisted blocks. Useful while the message is still streaming. */}
        {liveUses
          .filter((u) => !blocks.some((b) => b.type === 'tool_use' && b.id === u.id))
          .map((u) => {
            const result = liveResults.find((r) => r.id === u.id)
            return (
              <ToolChip
                key={`live-${u.id}`}
                name={u.name}
                done={!!result}
                ok={result?.ok ?? true}
                count={result?.ids.length}
              />
            )
          })}
      </div>
    </div>
  )
}

/* ---------------------------- text rendering --------------------------- */

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}/gi

function TextBlockView({ text }: { text: string }) {
  // Detect a "Subject:" + body that looks like a drafted email. Render it as a
  // styled card with a Copy button. Cheap heuristic; covers the common shape.
  const emailMatch = parseDraftEmail(text)
  if (emailMatch) {
    return (
      <DraftEmailCard
        subject={emailMatch.subject}
        body={emailMatch.body}
        prefix={emailMatch.prefix}
      />
    )
  }

  return (
    <div className="rounded-2xl rounded-bl-md border border-border bg-card px-4 py-3 text-[14px] leading-relaxed text-card-foreground">
      <p className="whitespace-pre-wrap">{linkifyListingIds(text)}</p>
    </div>
  )
}

/**
 * Replace any UUID that looks like a listing id with a small inline link. This
 * makes "...this listing (a1f0c...0001)" actionable.
 */
function linkifyListingIds(text: string): React.ReactNode[] {
  const out: React.ReactNode[] = []
  let last = 0
  let i = 0
  for (const m of text.matchAll(UUID_RE)) {
    const start = m.index ?? 0
    if (start > last) out.push(text.slice(last, start))
    const id = m[0]
    out.push(
      <Link
        key={`${id}-${i++}`}
        href={`/listing/${id}`}
        className="tabular cursor-pointer rounded-md border border-border bg-surface-2 px-1.5 py-0.5 text-[11.5px] font-medium text-foreground transition-colors hover:bg-secondary"
      >
        listing
      </Link>,
    )
    last = start + id.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

/* ---------------------------- tool chip -------------------------------- */

const TOOL_LABELS: Record<string, { running: string; done: string }> = {
  list_listings: { running: 'Searching listings', done: 'Found listings' },
  get_listing: { running: 'Reading listing', done: 'Read listing' },
  save_listing: { running: 'Saving', done: 'Saved' },
  unsave_listing: { running: 'Removing', done: 'Removed' },
  get_saved: { running: 'Fetching saved', done: 'Loaded saved' },
  compare_listings: { running: 'Comparing', done: 'Compared' },
  get_profile_summary: { running: 'Reading profile', done: 'Read profile' },
  draft_email: { running: 'Drafting email', done: 'Drafted email' },
}

function ToolChip({
  name,
  done,
  ok,
  count,
}: {
  name: string
  done: boolean
  ok: boolean
  count?: number
}) {
  const labels = TOOL_LABELS[name] ?? { running: name, done: name }
  const text = done ? labels.done : labels.running
  const countSuffix =
    done && typeof count === 'number' && count > 0 ? ` · ${count}` : ''
  return (
    <div
      className={cn(
        'tabular inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11.5px] font-medium',
        done
          ? ok
            ? 'border-border bg-surface-2 text-foreground/80'
            : 'border-destructive/30 bg-destructive/5 text-destructive'
          : 'border-border bg-surface-2 text-muted-foreground',
      )}
    >
      {done ? (
        <Check className="h-3 w-3" aria-hidden />
      ) : (
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
      )}
      <Wrench className="h-3 w-3 opacity-60" aria-hidden />
      <span>{text}{countSuffix}</span>
    </div>
  )
}

/* ---------------------------- draft email ------------------------------ */

function parseDraftEmail(
  text: string,
): { prefix: string; subject: string; body: string } | null {
  // Look for a "Subject: ..." line followed by body content.
  const m = text.match(/Subject:\s*(.+?)\n([\s\S]+)/i)
  if (!m) return null
  const subject = m[1].trim()
  const idx = text.indexOf(m[0])
  const prefix = text.slice(0, idx).trim()
  const body = m[2].trim()
  if (body.length < 20) return null
  return { prefix, subject, body }
}

function DraftEmailCard({
  prefix,
  subject,
  body,
}: {
  prefix: string
  subject: string
  body: string
}) {
  const [copied, setCopied] = useState(false)
  function copy() {
    const payload = `Subject: ${subject}\n\n${body}`
    navigator.clipboard.writeText(payload).then(
      () => {
        setCopied(true)
        toast.success('Email copied.')
        setTimeout(() => setCopied(false), 1500)
      },
      () => toast.error('Copy failed.'),
    )
  }
  return (
    <div className="space-y-2">
      {prefix ? (
        <div className="rounded-2xl rounded-bl-md border border-border bg-card px-4 py-3 text-[14px] leading-relaxed text-card-foreground">
          <p className="whitespace-pre-wrap">{prefix}</p>
        </div>
      ) : null}
      <div className="overflow-hidden rounded-2xl border border-border bg-card">
        <div className="flex items-center justify-between gap-2 border-b border-border bg-surface-2 px-4 py-2">
          <div className="min-w-0 flex-1">
            <p className="text-[10.5px] uppercase tracking-[0.08em] text-muted-foreground">
              Draft email
            </p>
            <p className="truncate text-[13px] font-medium text-foreground">{subject}</p>
          </div>
          <button
            type="button"
            onClick={copy}
            aria-label="Copy email"
            className="tabular inline-flex h-7 cursor-pointer items-center gap-1 rounded-full border border-border bg-background px-2.5 text-[11.5px] font-medium text-foreground transition-colors hover:bg-surface-2"
          >
            {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
            <span>{copied ? 'Copied' : 'Copy'}</span>
          </button>
        </div>
        <div className="px-4 py-3 text-[13.5px] leading-relaxed text-card-foreground">
          <p className="whitespace-pre-wrap">{body}</p>
        </div>
      </div>
    </div>
  )
}

/* ---------------------------- helpers ---------------------------------- */

function blocksToText(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content
  return content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
}
