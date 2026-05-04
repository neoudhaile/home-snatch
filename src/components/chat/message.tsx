'use client'

import { useState } from 'react'
import { Check, Copy, Loader2, Wrench } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import type { ChatMessage, ContentBlock } from '@/lib/chat-state'
import { ChatMarkdown } from './markdown'

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

  const liveResults = toolEvents.filter((e) => e.kind === 'result') as Extract<
    ToolEvent,
    { kind: 'result' }
  >[]
  const liveUses = toolEvents.filter((e) => e.kind === 'use') as Extract<
    ToolEvent,
    { kind: 'use' }
  >[]

  // Tool chips render as a small rail BELOW the prose. We collect every
  // tool_use we know about (from saved blocks + live events), dedup by id,
  // and pair each with its matching result if it has landed.
  const persistedUses: Array<{
    id: string
    name: string
    input?: unknown
  }> = []
  const seen = new Set<string>()
  for (const b of blocks) {
    if (b.type === 'tool_use' && !seen.has(b.id)) {
      persistedUses.push({ id: b.id, name: b.name, input: b.input })
      seen.add(b.id)
    }
  }
  for (const u of liveUses) {
    if (!seen.has(u.id)) {
      persistedUses.push({ id: u.id, name: u.name, input: u.input })
      seen.add(u.id)
    }
  }

  // Reload-survival: pull tool_result blocks out of the saved content so
  // chips show "Searched listings · 12" instead of a perma-spinner after
  // a hard reload (where there are no live SSE events).
  const persistedResults: Array<{
    id: string
    name: string
    ok: boolean
    ids: string[]
  }> = []
  type ParsedToolResult = { ok?: boolean; ids?: unknown; name?: string }
  for (const b of blocks) {
    if (b.type !== 'tool_result') continue
    let parsed: ParsedToolResult = {}
    if (typeof b.content === 'string') {
      try {
        const raw = JSON.parse(b.content) as unknown
        if (raw && typeof raw === 'object') parsed = raw as ParsedToolResult
      } catch {
        /* leave empty */
      }
    }
    const matchedUse = persistedUses.find((u) => u.id === b.tool_use_id)
    const rawIds = parsed.ids
    persistedResults.push({
      id: b.tool_use_id,
      name: matchedUse?.name ?? parsed.name ?? 'tool',
      ok: !b.is_error,
      ids: Array.isArray(rawIds)
        ? (rawIds as unknown[]).filter((s): s is string => typeof s === 'string')
        : [],
    })
  }
  // Live results win over persisted (e.g. mid-stream we get fresher info).
  const allResultsById = new Map<string, (typeof persistedResults)[number]>()
  for (const r of persistedResults) allResultsById.set(r.id, r)
  for (const r of liveResults) allResultsById.set(r.id, r)
  const allResults = [...allResultsById.values()]

  const textBlocks = blocks.filter(
    (b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text',
  )

  return (
    <div className="flex justify-start">
      <div className="max-w-[88%] min-w-0 space-y-2">
        {textBlocks.map((b, i) => {
          const text = b.text
          if (!text || !text.trim()) return null
          // Cheap email-card heuristic still wins over markdown so the Copy
          // button stays useful for outreach drafting.
          const emailMatch = parseDraftEmail(text)
          if (emailMatch) {
            return (
              <DraftEmailCard
                key={`em-${i}`}
                subject={emailMatch.subject}
                body={emailMatch.body}
                prefix={emailMatch.prefix}
              />
            )
          }
          return (
            <div
              key={`t-${i}`}
              className="rounded-2xl rounded-bl-md border border-border bg-card px-4 py-3"
            >
              <ChatMarkdown text={text} />
            </div>
          )
        })}

        {persistedUses.length > 0 ? (
          <ToolChipRail
            uses={persistedUses}
            results={allResults}
            streaming={isStreaming}
          />
        ) : null}
      </div>
    </div>
  )
}

/* ---------------------------- tool chips -------------------------------- */

const TOOL_LABELS: Record<string, { running: string; done: string }> = {
  list_listings: { running: 'Searching listings', done: 'Searched listings' },
  get_listing: { running: 'Reading listing', done: 'Read listing' },
  save_listing: { running: 'Saving', done: 'Saved listing' },
  unsave_listing: { running: 'Removing', done: 'Removed listing' },
  get_saved: { running: 'Fetching saved', done: 'Loaded saved' },
  compare_listings: { running: 'Comparing', done: 'Compared' },
  get_profile_summary: { running: 'Reading profile', done: 'Read profile' },
  draft_email: { running: 'Drafting email', done: 'Drafted email' },
}

function humanizeTool(name: string, done: boolean): string {
  const labels = TOOL_LABELS[name]
  if (labels) return done ? labels.done : labels.running
  // Fallback: snake_case -> "Snake case"
  const pretty = name.replace(/_/g, ' ')
  return pretty.charAt(0).toUpperCase() + pretty.slice(1)
}

function suffixForResult(
  name: string,
  count: number | undefined,
): string {
  if (typeof count !== 'number' || count < 0) return ''
  if (count === 0) return ' · 0 found'
  switch (name) {
    case 'list_listings':
      return ` · ${count} found`
    case 'get_saved':
      return ` · ${count} saved`
    case 'compare_listings':
      return ` · ${count} compared`
    case 'save_listing':
    case 'unsave_listing':
    case 'get_listing':
    case 'draft_email':
    case 'get_profile_summary':
      return ''
    default:
      return ` · ${count}`
  }
}

function ToolChipRail({
  uses,
  results,
  streaming,
}: {
  uses: Array<{ id: string; name: string; input?: unknown }>
  results: Array<{ id: string; name: string; ok: boolean; ids: string[] }>
  streaming: boolean
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 px-1 pt-0.5">
      {uses.map((u) => {
        const r = results.find((x) => x.id === u.id)
        return (
          <ToolChip
            key={u.id}
            name={u.name}
            done={!!r}
            ok={r?.ok ?? true}
            count={r?.ids.length}
            streaming={streaming && !r}
          />
        )
      })}
    </div>
  )
}

function ToolChip({
  name,
  done,
  ok,
  count,
  streaming,
}: {
  name: string
  done: boolean
  ok: boolean
  count?: number
  streaming?: boolean
}) {
  const text = humanizeTool(name, done) + (done ? suffixForResult(name, count) : '')
  return (
    <span
      className={cn(
        'tabular inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5',
        'text-[11px] font-medium',
        done
          ? ok
            ? 'border-border bg-surface-2 text-muted-foreground'
            : 'border-destructive/30 bg-destructive/5 text-destructive'
          : 'border-border bg-surface-2 text-muted-foreground',
      )}
      aria-live={streaming ? 'polite' : 'off'}
    >
      {done ? (
        <Check className="h-2.5 w-2.5" aria-hidden />
      ) : (
        <Loader2 className="h-2.5 w-2.5 animate-spin" aria-hidden />
      )}
      <Wrench className="h-2.5 w-2.5 opacity-50" aria-hidden />
      <span>{text}</span>
    </span>
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
        <div className="rounded-2xl rounded-bl-md border border-border bg-card px-4 py-3">
          <ChatMarkdown text={prefix} />
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
