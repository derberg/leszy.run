import { useEffect, useRef, useState } from 'react'
import {
  getState,
  getEvents,
  getCheckpoints,
  postSetup,
  postStart,
  postStop,
  postReset,
  getReaderStatus,
} from './api.js'

const STATE_POLL_MS = 2000
const READER_POLL_MS = 10000

// ---- time helpers -----------------------------------------------------

function ageSeconds(iso) {
  if (!iso) return null
  return (Date.now() - new Date(iso).getTime()) / 1000
}

function formatAge(iso) {
  const s = ageSeconds(iso)
  if (s == null) return 'brak danych'
  if (s < 5) return 'teraz'
  if (s < 60) return `${Math.floor(s)} s temu`
  if (s < 3600) return `${Math.floor(s / 60)} min temu`
  return `${Math.floor(s / 3600)} godz. temu`
}

// green < 30s, yellow < 2min, red older or lastError — see task-11 brief
function uploadTone(upload) {
  if (upload?.lastError) return 'red'
  const s = ageSeconds(upload?.lastUploadAt)
  if (s == null) return 'muted'
  if (s < 30) return 'green'
  if (s < 120) return 'yellow'
  return 'red'
}

const TONE_TEXT = {
  green: 'text-apex-green',
  yellow: 'text-apex-yellow',
  red: 'text-apex-red',
  muted: 'text-apex-muted',
}

// ---- small shared bits -------------------------------------------------

function Banner({ tone = 'red', children, onDismiss }) {
  const toneClasses = {
    red: 'border-apex-red/50 bg-apex-red/10 text-apex-red',
    yellow: 'border-apex-yellow/50 bg-apex-yellow/10 text-apex-yellow',
    green: 'border-apex-green/50 bg-apex-green/10 text-apex-green',
  }
  return (
    <div className={`border px-4 py-3 text-sm flex items-start justify-between gap-3 ${toneClasses[tone]}`}>
      <span>{children}</span>
      {onDismiss && (
        <button onClick={onDismiss} className="text-current opacity-70 hover:opacity-100 shrink-0">
          &times;
        </button>
      )}
    </div>
  )
}

function Button({ children, variant = 'primary', className = '', ...props }) {
  const variants = {
    primary: 'border-apex-yellow text-apex-yellow hover:bg-apex-yellow hover:text-apex-ink',
    danger: 'border-apex-red text-apex-red hover:bg-apex-red hover:text-apex-ink',
    muted: 'border-apex-border-mid text-apex-text hover:border-apex-text',
  }
  return (
    <button
      className={`rounded-none border px-4 py-2.5 font-display font-extrabold uppercase tracking-wide
        transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer
        ${variants[variant]} ${className}`}
      {...props}
    >
      {children}
    </button>
  )
}

function Field({ label, children }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs uppercase tracking-[0.12em] text-apex-muted">{label}</span>
      {children}
    </label>
  )
}

const inputClass =
  'rounded-none border border-apex-border-mid bg-apex-surface-2 text-apex-text-bright px-3 py-2.5 ' +
  'focus:outline-none focus:ring-2 focus:ring-apex-yellow-dim placeholder:text-apex-muted'

// ---- Setup wizard --------------------------------------------------------

