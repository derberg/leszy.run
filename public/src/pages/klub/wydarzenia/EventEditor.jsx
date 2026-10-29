import { useState } from 'react'
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom'
import useSeo from '../../../hooks/useSeo.js'
import useRegistrationEvent from '../../../hooks/useRegistrationEvent.js'
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
import Publikacja from './steps/Publikacja.jsx'

// A registration event in the organizer's hands (mockups A2–A7): the draft
// wizard with its stepper and autosave. The published tabs arrive with A8.

const STEP_COMPONENTS = {
  podstawy: Podstawy, biuro: Biuro, konkurencje: Konkurencje, kategorie: Kategorie, pomiar: Pomiar,
  formularz: Formularz, dodatki: Dodatki, platnosci: Dodatki, publikacja: Publikacja,
}

// The section each step saves.
const SECTIONS_OF = { podstawy: 'basics', biuro: 'office', konkurencje: 'competitions', kategorie: 'categories', pomiar: 'timing', formularz: 'form' }

const SECTION_STEP = {
  basics: 'Podstawy', office: 'Biuro zawodów', competitions: 'Konkurencje',
  categories: 'Kategorie', timing: 'Pomiar czasu', form: 'Formularz',
}

/** „Nie zapisano: Podstawy — Ten adres jest już zajęty.” */
function unsavedMessage(error) {
  const detail = error.fields ? Object.values(error.fields).join(' ') : error.message
  return `Nie zapisano: ${SECTION_STEP[error.section] ?? error.section} — ${detail}`
}

const warsawTime = new Intl.DateTimeFormat('pl-PL', { timeZone: 'Europe/Warsaw', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })

function SaveStatus({ settings, saveState }) {
  const label = settings.state === 'draft' ? 'SZKIC' : 'OPUBLIKOWANE'
  let text
  let tone = 'text-apex-muted'
  if (saveState.savingSections.length) text = 'ZAPISYWANIE…'
  else if (saveState.error) {
    text = 'NIE ZAPISANO'
    tone = 'text-apex-red'
  } else {
    const at = saveState.savedAt ?? (settings.updatedAt ? new Date(settings.updatedAt) : null)
    text = at ? `ZAPISANO AUTOMATYCZNIE ${warsawTime.format(at)}` : 'ZAPISANO AUTOMATYCZNIE'
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
  const { ready, event, notFound, error, saveState, queue, flush, reload, onSaved, reportInvalid, invalidInput } = useRegistrationEvent(eventId)
  // Why a step change was refused: { section, fields } (input that does not validate) or { flush: true }.
  const [blocked, setBlocked] = useState(null)
  const back = `/klub/${club.slug}/wydarzenia`
  const base = `${back}/${eventId}`

  useSeo({ title: `${event?.settings?.name ?? 'Wydarzenie'} — ${club.name} — Leszy.run`, noindex: true })

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

  const current = stepParam ?? 'podstawy'
  const steps = wizardSteps({
    pricingMode: event.settings.pricingMode,
    hasKidsCompetition: event.competitions.some((c) => c.isKids),
    state: { checklist: event.checklist, current },
  })
  const index = steps.findIndex((s) => s.key === current)
  // Dodatki is listed but not built: its page only says so.
  if (!STEP_KEYS.includes(current) || index < 0 || (!steps[index].available && current !== 'dodatki')) {
    return <Navigate to={`${base}/podstawy`} replace />
  }

  const readOnly = event.role !== 'owner' && event.role !== 'admin'
  const prev = steps.slice(0, index).reverse().find((s) => s.available)
  const next = steps.slice(index + 1).find((s) => s.available)
  const StepBody = STEP_COMPONENTS[current]

  async function go(key) {
    // Input that does not validate yet would be lost: stay and say what (P2-R27).
    const bad = invalidInput()
    if (bad) {
      setBlocked({ section: bad.section, fields: bad.fields })
      return
    }
    // Leaving a step with an unsaved value would hide its error: stay and say what failed.
    if (!(await flush())) {
      setBlocked({ flush: true })
      return
    }
    setBlocked(null)
    navigate(`${base}/${key}`)
    window.scrollTo(0, 0)
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
      {blocked?.fields && !saveState.error && (
        <p role="alert" data-testid="unsaved" className="border border-apex-red px-3.5 py-2.5 text-apex-red font-sans text-sm">
          {unsavedMessage(blocked)}
        </p>
      )}
      {saveState.error && (saveState.error.section !== SECTIONS_OF[current] || !saveState.error.fields || blocked) && (
        <p role="alert" data-testid="unsaved" className="border border-apex-red px-3.5 py-2.5 text-apex-red font-sans text-sm">
          {unsavedMessage(saveState.error)}
        </p>
      )}

      <Stepper steps={steps} current={current} base={base} onGo={go} />

      <h1 className="font-display font-extrabold text-3xl md:text-4xl uppercase leading-none text-apex-text-bright">{steps[index].label}</h1>

      {StepBody && (
        <StepBody key={current} event={stagedEvent(event)} queue={queue} saveState={saveState} readOnly={readOnly} reload={reload}
          onSaved={onSaved} reportInvalid={reportInvalid} base={base} previewHref={`${base}/podglad`} />
      )}

      <div className="flex flex-wrap gap-3 pt-2">
        {prev && <button type="button" className={btnGhost} onClick={() => go(prev.key)}>Wstecz</button>}
        {next && (
          <button type="button" className={btnPrimary} onClick={() => go(next.key)}>
            Dalej: {next.label.toLocaleLowerCase('pl-PL')}
          </button>
        )}
      </div>
    </div>
  )
}

export default function EventEditor() {
  const { eventId, step } = useParams()
  return <Editor key={eventId} eventId={eventId} stepParam={step} />
}
