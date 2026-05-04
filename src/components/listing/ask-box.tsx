'use client'

import { useRef, useState } from 'react'
import { Send, Sparkles } from 'lucide-react'
import { toast } from 'sonner'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'

export function AskBox({ listingId }: { listingId: string }) {
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [response, setResponse] = useState<string>('')
  const abortRef = useRef<AbortController | null>(null)

  async function submit() {
    if (!value.trim() || busy) return
    setBusy(true)
    setResponse('')
    const ac = new AbortController()
    abortRef.current?.abort()
    abortRef.current = ac

    try {
      const res = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ listing_id: listingId, question: value }),
        signal: ac.signal,
      })
      if (!res.ok || !res.body) {
        toast.error('Could not reach the agent. Try again.')
        setResponse('')
        return
      }
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let acc = ''
      while (true) {
        const { value: chunk, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(chunk, { stream: true })
        const events = buffer.split('\n\n')
        buffer = events.pop() ?? ''
        for (const evt of events) {
          if (evt.startsWith('event: end')) continue
          if (evt.startsWith('event: error')) {
            const errLines = evt.split('\n').filter((l) => l.startsWith('data: '))
            const errText = errLines.map((l) => l.slice(6)).join('\n')
            toast.error(errText || 'Stream error.')
            continue
          }
          const lines = evt.split('\n').filter((l) => l.startsWith('data: '))
          const text = lines.map((l) => l.slice(6)).join('\n')
          if (text === '[DONE]') continue
          acc += text
          setResponse(acc)
        }
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') return
      toast.error('Network error.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="rounded-2xl border border-border bg-card p-5">
      <header className="mb-3 flex items-center gap-2">
        <span
          aria-hidden
          className="grid h-6 w-6 place-items-center rounded-full bg-secondary text-foreground"
        >
          <Sparkles className="h-3.5 w-3.5" />
        </span>
        <h3 className="text-[13px] font-medium text-foreground">
          Ask anything about this place
        </h3>
      </header>
      <div className="relative">
        <Textarea
          value={value}
          onChange={(e) => setValue(e.target.value)}
          rows={3}
          aria-label="Ask about this listing"
          placeholder="Is the F train reliable from here? What's the closest grocery store?"
          className="min-h-[88px] resize-none border-border bg-surface-2 pr-12 text-[14px] placeholder:text-muted-foreground"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              void submit()
            }
          }}
        />
        <button
          onClick={submit}
          disabled={!value.trim() || busy}
          aria-label="Send"
          className={cn(
            'absolute bottom-2.5 right-2.5 grid h-8 w-8 cursor-pointer place-items-center rounded-full transition-all',
            value.trim() && !busy
              ? 'bg-foreground text-background hover:opacity-90'
              : 'bg-secondary text-muted-foreground',
            busy && 'animate-pulse',
          )}
        >
          <Send className="h-3.5 w-3.5" aria-hidden />
        </button>
      </div>
      {response ? (
        <div className="mt-4 whitespace-pre-wrap rounded-xl border border-border bg-surface-2 p-4 text-[13.5px] leading-relaxed text-foreground">
          {response}
          {busy ? <span className="ml-1 inline-block h-3 w-1.5 animate-pulse bg-foreground/70 align-baseline" /> : null}
        </div>
      ) : null}
      <p className="mt-2 text-[11px] text-muted-foreground">
        Press <kbd className="rounded border border-border bg-surface-2 px-1 text-[10px]">⌘</kbd>+
        <kbd className="rounded border border-border bg-surface-2 px-1 text-[10px]">Enter</kbd> to send.
      </p>
    </section>
  )
}