function SetupWizard({ onSetupDone }) {
  const [events, setEvents] = useState([])
  const [eventsError, setEventsError] = useState(null)
  const [eventId, setEventId] = useState('')

  const [checkpoints, setCheckpoints] = useState([])
  const [checkpointsError, setCheckpointsError] = useState(null)
  const [checkpointId, setCheckpointId] = useState('')

  const [pin, setPin] = useState('')
  const [readerIp, setReaderIp] = useState('')
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [readerUsername, setReaderUsername] = useState('')
  const [readerPassword, setReaderPassword] = useState('')
  const [mqttHost, setMqttHost] = useState('')
  const [noReader, setNoReader] = useState(false)

  const [submitting, setSubmitting] = useState(false)
  const [setupError, setSetupError] = useState(null)

  useEffect(() => {
    getEvents()
      .then(setEvents)
      .catch((err) => setEventsError(err.message))
  }, [])

  useEffect(() => {
    setCheckpointId('')
    setCheckpoints([])
    if (!eventId) return
    setCheckpointsError(null)
    getCheckpoints(eventId)
      .then(setCheckpoints)
      .catch((err) => setCheckpointsError(err.message))
  }, [eventId])

  const selectedEvent = events.find((e) => e.id === eventId)
  const selectedCheckpoint = checkpoints.find((c) => c.id === checkpointId)
  const canSubmit = pin.length > 0 && eventId && checkpointId && (noReader || readerIp.trim().length > 0) && !submitting

  async function handleSubmit(e) {
    e.preventDefault()
    if (!canSubmit) return
    setSubmitting(true)
    setSetupError(null)
    try {
      const body = {
        eventId,
        eventName: selectedEvent?.name,
        checkpointId,
        checkpointName: selectedCheckpoint?.name,
        pin,
        readerIp: readerIp.trim(),
      }
      if (noReader) body.noReader = true
      if (readerUsername.trim()) body.readerUsername = readerUsername.trim()
      if (readerPassword) body.readerPassword = readerPassword
      if (mqttHost.trim()) body.mqttHost = mqttHost.trim()

      const result = await postSetup(body)
      onSetupDone(result?.rosterCount ?? 0)
    } catch (err) {
      setSetupError(err.status === 401 ? 'Nieprawidłowy PIN' : err.message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="min-h-dvh flex items-center justify-center p-4">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-md bg-apex-surface border border-apex-border p-6 flex flex-col gap-5"
      >
        <div>
          <h1 className="font-display text-3xl font-extrabold text-apex-text-bright uppercase tracking-wide">
            Punkt kontrolny
          </h1>
          <p className="text-apex-muted text-sm mt-1">Konfiguracja czytnika LeszyRun</p>
        </div>

        {setupError && <Banner tone="red">{setupError}</Banner>}
        {eventsError && <Banner tone="red">Nie udało się pobrać wydarzeń: {eventsError}</Banner>}

        <Field label="PIN wydarzenia">
          <input
            className={`${inputClass} font-mono text-2xl tracking-[0.3em] text-center`}
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={6}
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
            placeholder="••••••"
            autoComplete="off"
          />
        </Field>

        <Field label="Wydarzenie">
          <select
            className={inputClass}
            value={eventId}
            onChange={(e) => setEventId(e.target.value)}
          >
            <option value="">— wybierz wydarzenie —</option>
            {events.map((ev) => (
              <option key={ev.id} value={ev.id}>
                {ev.name} ({ev.date})
              </option>
            ))}
          </select>
        </Field>

        <Field label="Punkt kontrolny">
          <select
            className={inputClass}
            value={checkpointId}
            onChange={(e) => setCheckpointId(e.target.value)}
            disabled={!eventId}
          >
            <option value="">— wybierz punkt —</option>
            {checkpoints.map((cp) => (
              <option key={cp.id} value={cp.id}>
                {cp.name}
                {cp.km_marker != null ? ` · km ${cp.km_marker}` : ''}
              </option>
            ))}
          </select>
          {checkpointsError && (
            <span className="text-apex-red text-xs">Nie udało się pobrać punktów: {checkpointsError}</span>
          )}
        </Field>

        <Field label="Adres czytnika (IP lub nazwa .local)">
          <input
            className={inputClass}
            value={readerIp}
            onChange={(e) => setReaderIp(e.target.value)}
            placeholder="impinj-XX-XX-XX.local"
            autoComplete="off"
            disabled={noReader}
          />
        </Field>

        <div>
          <button
            type="button"
            onClick={() => setAdvancedOpen((v) => !v)}
            className="text-xs uppercase tracking-[0.12em] text-apex-muted hover:text-apex-text-bright cursor-pointer"
          >
            {advancedOpen ? '▾' : '▸'} Ustawienia zaawansowane
          </button>
          {advancedOpen && (
            <div className="mt-3 flex flex-col gap-3 border-l-2 border-apex-border-mid pl-3">
              <label className="flex items-center gap-2 text-sm text-apex-text cursor-pointer">
                <input
                  type="checkbox"
                  checked={noReader}
                  onChange={(e) => setNoReader(e.target.checked)}
                />
                Tryb testowy bez czytnika (symulacja)
              </label>
              <Field label="Login czytnika (domyślnie root)">
                <input
                  className={inputClass}
                  value={readerUsername}
                  onChange={(e) => setReaderUsername(e.target.value)}
                  autoComplete="off"
                />
              </Field>
              <Field label="Hasło czytnika">
                <input
                  className={inputClass}
                  type="password"
                  value={readerPassword}
                  onChange={(e) => setReaderPassword(e.target.value)}
                  autoComplete="new-password"
                />
              </Field>
              <Field label="Adres MQTT (nadpisanie auto-wykrywania)">
                <input
                  className={inputClass}
                  value={mqttHost}
                  onChange={(e) => setMqttHost(e.target.value)}
                  placeholder="np. 192.168.1.50"
                  autoComplete="off"
                />
              </Field>
            </div>
          )}
        </div>

        <Button type="submit" disabled={!canSubmit}>
          {submitting ? 'Zapisywanie…' : 'Zapisz i pobierz listę'}
        </Button>
      </form>
    </div>
  )
}

// ---- Status dashboard ----------------------------------------------------

function Tile({ label, value, tone, sub }) {
  return (
    <div className="border border-apex-border bg-apex-surface-2 p-4 flex flex-col gap-1">
      <span className="text-xs uppercase tracking-[0.12em] text-apex-muted">{label}</span>
      <span className={`font-mono text-3xl font-semibold ${tone ? TONE_TEXT[tone] : 'text-apex-text-bright'}`}>
        {value}
      </span>
      {sub && <span className="text-xs text-apex-muted">{sub}</span>}
    </div>
  )
}

function UnknownTagsPanel({ unknown }) {
  const [open, setOpen] = useState(false)
  if (!unknown || unknown.length === 0) {
    return (
      <div className="border border-apex-border bg-apex-surface-2 p-4 flex flex-col gap-1">
        <span className="text-xs uppercase tracking-[0.12em] text-apex-muted">Nieznane tagi</span>
        <span className="font-mono text-3xl font-semibold text-apex-text-bright">0</span>
      </div>
    )
  }
  return (
    <div className="border border-apex-border bg-apex-surface-2 p-4 flex flex-col gap-2 sm:col-span-2">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center justify-between cursor-pointer text-left"
      >
        <span className="text-xs uppercase tracking-[0.12em] text-apex-muted">Nieznane tagi</span>
        <span className="font-mono text-3xl font-semibold text-apex-yellow">{unknown.length}</span>
      </button>
      {open && (
        <ul className="mt-2 max-h-48 overflow-y-auto flex flex-col gap-1 border-t border-apex-border pt-2">
          {unknown.map((u) => (
            <li key={u.epc} className="flex justify-between font-mono text-xs text-apex-text">
              <span className="truncate">{u.epc}</span>
              <span className="text-apex-muted shrink-0 ml-3">{formatAge(u.lastSeenAt)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function ReaderStatusRow() {
  const [status, setStatus] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    async function poll() {
      try {
        const data = await getReaderStatus()
        if (!cancelled) {
          setStatus(data)
          setError(null)
        }
      } catch (err) {
        if (!cancelled) setError(err.message ?? 'Czytnik niedostępny')
      }
    }
    poll()
    const id = setInterval(poll, READER_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [])

  if (error) {
    return <Banner tone="red">CZYTNIK NIEDOSTĘPNY — {error}</Banner>
  }
  return (
    <div className="flex items-center gap-2 text-sm text-apex-muted">
      <span className="inline-block h-2.5 w-2.5 rounded-full bg-apex-green" />
      Czytnik połączony{status?.hostname ? ` (${status.hostname})` : ''}
    </div>
  )
}

function SimulatedReaderBadge() {
  return (
    <div className="flex items-center gap-2 text-sm text-apex-cyan border border-apex-cyan/50 bg-apex-cyan/10 px-3 py-1.5">
      <span className="inline-block h-2.5 w-2.5 rounded-full bg-apex-cyan" />
      TRYB TESTOWY — BEZ CZYTNIKA
    </div>
  )
}

function StartStopControls({ state, onAfterAction, setBanner }) {
  const [busy, setBusy] = useState(false)
  const [needsOverride, setNeedsOverride] = useState(false)
  const [error, setError] = useState(null)
  const [resetArmed, setResetArmed] = useState(false)
  const resetTimer = useRef(null)

  async function start(overrideClock = false) {
    setBusy(true)
    setError(null)
    try {
      await postStart(overrideClock ? { overrideClock: true } : undefined)
      setNeedsOverride(false)
      await onAfterAction()
    } catch (err) {
      if (err.status === 423) {
        setNeedsOverride(true)
      } else {
        setError(err.message)
      }
    } finally {
      setBusy(false)
    }
  }

  async function stop() {
    setBusy(true)
    setError(null)
    try {
      await postStop()
      await onAfterAction()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  function handleResetClick() {
    if (!resetArmed) {
      setResetArmed(true)
      resetTimer.current = setTimeout(() => setResetArmed(false), 5000)
      return
    }
    clearTimeout(resetTimer.current)
    setResetArmed(false)
    setBusy(true)
    postReset()
      .then(() => onAfterAction())
      .catch((err) => setError(err.message))
      .finally(() => setBusy(false))
  }

  useEffect(() => () => clearTimeout(resetTimer.current), [])

  return (
    <div className="flex flex-col gap-3">
      {error && <Banner tone="red" onDismiss={() => setError(null)}>{error}</Banner>}
      {needsOverride && (
        <Banner tone="yellow">
          Zegar czytnika nie jest zsynchronizowany. Start jest zablokowany, chyba że wymusisz start ręcznie.
        </Banner>
      )}
      <div className="flex flex-wrap gap-3">
        {state.running ? (
          <Button variant="primary" disabled={busy} onClick={stop}>
            Stop
          </Button>
        ) : (
          <Button variant="primary" disabled={busy} onClick={() => start(false)}>
            Start
          </Button>
        )}
        {needsOverride && !state.running && (
          <Button variant="danger" disabled={busy} onClick={() => start(true)}>
            Wymuś start (zegar niezsynchronizowany)
          </Button>
        )}
        <Button
          variant="danger"
          disabled={busy}
          onClick={handleResetClick}
          className={resetArmed ? 'animate-pulse' : ''}
        >
          {resetArmed ? 'Potwierdź zakończenie' : 'Zakończ i wyczyść'}
        </Button>
      </div>
    </div>
  )
}

function Dashboard({ state, onAfterAction }) {
  const session = state.session
  const uploadColor = uploadTone(state.upload)

  return (
    <div className="min-h-dvh p-4 sm:p-6 flex flex-col gap-5 max-w-3xl mx-auto">
      <header className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="font-display text-2xl sm:text-3xl font-extrabold text-apex-text-bright uppercase tracking-wide">
            {session?.eventName ?? 'Wydarzenie'}
          </h1>
          <p className="text-apex-muted text-sm">
            {session?.checkpointName ?? 'Punkt kontrolny'}
          </p>
        </div>
        <span
          className={`font-display font-extrabold uppercase tracking-widest border px-3 py-1.5 ${
            state.running
              ? 'border-apex-cyan text-apex-cyan'
              : 'border-apex-yellow text-apex-yellow'
          }`}
        >
          {state.running ? 'Running' : 'Stopped'}
        </span>
      </header>

      {state.clock?.synced === false && (
        <Banner tone="yellow">
          Zegar czytnika nie jest zsynchronizowany{state.clock.source ? ` (źródło: ${state.clock.source})` : ''}.
        </Banner>
      )}

      {state.noReader ? <SimulatedReaderBadge /> : <ReaderStatusRow />}

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <Tile label="Odczyty" value={state.reads?.total ?? 0} sub={formatAge(state.reads?.lastAt)} />
        <Tile label="Potwierdzone" value={state.confirmedCount ?? 0} />
        <Tile label="W zasięgu" value={state.inRangeCount ?? 0} />
        <Tile
          label="Kolejka"
          value={`${state.counts?.pending ?? 0} / ${state.counts?.total ?? 0}`}
          sub="oczekujące / razem"
        />
        <Tile
          label="Ostatni upload"
          value={formatAge(state.upload?.lastUploadAt)}
          tone={uploadColor}
          sub={state.upload?.lastError ?? undefined}
        />
        <UnknownTagsPanel unknown={state.unknown} />
      </div>

      <StartStopControls state={state} onAfterAction={onAfterAction} />
    </div>
  )
}

// ---- root app -------------------------------------------------------------

export default function App() {
  const [state, setState] = useState(null)
  const [pollError, setPollError] = useState(null)
  const [toast, setToast] = useState(null)

  async function refresh() {
    try {
      const data = await getState()
      setState(data)
      setPollError(null)
    } catch (err) {
      setPollError(err.message)
    }
  }

  useEffect(() => {
    refresh()
    const id = setInterval(refresh, STATE_POLL_MS)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    if (!toast) return
    const id = setTimeout(() => setToast(null), 5000)
    return () => clearTimeout(id)
  }, [toast])

  async function handleSetupDone(rosterCount) {
    setToast(`Pobrano ${rosterCount} tagów`)
    await refresh()
  }

  if (!state) {
    return (
      <div className="min-h-dvh flex items-center justify-center text-apex-muted">
        {pollError ? `Błąd połączenia z agentem: ${pollError}` : 'Ładowanie…'}
      </div>
    )
  }

  return (
    <>
      {toast && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50 w-full max-w-md px-4">
          <Banner tone="green" onDismiss={() => setToast(null)}>
            {toast}
          </Banner>
        </div>
      )}
      {state.session ? (
        <Dashboard state={state} onAfterAction={refresh} />
      ) : (
        <SetupWizard onSetupDone={handleSetupDone} />
      )}
    </>
  )
}
