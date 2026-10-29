import { Link } from 'react-router-dom'
import { icsFor } from '../../lib/calendarFile.js'
import { labelCls, linkCls } from './ui.js'

// „Co dalej” on RA5, after a free registration (Zapisano) and a paid order
// (Zamowienie): „Dodaj do kalendarza”, „Napisz do organizatora” (the event's
// contact address, never a person's) and the event page.

const act = 'flex justify-between items-center gap-3 min-h-[50px] px-3.5 border border-apex-border-mid bg-apex-surface text-apex-text-bright text-[17px] font-semibold hover:border-apex-yellow-dim'

function downloadIcs(text, name) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/calendar;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/**
 * @param {{ model: object, raw: object, eventHref: string,
 *   first: { uid: string, name: string, competition: string|null, startTime: string|null } }} p
 */
export default function DoneActions({ model, raw, eventHref, first }) {
  const mailSubject = `${model.title} — ${first.name}`
  const addToCalendar = () => {
    downloadIcs(icsFor({
      uid: first.uid, title: [model.title, first.competition].filter(Boolean).join(', '), eventDate: raw.eventDate,
      startTime: first.startTime, location: model.eventPlace, url: `https://www.leszy.run${eventHref}`,
    }), `${raw.slug}.ics`)
  }
  return (
    <>
      <span className={labelCls}>Co dalej</span>
      <button type="button" onClick={addToCalendar} className={act}>
        <span className="whitespace-nowrap">Dodaj do kalendarza</span><span className="font-mono text-apex-muted" aria-hidden="true">→</span>
      </button>
      {model.contactEmail && (
        <a href={`mailto:${model.contactEmail}?subject=${encodeURIComponent(mailSubject)}`} className={`${act} py-2`} data-testid="write-organizer">
          <span className="min-w-0">
            <span className="block whitespace-nowrap">Napisz do organizatora</span>
            <span className="block font-mono text-sm text-apex-muted font-normal break-all">{model.contactEmail}</span>
          </span>
          <span className="font-mono text-apex-muted" aria-hidden="true">→</span>
        </a>
      )}
      <Link to={eventHref} className={`text-base ${linkCls}`}>Strona zawodów</Link>
    </>
  )
}
