import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { ChatShell } from '@/components/chat/chat-shell'
import { getKnownSavers } from '@/lib/profile-set'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Chat · homeSnatch',
}

/**
 * Full-screen chat page. Server Component shell + a Client Component for the
 * conversation surface itself. The header here mirrors the /saved minimal bar
 * so we keep the visual identity without duplicating filter chrome.
 */
export default async function ChatPage() {
  // The first known saver is the default account for "save from rail" actions.
  // Generalized: comes from src/profiles/, no hardcoded slug.
  const savers = await getKnownSavers()
  const defaultSaver = savers[0]

  return (
    <>
      <header className="sticky top-0 z-30 border-b border-border bg-background/85 backdrop-blur-md supports-[backdrop-filter]:bg-background/70">
        <div className="mx-auto flex h-14 max-w-[1480px] items-center gap-3 px-4 sm:px-6 lg:px-8">
          <Link
            href="/"
            aria-label="homeSnatch home"
            className="inline-flex shrink-0 items-baseline gap-0.5 cursor-pointer focus-visible:outline-none"
          >
            <span className="serif text-[24px] leading-none italic tracking-[-0.02em] text-foreground">
              home
            </span>
            <span className="serif text-[24px] leading-none tracking-[-0.02em] text-foreground">
              Snatch
            </span>
            <span aria-hidden className="ml-1 inline-block h-1.5 w-1.5 translate-y-[-2px] rounded-full bg-accent" />
          </Link>

          <span aria-hidden className="text-muted-foreground/40">/</span>
          <h1 className="text-[13px] font-medium tracking-tight text-foreground">Chat</h1>

          <Link
            href="/"
            className="ml-auto tabular inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full border border-border bg-surface-2 px-3 text-[12px] font-medium text-foreground transition-colors hover:bg-secondary"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
            <span>Feed</span>
          </Link>
        </div>
      </header>
      <main className="flex-1">
        <ChatShell defaultSaver={defaultSaver} />
      </main>
    </>
  )
}
