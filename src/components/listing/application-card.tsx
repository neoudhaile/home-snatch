import { ArrowUpRight, FileText } from 'lucide-react'
import type { Application } from '@/types'
import { SectionCard } from './contact-card'
import { formatBrokerFee } from '@/lib/format'

export function ApplicationCard({ application }: { application: Application | null | undefined }) {
  if (!application || (!application.url && !application.requirements && !application.required_docs?.length && application.fee == null)) {
    return (
      <SectionCard title="Application">
        <p className="text-[13px] text-muted-foreground">
          No application details on this listing. Reach out to the contact directly.
        </p>
      </SectionCard>
    )
  }

  const broker = formatBrokerFee(application)

  return (
    <SectionCard title="Application">
      <div className="space-y-4">
        {(application.fee != null || broker) ? (
          <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1.5">
            {application.fee != null ? (
              <Stat label="App fee" value={`$${application.fee}`} />
            ) : null}
            {broker ? <Stat label="Broker" value={broker} /> : null}
          </div>
        ) : null}

        {application.requirements ? (
          <p className="text-[13.5px] leading-snug text-foreground">
            {application.requirements}
          </p>
        ) : null}

        {application.required_docs?.length ? (
          <div>
            <p className="mb-2 text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
              Bring
            </p>
            <ul className="space-y-1.5">
              {application.required_docs.map((doc) => (
                <li
                  key={doc}
                  className="flex items-center gap-2 text-[13px] text-foreground"
                >
                  <span className="grid h-4 w-4 place-items-center rounded-sm border border-border bg-surface-2 text-muted-foreground">
                    <FileText className="h-2.5 w-2.5" />
                  </span>
                  {doc}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {application.notes ? (
          <p className="text-[12px] italic leading-snug text-muted-foreground">
            {application.notes}
          </p>
        ) : null}

        {application.url ? (
          <a
            href={application.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-full bg-foreground px-4 text-[13px] font-medium text-background transition-opacity hover:opacity-90"
          >
            Apply
            <ArrowUpRight className="h-3.5 w-3.5" />
          </a>
        ) : null}
      </div>
    </SectionCard>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
        {label}
      </div>
      <div className="tabular text-[16px] font-semibold text-foreground">{value}</div>
    </div>
  )
}
