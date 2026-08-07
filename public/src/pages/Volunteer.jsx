import { useState, useEffect } from 'react'
import { useEvent } from '../hooks/useEvent.js'
import { supabase } from '../lib/supabase.js'
import useSeo from '../hooks/useSeo.js'

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
  const [checkpoint, setCheckpoint] = useState(null)
  const [loadError, setLoadError] = useState(null)
  const [bib, setBib] = useState('')
  const [flash, setFlash] = useState(null)
  const [sending, setSending] = useState(false)
  const [eventEnded, setEventEnded] = useState(false)

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

  const handleSubmit = async () => {
    const n = parseInt(bib, 10)
    if (!n || n < 1) return
    if (sending) return

    setSending(true)
    setBib('')

    // .select() is what makes the outcome observable at all. The
    // trg_checkpoint_obs_priority BEFORE INSERT trigger returns NULL when a row
    // for (checkpoint_id, bib_number) already exists — the insert is dropped and
    // PostgREST reports NO error. Without asking for the inserted rows back, a
    // discarded entry is indistinguishable from a saved one, which is exactly how
    // a volunteer ends up typing a bib, seeing "Wysłano", and nothing happening.
    const { data, error } = await supabase
      .from('checkpoint_observations')
      .insert({
        checkpoint_id: checkpointId,
        bib_number: n,
        observed_at: new Date().toISOString(),
        source: 'manual',
      })
      .select('id')

    setSending(false)

    if (error) {
      // Network drop, RLS, constraint — the volunteer must see it and be able to
      // retry, so put the bib back rather than swallowing it into a console log.
      console.error('[volunteer] insert failed', error)
      setBib(String(n))
      setFlash({ kind: 'error', bib: n })
      return
    }

    if (!data || data.length === 0) {
      // Trigger dropped it: this bib is already recorded at this checkpoint
      // (usually by the RFID reader, which wins by design). Not a failure —
      // the pass IS on record — so say so plainly instead of implying loss.
      setFlash({ kind: 'duplicate', bib: n })
      setTimeout(() => setFlash(null), 2500)
      return
    }

    setFlash({ kind: 'sent', bib: n })
    setTimeout(() => setFlash(null), 1200)
  }

  if (eventLoading) return <LoadingScreen />
  if (eventError) return <ErrorScreen message={eventError} />
  if (loadError) return <ErrorScreen message={loadError} />
  if (!checkpoint) return <LoadingScreen />
  if (eventEnded) return <EventEndedScreen eventName={event?.name} />

  // Blocked while an insert is in flight so a double-tap can't fire twice.
  const canSend = bib.length > 0 && parseInt(bib, 10) >= 1 && !sending

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

      {/* Flash — three distinct outcomes. "Wysłano" used to show unconditionally,
          before the insert had even resolved, so a dropped or failed entry looked
          identical to a saved one. */}
      {flash?.kind === 'sent' && (
        <div className="bg-apex-yellow/10 border border-apex-yellow/30 text-apex-yellow px-4 py-2.5 text-center text-sm mb-4 tracking-wide">
          Zapisano {flash.bib}
        </div>
      )}
      {flash?.kind === 'duplicate' && (
        <div className="bg-apex-cyan/10 border border-apex-cyan/40 text-apex-cyan px-4 py-2.5 text-center text-sm mb-4 tracking-wide">
          Numer {flash.bib} jest już zapisany na tym punkcie — nie trzeba wpisywać ponownie.
        </div>
      )}
      {flash?.kind === 'error' && (
        <div className="bg-apex-red/10 border border-apex-red/50 text-apex-red px-4 py-2.5 text-center text-sm mb-4 tracking-wide">
          Nie udało się zapisać {flash.bib} — numer wrócił na ekran, spróbuj ponownie.
        </div>
      )}

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
    </div>
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
