import { useEffect, useRef, useState } from 'react'
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom'
import useSeo from '../../../hooks/useSeo.js'
import useRegistrationEvent from '../../../hooks/useRegistrationEvent.js'
import usePendingChanges from '../../../hooks/usePendingChanges.js'
import { discardRegistrationChanges } from '../../../lib/organizer.js'
import { closesLabel, missingAfterPublish, noticeResult, registeredLine } from '../../../lib/pendingChanges.js'
import { STEP_KEYS, wizardSteps } from '../../../lib/wizardSteps.js'
import { stagedEvent } from '../../../lib/stagedEvent.js'
import { btnGhost, btnPrimary } from '../settingsUi.js'
import { useKlub } from '../context.js'
import Podstawy from './steps/Podstawy.jsx'
import Biuro from './steps/Biuro.jsx'
import Konkurencje from './steps/Konkurencje.jsx'
import Kategorie from './steps/Kategorie.jsx'
import Pomiar from './steps/Pomiar.jsx'
import Formularz from './steps/Formularz.jsx'
import Dodatki from './steps/Dodatki.jsx'
import Platnosci from './steps/Platnosci.jsx'
import Publikacja from './steps/Publikacja.jsx'
import Zgloszenia from './Zgloszenia.jsx'
import PendingChangesBar from './PendingChangesBar.jsx'
import PublishChangesDialog from './PublishChangesDialog.jsx'

// A registration event in the organizer's hands. A draft (A2–A7) is the
// wizard with its stepper and autosave. A published event (A8) is the same
// steps as tabs, with „Zgłoszenia” first for the owner and admins (runner
// data is theirs only), what is still worth adding, and the staged changes
// bar that opens A8a.

const STEP_COMPONENTS = {
  podstawy: Podstawy, biuro: Biuro, konkurencje: Konkurencje, kategorie: Kategorie, pomiar: Pomiar,
  formularz: Formularz, dodatki: Dodatki, platnosci: Platnosci, publikacja: Publikacja,
}

// The section each step saves.
const SECTIONS_OF = { podstawy: 'basics', biuro: 'office', konkurencje: 'competitions', kategorie: 'categories', pomiar: 'timing', formularz: 'form', platnosci: 'payments' }

const SECTION_STEP = {
  basics: 'Podstawy', office: 'Biuro zawodów', competitions: 'Konkurencje',
  categories: 'Kategorie', timing: 'Pomiar czasu', form: 'Formularz', payments: 'Płatności',
}

/** „Nie zapisano: Podstawy — Ten adres jest już zajęty.” */
function unsavedMessage(error) {
  const detail = error.fields ? Object.values(error.fields).join(' ') : error.message
  return `Nie zapisano: ${SECTION_STEP[error.section] ?? error.section} — ${detail}`
}

const warsawTime = new Intl.DateTimeFormat('pl-PL', { timeZone: 'Europe/Warsaw', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })

function SaveStatus({ settings, saveState }) {
  const draft = settings.state === 'draft'
  const closes = closesLabel(settings.closesOn)
  const label = draft ? 'SZKIC' : closes ? `OPUBLIKOWANE · ZAPISY DO ${closes}` : 'OPUBLIKOWANE'
  let text
  let tone = 'text-apex-muted'
  if (saveState.savingSections.length) text = 'ZAPISYWANIE…'
  else if (saveState.error) {
    text = 'NIE ZAPISANO'
    tone = 'text-apex-red'
  } else if (draft) {
    const at = saveState.savedAt ?? (settings.updatedAt ? new Date(settings.updatedAt) : null)
    text = at ? `ZAPISANO AUTOMATYCZNIE ${warsawTime.format(at)}` : 'ZAPISANO AUTOMATYCZNIE'
  }
  if (!text) {
    return (
      <span data-testid="save-status" className="font-mono text-xs text-apex-yellow">
        <span>●</span> {label}
      </span>
    )
  }
  return (
    <span data-testid="save-status" className={`font-mono text-xs ${tone}`}>
      <span className="text-apex-cyan">●</span> {label} · {text}
    </span>
  )
}

