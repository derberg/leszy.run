import { useState, useEffect, useRef, useCallback } from 'react'
import { useEvent } from '../hooks/useEvent.js'
import { supabase } from '../lib/supabase.js'
import useSeo from '../hooks/useSeo.js'
import { useCheckpointOutbox } from '../hooks/useCheckpointOutbox.js'
import { FUNCTIONS_BASE } from '../lib/auth.js'
import { checkpointWrite, pinCheckOutcome, readPin, savePin, clearPin } from '../lib/checkpointWrite.js'

const NUMPAD = [
  ['1', '2', '3'],
  ['4', '5', '6'],
  ['7', '8', '9'],
  ['WYCZYSC', '0', '⌫'],
]

export default function Volunteer() {
  useSeo({ title: 'Wolontariat', noindex: true })
  const { event, loading: eventLoading, error: eventError } = useEvent()
  const checkpointId = new URLSearchParams(window.location.search).get('checkpoint')
  // Reading only; moving the PIN to storage and off the address bar happens
  // in an effect, so a second StrictMode run of this initialiser loses nothing.
  const [pin, setPin] = useState(() => (checkpointId ? pinFromUrlOrStorage(checkpointId) : null))
  // 'checking' until the stored PIN is confirmed, 'needed' shows the PIN pad.
  const [pinState, setPinState] = useState(pin ? 'checking' : 'needed')
  const [checkpoint, setCheckpoint] = useState(null)
  const [loadError, setLoadError] = useState(null)
  const [bib, setBib] = useState('')
  const [flash, setFlash] = useState(null)
  const flashTimer = useRef(null)
  const [eventEnded, setEventEnded] = useState(false)
  const askForPin = useCallback(() => {
    clearPin(checkpointId)
    setPin(null)
    setPinState('needed')
  }, [checkpointId])
  // The queue only sends with a PIN the server has accepted (or one it could
  // not check for lack of signal). A refused PIN brings the PIN pad back and
  // keeps the entries waiting, instead of failing them one by one.
  const outbox = useCheckpointOutbox(checkpointId, pinState === 'ok' ? pin : null, askForPin)

  useEffect(() => {
    if (checkpointId) movePinOffUrl(checkpointId)
  }, [checkpointId])

  // A stored PIN is checked once on load. No answer (no signal at the
  // checkpoint) keeps it: entries queue on the phone and go out when the
  // signal returns. Only a definite "wrong PIN" asks again.
  useEffect(() => {
    if (!checkpointId || !pin || pinState !== 'checking') return
    let cancelled = false
    checkpointWrite(FUNCTIONS_BASE, { action: 'verify', checkpoint_id: checkpointId, pin }).then(res => {
      if (cancelled) return
      if (pinCheckOutcome(res) === 'invalid') {
        askForPin()
      } else {
        setPinState('ok')
      }
    })
    return () => { cancelled = true }
  }, [checkpointId, pin, pinState, askForPin])

  useEffect(() => {
    if (!checkpointId) { setLoadError('Brak ID punktu kontrolnego w URL.'); return }

    supabase.from('checkpoints').select('id, name, km_marker, event_id').eq('id', checkpointId).single()
      .then(async ({ data, error }) => {
        if (error || !data) { setLoadError('Nie znaleziono punktu kontrolnego.'); return }
        setCheckpoint(data)

        // Event ended = at least one race ran, and none are still active/pending
        const { data: runs } = await supabase
          .from('race_runs')
          .select('status, category_id, categories!inner(event_id)')
          .eq('categories.event_id', data.event_id)

        const hasAnyRun = runs && runs.length > 0
        const hasFinished = hasAnyRun && runs.some(r => r.status === 'finished' || r.status === 'cancelled')
        const hasActive = hasAnyRun && runs.some(r => r.status === 'active' || r.status === 'pending')

        if (hasFinished && !hasActive) {
          setEventEnded(true)
        }
      })
  }, [checkpointId])

  const handleKey = (key) => {
    if (key === 'WYCZYSC') { setBib(''); return }
    if (key === '⌫') { setBib(b => b.slice(0, -1)); return }
    if (bib.length >= 4) return
    setBib(b => b + key)
  }

  // Sending happens in the background (useCheckpointOutbox). The tap only
  // stores the entry on the phone, so a weak signal never holds up the next
  // runner. The button used to stay disabled until Supabase answered, which on
  // a bad connection took tens of seconds, and a failure then wrote the old
  // bib back over whatever the volunteer had typed since.
  const handleSubmit = () => {
    const n = parseInt(bib, 10)
    if (!n || n < 1 || !outbox.ready) return
    outbox.add(n)
    setBib('')
    clearTimeout(flashTimer.current)
    setFlash({ bib: n })
    flashTimer.current = setTimeout(() => setFlash(null), 1200)
  }

  useEffect(() => () => clearTimeout(flashTimer.current), [])

  if (eventLoading) return <LoadingScreen />
  if (eventError) return <ErrorScreen message={eventError} />
  if (loadError) return <ErrorScreen message={loadError} />
  if (!checkpoint) return <LoadingScreen />
  if (pinState === 'needed') {
    return (
      <PinScreen
        checkpoint={checkpoint}
        onAccepted={(value) => {
          savePin(checkpointId, value)
          setPin(value)
          setPinState('ok')
        }}
        verify={(value) => checkpointWrite(FUNCTIONS_BASE, { action: 'verify', checkpoint_id: checkpointId, pin: value })}
      />
    )
  }
  // Keep the keypad while anything is unsent or rejected, so the queue stays
  // visible and keeps draining after the race is closed.
  if (eventEnded && outbox.pending === 0 && outbox.failed === 0) {
    return <EventEndedScreen eventName={event?.name} />
  }

  const canSend = bib.length > 0 && parseInt(bib, 10) >= 1 && outbox.ready

  return (
    <div className="flex flex-col min-h-dvh p-5 select-none bg-apex-bg">
      {/* Header */}
      <div className="mb-5 text-center">
        <div className="text-[13px] uppercase tracking-[0.15em] text-apex-dim mb-1.5">
          Punkt kontrolny
        </div>
        <div className="text-[26px] font-bold text-apex-text-bright leading-tight">
          {checkpoint.name}
          {checkpoint.km_marker && <span className="text-apex-dim text-lg"> · km {checkpoint.km_marker}</span>}
        </div>
        {event && (
          <div className="text-xs text-apex-dim mt-1">{event.name}</div>
        )}
      </div>

      {/* "Przyjęto" means stored on this phone, not yet on the server. The
          list below says which entries the server has confirmed. */}
      <div className="min-h-[42px] mb-4">
        {flash && (
          <div className="bg-apex-yellow/10 border border-apex-yellow/30 text-apex-yellow px-4 py-2.5 text-center text-sm tracking-wide">
            Przyjęto {flash.bib}
          </div>
        )}
      </div>

      {/* Bib display */}
      <div className="text-center mb-4">
        <div className="text-[11px] uppercase tracking-[0.15em] text-apex-dim mb-2">
          Numer startowy
        </div>
        <div className={`text-[80px] font-bold tabular-nums leading-none border-b-[3px] border-apex-yellow pb-2 min-h-[96px] ${bib ? 'text-apex-text-bright' : 'text-apex-border-mid'}`}>
          {bib || '–'}
        </div>
      </div>

      {/* Numpad */}
      <div className="grid grid-cols-3 gap-2 mb-3">
        {NUMPAD.flat().map((key) => {
          const isAction = key === 'WYCZYSC' || key === '⌫'
          return (
            <button
              key={key}
              onClick={() => handleKey(key)}
              className={`py-[18px] font-bold border border-apex-border-mid cursor-pointer tabular-nums
                ${isAction
                  ? 'text-base bg-apex-surface-3 text-apex-dim'
                  : 'text-[26px] bg-apex-surface-2 text-apex-text-bright'
                }`}
              style={{ WebkitTapHighlightColor: 'transparent' }}
            >
              {key}
            </button>
          )
        })}
      </div>

      {/* Send */}
      <button
        onClick={handleSubmit}
        disabled={!canSend}
        className={`w-full py-[18px] text-lg font-bold uppercase tracking-wide border-none transition-all
          ${canSend
            ? 'bg-apex-yellow text-apex-ink cursor-pointer'
            : 'bg-apex-surface-3 text-apex-dim cursor-default'
          }`}
        style={{ WebkitTapHighlightColor: 'transparent' }}
      >
        Wyslij
      </button>

      <QueueStatus outbox={outbox} />
      <RecentEntries outbox={outbox} />
    </div>
  )
}

