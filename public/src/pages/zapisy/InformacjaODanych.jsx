import { useParams } from 'react-router-dom'
import useSeo from '../../hooks/useSeo.js'
import { eventPageModel } from '../../lib/eventPageModel.js'
import { dataInfoOf } from '../../lib/dataInfo.js'
import PageTop from '../../components/registration/PageTop.jsx'
import RegistrationShell from './RegistrationShell.jsx'
import { eventPath } from './RegistrationEventPage.jsx'

// /events/<slug>/informacja-o-danych: the runner data information of one event, on its own page.
// Every consent e-mail links here (Art. 14 RODO: the added adult's data came from somebody
// else), and the registration form shows the same text (dataInfoOf). An unknown or unpublished
// slug is the 404 page (RegistrationShell).

function Block({ block }) {
  if (typeof block === 'string') return <p>{block}</p>
  if (block.list) return <ul className="list-disc pl-5 space-y-1.5">{block.list.map((x) => <li key={x}>{x}</li>)}</ul>
  const [head, ...rows] = block.table
  return (
    <div className="border border-apex-border">
      <div className="hidden sm:grid grid-cols-[3fr_2fr] gap-4 px-3 py-2 bg-apex-surface-2 font-mono text-[11px] tracking-wider uppercase text-apex-muted">
        <span>{head[0]}</span><span>{head[1]}</span>
      </div>
      {rows.map(([goal, basis]) => (
        <div key={goal} className="grid sm:grid-cols-[3fr_2fr] gap-1 sm:gap-4 px-3 py-2.5 border-t border-apex-border first:border-t-0 sm:first:border-t">
          <span>{goal}</span>
          <span className="text-apex-text-bright">{basis}</span>
        </div>
      ))}
    </div>
  )
}

export function DataInfoPage({ raw }) {
  const model = eventPageModel(raw)
  const info = dataInfoOf(raw, model)
  return (
    <article className="flex flex-col gap-5" data-testid="data-info-page">
      <PageTop back={{ to: eventPath(raw.slug), label: 'Zawody' }} right={model.title} />
      <h1 className="font-display font-extrabold text-[34px] sm:text-[42px] leading-none uppercase text-apex-text-bright">{info.title}</h1>
      {info.sections.map((s) => (
        <section key={s.heading} className="flex flex-col gap-2.5 text-base leading-relaxed text-apex-text">
          <h2 className="font-display font-extrabold text-xl uppercase text-apex-text-bright">{s.heading}</h2>
          {s.blocks.map((b, i) => <Block key={i} block={b} />)}
        </section>
      ))}
    </article>
  )
}

function Seo({ raw }) {
  useSeo({ title: `Informacja o danych — ${raw.name}`, path: `${eventPath(raw.slug)}/informacja-o-danych`, noindex: true })
  return null
}

export default function InformacjaODanych() {
  const { slug } = useParams()
  return (
    <RegistrationShell slug={slug}>
      {(raw) => <><Seo raw={raw} /><DataInfoPage raw={raw} /></>}
    </RegistrationShell>
  )
}
