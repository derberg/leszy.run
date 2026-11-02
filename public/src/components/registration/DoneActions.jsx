import { useState } from 'react'
import { Link } from 'react-router-dom'
import { icsFor, googleCalendarUrl } from '../../lib/calendarFile.js'
import { shareLinks } from '../../lib/shareLinks.js'
import { labelCls, linkCls } from './ui.js'

// „Co dalej” on RA5, after a free registration (Zapisano) and a paid order
// (Zamowienie): the calendar entry (a Google Calendar link, and the .ics file
// for Apple and Outlook, labelled as a file because a desktop browser only
// saves it), „Udostępnij” (the event page), „Napisz do organizatora” (the
// event's contact address, never a person's) and the event page.

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
 *   first: { uid: string, name: string, competition: string|null, startTime: string|null },
 *   teamHref?: string|null }} p
 * `teamHref`: the captain's way to RB4.
 */
export default function DoneActions({ model, raw, eventHref, first, teamHref = null }) {
  const mailSubject = `${model.title} — ${first.name}`
  const pageUrl = `https://www.leszy.run${eventHref}`
  const entry = {
    title: [model.title, first.competition].filter(Boolean).join(', '), eventDate: raw.eventDate,
    startTime: first.startTime, location: model.eventPlace, url: pageUrl,
  }
  const saveIcs = () => downloadIcs(icsFor({ uid: first.uid, ...entry }), `${raw.slug}.ics`)
  return (
    <>
      <span className={labelCls}>Co dalej</span>
      {teamHref && (
        <Link to={teamHref} className={`${act} no-underline`} data-action>
          <span className="whitespace-nowrap">Zarządzaj składem</span><span className="font-mono text-apex-muted" aria-hidden="true">→</span>
        </Link>
      )}
      <a href={googleCalendarUrl(entry)} target="_blank" rel="noopener noreferrer" className={`${act} no-underline`} data-action data-testid="calendar-google">
        <span className="whitespace-nowrap">Dodaj do Kalendarza Google</span><span className="font-mono text-apex-muted" aria-hidden="true">↗</span>
      </a>
      <button type="button" onClick={saveIcs} className={act} data-testid="calendar-ics">
        <span className="whitespace-nowrap">Apple / Outlook: pobierz plik .ics</span><span className="font-mono text-apex-muted" aria-hidden="true">↓</span>
      </button>
      <ShareAction url={pageUrl} text={`Zapisy: ${model.title}`} title={model.title} />
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

const shareBtn = 'flex-1 min-h-11 px-3 flex items-center justify-center border border-apex-border-bright text-apex-text-bright font-sans font-bold text-base whitespace-nowrap no-underline hover:border-apex-yellow-dim'

// A phone's own share sheet when the browser has one; otherwise the networks'
// share links and „Kopiuj link”, shown under the button.
function ShareAction({ url, text, title }) {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const share = async () => {
    if (typeof navigator !== 'undefined' && navigator.share) {
      try { await navigator.share({ title, text, url }); return } catch (e) {
        if (e?.name === 'AbortError') return
      }
    }
    setOpen((v) => !v)
  }
  const copy = async () => {
    try { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 2000) } catch { /* no clipboard: the links still work */ }
  }
  return (
    <>
      <button type="button" onClick={share} className={act} aria-expanded={open} data-testid="share">
        <span className="whitespace-nowrap">Udostępnij znajomym</span><span className="font-mono text-apex-muted" aria-hidden="true">→</span>
      </button>
      {open && (
        <div className="grid grid-cols-2 gap-2" data-testid="share-links">
          {shareLinks({ url, text }).map((l) => (
            <a key={l.id} href={l.href} target="_blank" rel="noopener noreferrer" className={shareBtn} data-action>{l.label}</a>
          ))}
          <button type="button" onClick={copy} className={shareBtn}>{copied ? 'Skopiowano' : 'Kopiuj link'}</button>
        </div>
      )}
    </>
  )
}