// The organiser's link carries the PIN (&pin=). It is moved to this phone's
// storage and taken out of the address bar, so it is not left in the history
// or in a shared screenshot.
function pinFromUrlOrStorage(checkpointId) {
  return new URLSearchParams(window.location.search).get('pin') || readPin(checkpointId)
}

function movePinOffUrl(checkpointId) {
  const url = new URL(window.location.href)
  const fromUrl = url.searchParams.get('pin')
  if (!fromUrl) return
  savePin(checkpointId, fromUrl)
  url.searchParams.delete('pin')
  window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash)
}

// New PINs are 10 digits; 6-digit ones generated before 2026-10-25 still work.
const PIN_MIN = 6
const PIN_MAX = 12

function PinScreen({ checkpoint, verify, onAccepted }) {
  const [value, setValue] = useState('')
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  const press = (key) => {
    setError(null)
    if (key === 'WYCZYSC') { setValue(''); return }
    if (key === '⌫') { setValue(v => v.slice(0, -1)); return }
    if (value.length >= PIN_MAX) return
    setValue(v => v + key)
  }

  const submit = async () => {
    if (value.length < PIN_MIN || busy) return
    setBusy(true)
    const outcome = pinCheckOutcome(await verify(value))
    setBusy(false)
    if (outcome === 'invalid') { setError('Nieprawidłowy PIN.'); setValue(''); return }
    if (outcome === 'locked') { setError('Zbyt wiele prób. Spróbuj ponownie za 15 minut.'); return }
    // 'ok', or no signal: accept it, the entries wait on the phone.
    onAccepted(value)
  }

  return (
    <div className="flex flex-col min-h-dvh p-5 select-none bg-apex-bg">
      <div className="mb-5 text-center">
        <div className="text-[13px] uppercase tracking-[0.15em] text-apex-dim mb-1.5">Punkt kontrolny</div>
        <div className="text-[26px] font-bold text-apex-text-bright leading-tight">{checkpoint.name}</div>
      </div>
      <div className="text-center mb-4">
        <div className="text-[11px] uppercase tracking-[0.15em] text-apex-dim mb-2">PIN od organizatora</div>
        <div className={`text-[40px] font-bold tabular-nums tracking-[0.15em] leading-none border-b-[3px] border-apex-yellow pb-2 min-h-[56px] break-all ${value ? 'text-apex-text-bright' : 'text-apex-border-mid'}`}>
          {value ? '•'.repeat(value.length) : '––––––––––'}
        </div>
      </div>
      <div className="min-h-[42px] mb-2">
        {error && (
          <div className="border border-apex-red/50 bg-apex-red/10 text-apex-red px-3 py-2 text-center text-sm">{error}</div>
        )}
      </div>
      <div className="grid grid-cols-3 gap-2 mb-3">
        {NUMPAD.flat().map((key) => {
          const isAction = key === 'WYCZYSC' || key === '⌫'
          return (
            <button
              key={key}
              onClick={() => press(key)}
              className={`py-[18px] font-bold border border-apex-border-mid cursor-pointer tabular-nums
                ${isAction ? 'text-base bg-apex-surface-3 text-apex-dim' : 'text-[26px] bg-apex-surface-2 text-apex-text-bright'}`}
              style={{ WebkitTapHighlightColor: 'transparent' }}
            >
              {key}
            </button>
          )
        })}
      </div>
      <button
        onClick={submit}
        disabled={value.length < PIN_MIN || busy}
        className={`w-full py-[18px] text-lg font-bold uppercase tracking-wide border-none transition-all
          ${value.length >= PIN_MIN && !busy ? 'bg-apex-yellow text-apex-ink cursor-pointer' : 'bg-apex-surface-3 text-apex-dim cursor-default'}`}
        style={{ WebkitTapHighlightColor: 'transparent' }}
      >
        {busy ? 'Sprawdzanie…' : 'Dalej'}
      </button>
    </div>
  )
}