function Stepper({ steps, current, base, onGo }) {
  return (
    <nav aria-label="Kroki" className="flex overflow-x-auto -mx-4 px-4 md:mx-0 md:px-0">
      {steps.map((s, i) => {
        const on = s.key === current
        const cls = `whitespace-nowrap flex items-center gap-2 min-h-10 px-3 font-sans text-base font-semibold border-b-2 no-underline ${
          on ? 'text-apex-yellow border-apex-yellow' : s.done ? 'text-apex-text border-apex-border' : 'text-apex-muted border-apex-border'}`
        const mark = <span className="font-mono text-xs">{s.done ? '✓' : i + 1}</span>
        if (!s.available) {
          return (
            <span key={s.key} className={`${cls} opacity-60`} aria-disabled="true">
              {mark}{s.label}<span className="font-mono text-[10px] normal-case">wkrótce</span>
            </span>
          )
        }
        return (
          <Link key={s.key} to={`${base}/${s.key}`} className={cls} aria-current={on ? 'step' : undefined}
            onClick={(e) => { e.preventDefault(); onGo(s.key) }}>
            {mark}{s.label}
          </Link>
        )
      })}
    </nav>
  )
}

// A8: the steps as tabs. „Zgłoszenia” first for the owner and admins.
function Tabs({ tabs, current, base, onGo }) {
  const list = useRef(null)
  // On a phone the row scrolls sideways: bring the open tab into it, without moving the page.
  useEffect(() => {
    const el = list.current?.querySelector('[aria-selected="true"]')
    if (el && list.current.scrollWidth > list.current.clientWidth) {
      list.current.scrollLeft = el.offsetLeft - (list.current.clientWidth - el.offsetWidth) / 2
    }
  }, [current])
  return (
    <div ref={list} role="tablist" aria-label="Zakładki" className="relative flex overflow-x-auto -mx-4 px-4 md:mx-0 md:px-0">
      {tabs.map((t) => {
        const on = t.key === current
        const cls = `whitespace-nowrap flex items-center gap-1.5 min-h-[42px] px-3 font-sans text-base font-semibold border-b-2 no-underline ${
          on ? 'text-apex-yellow border-apex-yellow' : 'text-apex-text border-apex-border hover:text-apex-text-bright'}`
        if (!t.available) {
          return (
            <span key={t.key} role="tab" aria-selected="false" aria-disabled="true" className={`${cls} opacity-60`}>
              {t.label}<span className="font-mono text-[10px]">wkrótce</span>
            </span>
          )
        }
        return (
          <Link key={t.key} role="tab" aria-selected={on} to={`${base}/${t.key}`} className={cls}
            onClick={(e) => { e.preventDefault(); onGo(t.key) }}>
            {t.label}
          </Link>
        )
      })}
    </div>
  )
}

const eventDay = (iso) => {
  if (!iso) return null
  const [y, m, d] = iso.split('-')
  return `${Number(d)}.${m}.${y}`
}

/** „Brakuje: …” with the first item's step behind „Uzupełnij”. Lower-case labels, as in a sentence. */
function MissingBanner({ missing, onFill }) {
  const text = missing.map((m) => m.label.charAt(0).toLocaleLowerCase('pl-PL') + m.label.slice(1)).join(', ')
  return (
    <div data-testid="missing-banner" className="border border-apex-yellow-dim bg-apex-surface-2 px-4 py-3 flex flex-wrap items-center justify-between gap-3">
      <span className="min-w-0 font-sans text-[17px] text-apex-text-bright"><span className="font-mono text-apex-yellow">●</span> Brakuje: {text}</span>
      {onFill && (
        <Link to={onFill.href} onClick={(e) => { e.preventDefault(); onFill.go() }}
          className={`${btnGhost} !border-apex-yellow-dim no-underline inline-block`}>Uzupełnij</Link>
      )}
    </div>
  )
}

function PublishedHeader({ event, onCopy, copied }) {
  const s = event.settings
  const line = [eventDay(s.eventDate), s.townLabel].filter(Boolean).join(' · ')
  const [count, ...rest] = registeredLine(event.registeredCount ?? 0, event.competitions ?? []).split(' zapisanych')
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0 flex flex-col gap-1.5">
        <h1 className="font-display font-extrabold text-3xl md:text-4xl uppercase leading-none text-apex-text-bright break-words">{s.name}</h1>
        <span className="font-sans text-[17px]">
          {line && <>{line} · </>}
          <span data-testid="registered-count"><span className="font-mono text-apex-yellow">{count}</span> zapisanych{rest.join('')}</span>
        </span>
      </div>
      <div className="flex flex-wrap gap-2">
        <a href={`/events/${s.slug}`} target="_blank" rel="noreferrer" className={`${btnGhost} no-underline inline-block`}>Strona zawodów ↗</a>
        <button type="button" className={btnGhost} onClick={onCopy}>{copied ? 'Skopiowano' : 'Kopiuj link'}</button>
      </div>
    </div>
  )
}

