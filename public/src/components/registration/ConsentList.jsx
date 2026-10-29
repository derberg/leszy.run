import { useState } from 'react'
import { labelCls, linkCls } from './ui.js'

// The registration consents (RA2): the event's own (regulamin, data
// information, the image acceptance, the organizer's extra ones) and the LESZY.RUN service
// regulamin. Every box starts unticked and every one is required (spec §2:
// red asterisk, „* wymagane do zapisu”); the form's button stays disabled
// until all are ticked.

function Asterisk() {
  return <span className="text-apex-red" aria-hidden="true">*</span>
}

/** The consent text with its document linked where the text names it. */
function ConsentText({ consent, regulaminUrl, onDataInfo, dataInfoOpen }) {
  const { kind, text } = consent
  // The image acceptance (P2-R33) is a term of the regulamin: its „regulaminem” links there too.
  const namesRegulamin = kind === 'regulamin' || kind === 'image'
  const target = namesRegulamin ? /regulamin\p{L}*/iu : kind === 'data_info' ? /informacj\p{L}* o danych( osobowych)?/iu : null
  const m = target ? target.exec(text) : null
  let link = null
  if (namesRegulamin && regulaminUrl) {
    link = (label) => <a href={regulaminUrl} target="_blank" rel="noopener noreferrer" className={linkCls}>{label}</a>
  } else if (kind === 'data_info') {
    link = (label) => (
      <button type="button" onClick={onDataInfo} aria-expanded={dataInfoOpen} className={`${linkCls} font-[inherit]`}>{label}</button>
    )
  }
  if (!link) return <>{text}</>
  if (!m) return kind === 'image' ? <>{text}</> : <>{text} ({link(kind === 'regulamin' ? 'regulamin' : 'informacja o danych')})</>
  return <>{text.slice(0, m.index)}{link(m[0])}{text.slice(m.index + m[0].length)}</>
}

function DataInfo({ info }) {
  return (
    <div data-testid="data-info" className="border border-apex-border bg-apex-surface p-4 font-sans text-sm text-apex-text space-y-3 max-h-96 overflow-y-auto">
      <p className="font-display font-bold uppercase text-apex-text-bright">{info.title}</p>
      {info.sections.map((s) => (
        <div key={s.heading} className="space-y-1.5">
          <p className="font-bold text-apex-text-bright">{s.heading}</p>
          {s.blocks.map((b, i) => {
            if (typeof b === 'string') return <p key={i}>{b}</p>
            if (b.list) return <ul key={i} className="list-disc pl-5 space-y-1">{b.list.map((x) => <li key={x}>{x}</li>)}</ul>
            return (
              <div key={i} className="space-y-1.5">
                {b.table.slice(1).map(([goal, basis]) => (
                  <p key={goal}>{goal}: <span className="text-apex-text-bright">{basis}</span></p>
                ))}
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )
}

/**
 * @param {{ consents: Array<{ id, kind, text }>, accepted: Record<string, boolean>, onToggle: (id, checked) => void,
 *   serviceAccepted: boolean, onService: (checked) => void, regulaminUrl: string|null, dataInfo: object, error?: string }} p
 */
export default function ConsentList({ consents, accepted, onToggle, serviceAccepted, onService, regulaminUrl, dataInfo, error }) {
  const [infoOpen, setInfoOpen] = useState(false)
  const row = 'flex gap-3 items-start font-sans text-[15px] leading-snug text-apex-text cursor-pointer'
  const box = 'mt-0.5 w-5 h-5 shrink-0 accent-apex-yellow rounded-none'
  return (
    <fieldset className="flex flex-col gap-3" data-testid="consents">
      <legend className={`${labelCls} mb-3`}>Zgody</legend>
      {consents.map((c) => (
        <div key={c.id}>
          <label className={row}>
            <input type="checkbox" className={box} checked={accepted[c.id] === true} required
              onChange={(e) => onToggle(c.id, e.target.checked)} />
            <span><Asterisk /> <ConsentText consent={c} regulaminUrl={regulaminUrl} dataInfoOpen={infoOpen}
              onDataInfo={(e) => { e.preventDefault(); setInfoOpen((o) => !o) }} /></span>
          </label>
          {c.kind === 'data_info' && infoOpen && <div className="mt-3"><DataInfo info={dataInfo} /></div>}
        </div>
      ))}
      <label className={row}>
        <input type="checkbox" className={box} checked={serviceAccepted} required onChange={(e) => onService(e.target.checked)} />
        <span><Asterisk /> Akceptuję <a href="/regulamin" target="_blank" rel="noopener noreferrer" className={linkCls}>regulamin serwisu LESZY.RUN</a>.</span>
      </label>
      <span className="font-sans text-[13px] text-apex-muted"><Asterisk /> wymagane do zapisu</span>
      {error && <p className="text-apex-red font-sans text-sm">{error}</p>}
    </fieldset>
  )
}