function QueueStatus({ outbox }) {
  const { pending, failed, reachable, persistent } = outbox
  return (
    <div className="mt-4 flex flex-col gap-2 text-sm text-center">
      {!persistent && (
        <div className="border border-apex-red/50 text-apex-red px-3 py-2">
          Ten telefon nie zapisuje numerów w pamięci. Nie zamykaj strony, dopóki wszystko nie zostanie wysłane.
        </div>
      )}
      {failed > 0 && (
        <div className="border border-apex-red/50 bg-apex-red/10 text-apex-red px-3 py-2">
          Serwer odrzucił {failed} {numerWord(failed)}. Spróbuj ponownie albo podaj je koordynatorowi.
        </div>
      )}
      {pending > 0 && !reachable && (
        <div className="border border-apex-yellow/40 text-apex-yellow px-3 py-2">
          Brak połączenia. Czeka na wysłanie: {pending}. Wyślą się same, gdy wróci zasięg. Możesz dalej wpisywać.
        </div>
      )}
      {pending > 0 && reachable && (
        <div className="text-apex-muted">Wysyłanie: {pending}</div>
      )}
      {pending === 0 && failed === 0 && outbox.entries.length > 0 && (
        <div className="text-apex-dim">Wszystko wysłane</div>
      )}
    </div>
  )
}