function NotFoundBlock({ back }) {
  return (
    <div data-testid="event-not-found" className="py-12 text-center space-y-3">
      <div className="font-mono text-5xl font-bold text-apex-yellow">404</div>
      <h1 className="font-display font-extrabold text-2xl uppercase text-apex-text-bright">Nie znaleziono wydarzenia</h1>
      <Link to={back} className={`${btnGhost} inline-block no-underline`}>Wydarzenia klubu</Link>
    </div>
  )
}

function Editor({ eventId, stepParam }) {
  const { club } = useKlub()
  const navigate = useNavigate()
  const { ready, event, notFound, error, saveState, queue, flush, clear, reload, onSaved, reportInvalid, invalidInput } = useRegistrationEvent(eventId)
  // Why a step change was refused: { section, fields } (input that does not validate) or { flush: true }.
  const [blocked, setBlocked] = useState(null)
  // Bumped after the staged changes are discarded or published, so every step
  // re-seeds from the event as it now is instead of re-staging what it held.
  const [generation, setGeneration] = useState(0)
  const [dialog, setDialog] = useState(null) // the preview A8a opened with
  const [busy, setBusy] = useState(false) // discarding (the steps are disabled meanwhile)
  const [opening, setOpening] = useState(false) // „Opublikuj zmiany” checks before A8a opens
  const [result, setResult] = useState(null) // line after „Opublikuj zmiany”
  const [barError, setBarError] = useState(null)
  const [copied, setCopied] = useState(false)
  const copyTimer = useRef(null)
  useEffect(() => () => clearTimeout(copyTimer.current), [])
  const back = `/klub/${club.slug}/wydarzenia`
  const base = `${back}/${eventId}`

  const published = !!event && event.settings.state !== 'draft'
  const writer = event?.role === 'owner' || event?.role === 'admin'
  const staged = published && writer && !!event.pending
  const { preview, refresh } = usePendingChanges(eventId, event?.pending?.updatedAt ?? null, staged)

  useSeo({ title: `${event?.settings?.name ?? 'Wydarzenie'} — ${club.name} — Leszy.run`, noindex: true })

  // A new staged change makes the last „Opublikowano zmiany” line stale.
  useEffect(() => { if (event?.pending) setResult(null) }, [event?.pending])

  if (!ready) {
    return (
      <div className="space-y-4" aria-busy="true">
        <div className="h-4 w-64 bg-apex-surface animate-pulse" />
        <div className="h-10 w-full bg-apex-surface animate-pulse" />
        <div className="h-64 w-full bg-apex-surface animate-pulse" />
      </div>
    )
  }
  if (notFound) return <NotFoundBlock back={back} />
  if (!event) return <p className="text-apex-red font-sans text-sm">{error}</p>
  // An event of another club opened under this club's address.
  if (event.settings.clubId !== club.id) return <NotFoundBlock back={back} />

  const readOnly = !writer
  const home = published && writer ? 'zgloszenia' : 'podstawy'
  if (!stepParam) return <Navigate to={`${base}/${home}`} replace />
  const current = stepParam
  const steps = wizardSteps({
    pricingMode: event.settings.pricingMode,
    hasKidsCompetition: event.competitions.some((c) => c.isKids),
    state: { checklist: event.checklist, current },
  })
  const onRegistrations = current === 'zgloszenia' && published && writer
  const index = steps.findIndex((s) => s.key === current)
  // Dodatki is listed but not built: its page only says so.
  if (!onRegistrations && (!STEP_KEYS.includes(current) || index < 0 || (!steps[index].available && current !== 'dodatki'))) {
    return <Navigate to={`${base}/${home}`} replace />
  }

  const prev = steps.slice(0, Math.max(index, 0)).reverse().find((s) => s.available)
  const next = index < 0 ? null : steps.slice(index + 1).find((s) => s.available)
  const StepBody = onRegistrations ? null : STEP_COMPONENTS[current]
  // Publikacja stays reachable by its address after publish, not as a tab.
  const tabs = published
    ? [...(writer ? [{ key: 'zgloszenia', label: 'Zgłoszenia', available: true }] : []),
      ...steps.filter((s) => s.key !== 'publikacja').map((s) => ({ ...s, available: s.available || s.key === 'dodatki' }))]
    : null
  const missing = published ? missingAfterPublish(event.checklist?.missing ?? []) : []
  const diff = preview?.diff ?? []
  // Input that does not validate yet, while the alert about it is up (N3: it goes once fixed).
  const stillBad = blocked?.fields ? invalidInput() : null

  // Before the staged changes are judged: nothing unsaved or unsavable left behind.
  async function settle() {
    const bad = invalidInput()
    if (bad) {
      setBlocked({ section: bad.section, fields: bad.fields })
      return false
    }
    if (!(await flush())) {
      setBlocked({ flush: true })
      return false
    }
    setBlocked(null)
    return true
  }

  async function go(key) {
    // Input that does not validate yet would be lost: stay and say what (P2-R27).
    // Leaving a step with an unsaved value would hide its error: stay and say what failed.
    if (!(await settle())) return
    navigate(`${base}/${key}`)
    window.scrollTo(0, 0)
  }

  async function openPublish() {
    setBarError(null)
    setOpening(true)
    try {
      if (!(await settle())) return
      const fresh = await refresh()
      if (fresh?.diff?.length) setDialog(fresh)
    } finally {
      setOpening(false)
    }
  }

  async function discard() {
    setBarError(null)
    setBusy(true)
    try {
      // Whatever was typed is staged first, so the discard takes it too.
      await flush()
      await discardRegistrationChanges(eventId)
      // A value that failed to save is still queued: it must not stage again (I1).
      await clear()
      await reload()
      setGeneration((g) => g + 1)
      setBlocked(null)
    } catch (err) {
      setBarError(err.message)
    } finally {
      setBusy(false)
    }
  }

  async function published_(answer, requested) {
    await reload()
    setGeneration((g) => g + 1)
    setDialog(null)
    setResult(noticeResult(answer.notice, requested))
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/events/${event.settings.slug}`)
      setCopied(true)
      clearTimeout(copyTimer.current)
      copyTimer.current = setTimeout(() => setCopied(false), 2000)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div data-testid="event-editor" className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 font-mono text-xs uppercase text-apex-muted truncate">
          <Link to={back} className="text-apex-muted hover:text-apex-text-bright no-underline">Wydarzenia</Link>
          <span> / </span>
          <span className="text-apex-text-bright">{event.settings.name}</span>
        </div>
        <SaveStatus settings={event.settings} saveState={saveState} />
      </div>
      {stillBad && !saveState.error && (
        <p role="alert" data-testid="unsaved" className="border border-apex-red px-3.5 py-2.5 text-apex-red font-sans text-sm">
          {unsavedMessage(stillBad)}
        </p>
      )}
      {saveState.error && (saveState.error.section !== SECTIONS_OF[current] || !saveState.error.fields || blocked) && (
        <p role="alert" data-testid="unsaved" className="border border-apex-red px-3.5 py-2.5 text-apex-red font-sans text-sm">
          {unsavedMessage(saveState.error)}
        </p>
      )}

      {published ? (
        <>
          <PublishedHeader event={event} onCopy={copyLink} copied={copied} />
          {missing.length > 0 && (
            <MissingBanner missing={missing}
              onFill={writer ? { href: `${base}/${missing[0].step}`, go: () => go(missing[0].step) } : null} />
          )}
          {result && <p data-testid="changes-result" className="font-mono text-sm text-apex-yellow">{result}</p>}
          <Tabs tabs={tabs} current={current} base={base} onGo={go} />
        </>
      ) : (
        <>
          <Stepper steps={steps} current={current} base={base} onGo={go} />
          <h1 className="font-display font-extrabold text-3xl md:text-4xl uppercase leading-none text-apex-text-bright">{steps[index].label}</h1>
        </>
      )}

      {onRegistrations && <Zgloszenia eventId={eventId} />}
      {StepBody && (
        <StepBody key={`${current}:${generation}`} event={stagedEvent(event)} queue={queue} saveState={saveState} readOnly={readOnly || busy} reload={reload}
          onSaved={onSaved} reportInvalid={reportInvalid} base={base} previewHref={`${base}/podglad`} />
      )}

      {!published && (
        <div className="flex flex-wrap gap-3 pt-2">
          {prev && <button type="button" className={btnGhost} onClick={() => go(prev.key)}>Wstecz</button>}
          {next && (
            <button type="button" className={btnPrimary} onClick={() => go(next.key)}>
              Dalej: {next.label.toLocaleLowerCase('pl-PL')}
            </button>
          )}
        </div>
      )}

      {barError && <p role="alert" className="text-apex-red font-sans text-sm">{barError}</p>}
      {staged && diff.length > 0 && (
        <PendingChangesBar diff={diff} previewHref={`${base}/podglad`} busy={busy || opening} onDiscard={discard} onPublish={openPublish} />
      )}
      {dialog && (
        <PublishChangesDialog eventId={eventId} eventName={event.settings.name} competitions={event.competitions}
          preview={dialog} refresh={refresh} onCancel={() => setDialog(null)} onPublished={published_} />
      )}
    </div>
  )
}

export default function EventEditor() {
  const { eventId, step } = useParams()
  return <Editor key={eventId} eventId={eventId} stepParam={step} />
}
