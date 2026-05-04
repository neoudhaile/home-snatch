'use client'

import { Children, Fragment, isValidElement, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { cn } from '@/lib/utils'
import { ListingPill } from './listing-pill'

/**
 * Loose UUID regex (any v1-v5). Catches the model's backtick-wrapped ID
 * citations as a fallback when it doesn't use the explicit
 * `[Title](listing:UUID)` syntax.
 */
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi

/** Detects numeric / currency / score-ish cells for tabular-nums + alignment. */
const NUMERIC_CELL_RE = /^\s*\$?-?\d[\d,.\s%/-]*\s*(\/mo|mo|sqft|ft²|HPD)?\s*$/i

/**
 * Renders assistant prose. If the text has no markdown signal at all, we
 * fall back to whitespace-pre-wrap so plain replies still respect newlines.
 *
 * Markdown features (via remark-gfm): tables, task lists, strikethrough,
 * autolinks. Custom overrides match the homeSnatch design tokens.
 */
export function ChatMarkdown({ text }: { text: string }) {
  if (!hasMarkdownSignal(text)) {
    return (
      <p className="whitespace-pre-wrap text-[14px] leading-relaxed text-card-foreground">
        {linkifyLooseUuids(text)}
      </p>
    )
  }

  return (
    <div
      className={cn(
        'chat-md text-[14px] leading-relaxed text-card-foreground',
        // Tight vertical rhythm between block elements without forcing a single
        // paragraph everywhere.
        '[&>*+*]:mt-2.5 [&>h2+*]:mt-1.5 [&>h3+*]:mt-1 [&>h4+*]:mt-1',
      )}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  )
}

/* ---------------------------- markdown overrides ----------------------- */

const MD_COMPONENTS: Components = {
  /* paragraphs: tight, prose-grade. */
  p({ children }) {
    return (
      <p className="text-[14px] leading-relaxed text-card-foreground">
        {processInlineChildren(children)}
      </p>
    )
  },

  /* headings: bold-body weights, no display sizes. */
  h1({ children }) {
    return (
      <h3 className="text-[15px] font-semibold tracking-[-0.005em] text-foreground">
        {processInlineChildren(children)}
      </h3>
    )
  },
  h2({ children }) {
    return (
      <h3 className="text-[15px] font-semibold tracking-[-0.005em] text-foreground">
        {processInlineChildren(children)}
      </h3>
    )
  },
  h3({ children }) {
    return (
      <h4 className="text-[14px] font-semibold tracking-[-0.005em] text-foreground">
        {processInlineChildren(children)}
      </h4>
    )
  },
  h4({ children }) {
    return (
      <h5 className="text-[13.5px] font-semibold tracking-[-0.005em] text-foreground/90">
        {processInlineChildren(children)}
      </h5>
    )
  },
  h5({ children }) {
    return (
      <h5 className="text-[13px] font-semibold uppercase tracking-[0.04em] text-muted-foreground">
        {processInlineChildren(children)}
      </h5>
    )
  },
  h6({ children }) {
    return (
      <h6 className="text-[12px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
        {processInlineChildren(children)}
      </h6>
    )
  },

  /* lists: tight, custom marker. Numbered uses serif italic numerals. */
  ul({ children }) {
    return (
      <ul className="space-y-1 pl-1 [&_ul]:mt-1 [&_ul]:pl-3 [&_ol]:mt-1 [&_ol]:pl-3">
        {children}
      </ul>
    )
  },
  ol({ children, start }) {
    return (
      <ol
        start={start ?? undefined}
        className="chat-md-ol space-y-1 pl-1 [counter-reset:chatlist] [&_ol]:mt-1 [&_ol]:pl-3 [&_ul]:mt-1 [&_ul]:pl-3"
      >
        {children}
      </ol>
    )
  },
  li({ children, ...rest }) {
    const checked = (rest as { checked?: boolean | null }).checked
    if (checked === true || checked === false) {
      return (
        <li className="flex items-start gap-2 text-[14px] leading-relaxed text-card-foreground">
          <span
            className={cn(
              'mt-[3px] grid h-3.5 w-3.5 shrink-0 place-items-center rounded-[4px] border',
              checked
                ? 'border-foreground/30 bg-foreground/10 text-foreground'
                : 'border-border bg-surface-2',
            )}
            aria-hidden
          >
            {checked ? <span className="text-[10px] leading-none">✓</span> : null}
          </span>
          <span>{processInlineChildren(children)}</span>
        </li>
      )
    }
    return (
      <li className="chat-md-li relative pl-5 text-[14px] leading-relaxed text-card-foreground marker:text-muted-foreground">
        {processInlineChildren(children)}
      </li>
    )
  },

  /* inline emphasis: weight + italic only, no color shift. */
  strong({ children }) {
    return <strong className="font-semibold text-foreground">{processInlineChildren(children)}</strong>
  },
  em({ children }) {
    return <em className="italic">{processInlineChildren(children)}</em>
  },

  /* code: mono token + subtle bg. Block code = surface-2 panel. */
  code({ children, className }) {
    const isBlock = typeof className === 'string' && /language-/.test(className)
    if (isBlock) {
      return (
        <code className={cn('font-mono text-[12.5px] leading-relaxed', className)}>
          {children}
        </code>
      )
    }
    return (
      <code className="rounded-[5px] border border-border bg-surface-2 px-1 py-[1px] font-mono text-[12.5px] text-foreground/90">
        {children}
      </code>
    )
  },
  pre({ children }) {
    return (
      <pre className="overflow-x-auto rounded-xl border border-border bg-surface-2 px-3 py-2.5 font-mono text-[12.5px] leading-relaxed text-foreground/90">
        {children}
      </pre>
    )
  },

  /* links: foreground-color, underline-on-hover. Listing-scheme links become pills. */
  a({ href, children }) {
    if (typeof href === 'string' && href.startsWith('listing:')) {
      const id = href.slice('listing:'.length).trim()
      const label = childrenToText(children)
      if (id) return <ListingPill id={id} label={label} />
    }
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-foreground underline-offset-[3px] hover:underline focus-visible:underline"
      >
        {processInlineChildren(children)}
      </a>
    )
  },

  /* hr: thin, low-contrast separator. */
  hr() {
    return <hr className="my-3 border-border" />
  },

  /* blockquote: 1px left rule (within the design system's side-stripe rule). */
  blockquote({ children }) {
    return (
      <blockquote className="pl-3 text-[14px] italic text-foreground/80 [box-shadow:inset_1px_0_0_var(--border)]">
        {children}
      </blockquote>
    )
  },

  /* table: bordered, alt-row, sticky head, mobile horizontal scroll. */
  table({ children }) {
    return (
      <div
        className={cn(
          // Bleed past the bubble's px on small screens so wide tables can scroll
          // horizontally without breaking the bubble shape.
          '-mx-1 my-1 max-w-[calc(100%+0.5rem)] overflow-x-auto sm:mx-0 sm:max-w-full',
          'rounded-xl border border-border bg-card',
        )}
      >
        <table className="chat-md-table w-full border-collapse text-[13px] leading-relaxed">
          {children}
        </table>
      </div>
    )
  },
  thead({ children }) {
    return (
      <thead className="sticky top-0 z-[1] bg-surface-2 text-foreground/90">
        {children}
      </thead>
    )
  },
  tbody({ children }) {
    return <tbody className="[&_tr:nth-child(even)]:bg-surface-2/50">{children}</tbody>
  },
  tr({ children }) {
    return (
      <tr className="border-b border-border last:border-b-0 transition-colors duration-150 hover:bg-secondary/40">
        {children}
      </tr>
    )
  },
  th({ children, style }) {
    const text = childrenToText(children)
    const numeric = NUMERIC_CELL_RE.test(text)
    return (
      <th
        scope="col"
        style={style}
        className={cn(
          'border-b border-border px-3 py-2 text-left align-middle font-semibold text-foreground',
          'text-[11.5px] uppercase tracking-[0.04em] text-muted-foreground',
          numeric && 'tabular text-right',
        )}
      >
        {processInlineChildren(children)}
      </th>
    )
  },
  td({ children, style }) {
    const text = childrenToText(children)
    const numeric = NUMERIC_CELL_RE.test(text)
    return (
      <td
        style={style}
        className={cn(
          'px-3 py-2 align-middle text-card-foreground',
          numeric && 'tabular text-right',
        )}
      >
        {processInlineChildren(children)}
      </td>
    )
  },
}