function numerWord(n) {
  if (n === 1) return 'numer'
  const tens = n % 100
  if (n % 10 >= 2 && n % 10 <= 4 && (tens < 12 || tens > 14)) return 'numery'
  return 'numerów'
}

const STATUS = {
  pending: { label: 'czeka', cls: 'text-apex-muted' },
  sending: { label: 'wysyłanie…', cls: 'text-apex-muted' },
  saved: { label: 'zapisano', cls: 'text-apex-yellow' },
  duplicate: { label: 'już zapisany', cls: 'text-apex-cyan' },
  failed: { label: 'odrzucony', cls: 'text-apex-red' },
}

const timeFmt = new Intl.DateTimeFormat('pl-PL', { hour: '2-digit', minute: '2-digit', second: '2-digit' })

function RecentEntries({ outbox }) {
  // Cancelling takes two taps: one stray tap must not drop a runner's pass.
  const [confirmId, setConfirmId] = useState(null)
  const rows = outbox.entries.slice(0, 8)
  if (rows.length === 0) return null
  return (
    <ul className="mt-3 border-t border-apex-border-mid">
      {rows.map(e => {
        const st = STATUS[e.status] || STATUS.pending
        return (
          <li key={e.id} className="flex items-center gap-3 py-2 border-b border-apex-border text-sm">
            <span className="font-mono text-apex-dim w-[70px]">{timeFmt.format(new Date(e.observedAt))}</span>
            <span className="font-mono font-bold text-apex-text-bright text-lg w-[56px] text-right">{e.bib}</span>
            <span className={`flex-1 ${st.cls}`}>{st.label}</span>
            {e.status === 'pending' && !e.attempts && (
              <button
                onClick={() => {
                  if (confirmId !== e.id) { setConfirmId(e.id); return }
                  outbox.cancel(e.id)
                  setConfirmId(null)
                }}
                className={`px-3 py-1 border text-xs uppercase ${confirmId === e.id ? 'border-apex-red/50 text-apex-red' : 'border-apex-border-mid text-apex-dim'}`}
                style={{ WebkitTapHighlightColor: 'transparent' }}
              >
                {confirmId === e.id ? 'Usunąć?' : 'Cofnij'}
              </button>
            )}
            {e.status === 'failed' && (
              <button
                onClick={() => outbox.retry(e.id)}
                className="px-3 py-1 border border-apex-red/50 text-apex-red text-xs uppercase"
                style={{ WebkitTapHighlightColor: 'transparent' }}
              >
                Ponów
              </button>
            )}
          </li>
        )
      })}
    </ul>
  )
}

function LoadingScreen() {
  return (
    <div className="flex items-center justify-center min-h-dvh text-apex-dim bg-apex-bg">
      Ładowanie...
    </div>
  )
}

function ErrorScreen({ message }) {
  return (
    <div className="flex items-center justify-center min-h-dvh flex-col gap-3 p-6 text-center bg-apex-bg">
      <div className="text-[32px]">!</div>
      <div className="text-apex-red text-base">{message}</div>
    </div>
  )
}

function EventEndedScreen({ eventName }) {
  return (
    <div className="flex items-center justify-center min-h-dvh flex-col gap-4 p-8 text-center bg-apex-bg">
      <div className="text-[64px]">🏁</div>
      <div className="text-apex-text-bright text-2xl font-bold">Zawody zakończone</div>
      {eventName && <div className="text-apex-yellow text-base">{eventName}</div>}
      <div className="text-apex-text text-base max-w-md leading-relaxed mt-2">
        Dziękujemy za pomoc w organizacji!<br/>
        Bez Ciebie zawody by się nie odbyły.
      </div>
      <div className="text-apex-dim text-sm mt-4">
        Wyślij ten punkt dalej – pozdrowienia od ekipy LeszyRun 💚
      </div>
    </div>
  )
}
