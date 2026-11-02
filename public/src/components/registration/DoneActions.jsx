import { useState } from 'react'
import { Link } from 'react-router-dom'
import { icsFor, googleCalendarUrl } from '../../lib/calendarFile.js'
import { shareLinks, signedUpShareText, signedUpShareUrl, storyImagePath } from '../../lib/shareLinks.js'
import { labelCls, linkCls } from './ui.js'

// „Co dalej” on RA5, after a free registration (Zapisano) and a paid order
// (Zamowienie): the calendar entry (a Google Calendar link, and the .ics file
// for Apple and Outlook, labelled as a file because a desktop browser only
// saves it), „Pochwal się” (the event page's „Jestem na liście” card), „Napisz do organizatora” (the
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
      <ShareActions slug={raw.slug} title={model.title} date={model.dateLabel?.split(' · ')[0] ?? null} />
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

const shareBtn = 'min-h-11 px-3 flex items-center justify-center border border-apex-border-bright text-apex-text-bright font-sans font-bold text-base whitespace-nowrap no-underline hover:border-apex-yellow-dim disabled:opacity-60'

function canShareFiles() {
  try {
    return typeof navigator !== 'undefined' && !!navigator.canShare
      && navigator.canShare({ files: [new File([''], 'x.png', { type: 'image/png' })] })
  } catch { return false }
}

// Facebook and WhatsApp take the link, whose preview is the „JESTEM NA LIŚCIE
// STARTOWEJ” card. Instagram takes no link from a web page, only an image: a
// phone shares the story image through its own sheet (Instagram is in it), a
// computer downloads it. „Więcej” is the phone's sheet with the link.
function ShareActions({ slug, title, date }) {
  const url = signedUpShareUrl(slug)
  const text = signedUpShareText(title, date)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const files = canShareFiles()
  const sheet = typeof navigator !== 'undefined' && !!navigator.share

  const instagram = async () => {
    setBusy(true)
    try {
      const blob = await (await fetch(storyImagePath(slug))).blob()
      const name = `leszy-run-${slug}.png`
      const file = new File([blob], name, { type: 'image/png' })
      if (files) {
        try { await navigator.share({ files: [file] }) } catch { /* closed the sheet */ }
      } else {
        const href = URL.createObjectURL(file)
        const a = document.createElement('a')
        a.href = href
        a.download = name
        document.body.appendChild(a)
        a.click()
        a.remove()
        setTimeout(() => URL.revokeObjectURL(href), 1000)
      }
    } finally { setBusy(false) }
  }
  const more = async () => {
    if (sheet) {
      try { await navigator.share({ title, text, url }) } catch { /* closed the sheet */ }
      return
    }
    try { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 2000) } catch { /* no clipboard */ }
  }

  return (
    <>
      <span className={`${labelCls} mt-2`}>Pochwal się</span>
      <div className="grid grid-cols-2 gap-2" data-testid="share-links">
        {shareLinks({ url, text }).map((l) => (
          <a key={l.id} href={l.href} target="_blank" rel="noopener noreferrer" className={shareBtn} data-action>{l.label}</a>
        ))}
        <button type="button" onClick={instagram} disabled={busy} className={shareBtn} data-testid="share-instagram">
          {files ? 'Instagram' : 'Obrazek na Instagram'}
        </button>
        <button type="button" onClick={more} className={shareBtn} data-testid="share-more">
          {sheet ? 'Więcej…' : copied ? 'Skopiowano' : 'Kopiuj link'}
        </button>
      </div>
    </>
  )
}