/* ------------------------ inline UUID-fallback pass ------------------- */

/**
 * Walk children recursively. When we find a string that contains a loose UUID
 * (and isn't already a pill / link), replace each match with `<ListingPill>`.
 * This is the safety-net for when the model forgets the explicit
 * `[Title](listing:UUID)` syntax and just emits a backticked UUID.
 */
function processInlineChildren(children: ReactNode): ReactNode {
  return Children.map(children, (child, idx) => {
    if (typeof child === 'string') {
      return splitUuids(child, `inline-${idx}`)
    }
    return child
  })
}

function splitUuids(text: string, keyPrefix: string): ReactNode {
  if (!text || !UUID_RE.test(text)) {
    UUID_RE.lastIndex = 0
    return text
  }
  UUID_RE.lastIndex = 0

  const out: ReactNode[] = []
  let last = 0
  let i = 0
  for (const m of text.matchAll(UUID_RE)) {
    const start = m.index ?? 0
    if (start > last) out.push(text.slice(last, start))
    const id = m[0].toLowerCase()
    out.push(<ListingPill key={`${keyPrefix}-pill-${i++}`} id={id} />)
    last = start + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return <>{out.map((n, j) => <Fragment key={`${keyPrefix}-frag-${j}`}>{n}</Fragment>)}</>
}

function linkifyLooseUuids(text: string): ReactNode {
  return splitUuids(text, 'plain')
}

/* ------------------------ helpers ------------------------------------- */

function childrenToText(children: ReactNode): string {
  let out = ''
  Children.forEach(children, (child) => {
    if (typeof child === 'string' || typeof child === 'number') {
      out += String(child)
    } else if (isValidElement(child)) {
      const props = (child as { props?: { children?: ReactNode } }).props
      if (props && 'children' in props) out += childrenToText(props.children)
    }
  })
  return out
}

/**
 * Cheap detection of any markdown signal so plain replies don't get the full
 * react-markdown treatment (and the extra DOM that comes with it).
 */
function hasMarkdownSignal(text: string): boolean {
  if (!text) return false
  if (/(^|\n)\s{0,3}#{1,6}\s/.test(text)) return true // headings
  if (/(^|\n)\s{0,3}[-*+]\s/.test(text)) return true // ul
  if (/(^|\n)\s{0,3}\d+\.\s/.test(text)) return true // ol
  if (/\|.*\|/.test(text) && /\n\s*\|?\s*-{3,}/.test(text)) return true // table
  if (/`{1,3}[^`]/.test(text)) return true // code
  if (/\*\*[^*\n]+\*\*/.test(text)) return true // bold
  if (/(^|[^*])\*[^*\n]+\*/.test(text)) return true // italic
  if (/\[[^\]]+\]\([^)]+\)/.test(text)) return true // link
  if (/(^|\n)\s{0,3}>\s/.test(text)) return true // blockquote
  return false
}
