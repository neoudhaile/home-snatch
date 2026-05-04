import { Mail, Phone, Globe, User } from 'lucide-react'
import type { Contact } from '@/types'
import { cn } from '@/lib/utils'

export function ContactCard({ contact }: { contact: Contact | null | undefined }) {
  if (!contact || (!contact.phone && !contact.email && !contact.website && !contact.name)) {
    return (
      <SectionCard title="Contact">
        <p className="text-[13px] text-muted-foreground">
          No contact info on this listing.
        </p>
      </SectionCard>
    )
  }

  const preferredNote = contact.preferred_method
    ? `prefers ${contact.preferred_method}`
    : null

  return (
    <SectionCard title="Contact" hint={preferredNote}>
      <div className="space-y-2">
        {contact.name ? (
          <Row icon={<User className="h-3.5 w-3.5" />} label="Name">
            <span className="text-[13.5px] text-foreground">{contact.name}</span>
            {contact.agency ? (
              <span className="ml-1.5 text-[12px] text-muted-foreground">
                {contact.agency}
              </span>
            ) : null}
          </Row>
        ) : null}
        {contact.phone ? (
          <Row
            icon={<Phone className="h-3.5 w-3.5" />}
            label="Phone"
            highlight={contact.preferred_method === 'phone'}
          >
            <a
              href={`tel:${contact.phone}`}
              className="tabular text-[13.5px] font-medium text-foreground underline-offset-4 hover:underline"
            >
              {contact.phone}
            </a>
          </Row>
        ) : null}
        {contact.email ? (
          <Row
            icon={<Mail className="h-3.5 w-3.5" />}
            label="Email"
            highlight={contact.preferred_method === 'email'}
          >
            <a
              href={`mailto:${contact.email}`}
              className="text-[13.5px] font-medium text-foreground underline-offset-4 hover:underline"
            >
              {contact.email}
            </a>
          </Row>
        ) : null}
        {contact.website ? (
          <Row
            icon={<Globe className="h-3.5 w-3.5" />}
            label="Website"
            highlight={contact.preferred_method === 'website'}
          >
            <a
              href={contact.website}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[13.5px] font-medium text-foreground underline-offset-4 hover:underline"
            >
              {new URL(contact.website).host}
            </a>
          </Row>
        ) : null}
      </div>
    </SectionCard>
  )
}

function Row({
  icon,
  label,
  highlight,
  children,
}: {
  icon: React.ReactNode
  label: string
  highlight?: boolean
  children: React.ReactNode
}) {
  return (
    <div
      className={cn(
        'flex items-center gap-2 rounded-lg px-2 py-1.5',
        highlight ? 'bg-warm/40 dark:bg-warm/30' : '',
      )}
    >
      <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-secondary text-muted-foreground">
        {icon}
      </span>
      <span className="text-[11px] uppercase tracking-[0.06em] text-muted-foreground">
        {label}
      </span>
      <span className="ml-auto truncate">{children}</span>
    </div>
  )
}

export function SectionCard({
  title,
  hint,
  children,
}: {
  title: string
  hint?: string | null
  children: React.ReactNode
}) {
  return (
    <section className="rounded-2xl border border-border bg-card p-5">
      <header className="mb-3 flex items-baseline justify-between gap-2">
        <h3 className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
          {title}
        </h3>
        {hint ? (
          <span className="text-[11px] tracking-tight text-muted-foreground">
            {hint}
          </span>
        ) : null}
      </header>
      {children}
    </section>
  )
}
