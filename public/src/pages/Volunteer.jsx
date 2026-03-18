import { useState, useEffect } from 'react'
import { useEvent } from '../hooks/useEvent.js'
import { supabase } from '../lib/supabase.js'

const NUMPAD = [
  ['1', '2', '3'],
  ['4', '5', '6'],
  ['7', '8', '9'],
  ['WYCZYSC', '0', '\u232B'],
]

export default function Volunteer() {
  const { event, loading: eventLoading, error: eventError } = useEvent()
  const checkpointId = new URLSearchParams(window.location.search).get('checkpoint')
  const [checkpoint, setCheckpoint] = useState(null)
  const [loadError, setLoadError] = useState(null)
  const [bib, setBib] = useState('')
  const [flash, setFlash] = useState(null)

  useEffect(() => {
    if (!checkpointId) { setLoadError('Brak ID punktu kontrolnego w URL.'); return }

    supabase.from('checkpoints').select('id, name, km_marker').eq('id', checkpointId).single()
      .then(({ data, error }) => {
        if (error || !data) { setLoadError('Nie znaleziono punktu kontrolnego.'); return }
        setCheckpoint(data)
      })
  }, [checkpointId])

  const handleKey = (key) => {
    if (key === 'WYCZYSC') { setBib(''); return }
    if (key === '\u232B') { setBib(b => b.slice(0, -1)); return }
    if (bib.length >= 4) return
    setBib(b => b + key)
  }

  const handleSubmit = () => {
    const n = parseInt(bib, 10)
    if (!n || n < 1) return

    supabase.from('checkpoint_observations').insert({
      checkpoint_id: checkpointId,
      bib_number: n,
      observed_at: new Date().toISOString(),
    })
      .then(({ error }) => { if (error) console.error('[volunteer] upsert error', error) })

    setBib('')
    setFlash('sent')
    setTimeout(() => setFlash(null), 1200)
  }

  if (eventLoading) return <LoadingScreen />
  if (eventError) return <ErrorScreen message={eventError} />
  if (loadError) return <ErrorScreen message={loadError} />
  if (!checkpoint) return <LoadingScreen />

  const canSend = bib.length > 0 && parseInt(bib, 10) >= 1

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100dvh', padding: '20px 16px', userSelect: 'none' }}>
      {/* Header */}
      <div style={{ marginBottom: 20, textAlign: 'center' }}>
        <div style={{ fontSize: 13, textTransform: 'uppercase', letterSpacing: '0.15em', color: '#545268', marginBottom: 6 }}>
          Punkt kontrolny
        </div>
        <div style={{ fontSize: 26, fontWeight: 700, color: '#C4C2D8', lineHeight: 1.2 }}>
          {checkpoint.name}
          {checkpoint.km_marker && <span style={{ color: '#545268', fontSize: 18 }}> \u00b7 km {checkpoint.km_marker}</span>}
        </div>
        {event && (
          <div style={{ fontSize: 12, color: '#545268', marginTop: 4 }}>{event.name}</div>
        )}
      </div>

      {/* Flash */}
      {flash === 'sent' && (
        <div style={{ background: '#1a2e0a', border: '1px solid #4a7c10', color: '#a0d040',
          padding: '10px 16px', textAlign: 'center', fontSize: 14, marginBottom: 16, letterSpacing: '0.1em' }}>
          Wyslano
        </div>
      )}

      {/* Bib display */}
      <div style={{ textAlign: 'center', marginBottom: 16 }}>
        <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.15em', color: '#545268', marginBottom: 8 }}>
          Numer startowy
        </div>
        <div style={{
          fontSize: 80, fontWeight: 700, fontVariantNumeric: 'tabular-nums', lineHeight: 1,
          color: bib ? '#C4C2D8' : '#2a2a3a',
          borderBottom: '3px solid #BBDD00', paddingBottom: 8,
          minHeight: 96,
        }}>
          {bib || '\u2013'}
        </div>
      </div>

      {/* Numpad */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginBottom: 12 }}>
        {NUMPAD.flat().map((key) => {
          const isAction = key === 'WYCZYSC' || key === '\u232B'
          return (
            <button
              key={key}
              onClick={() => handleKey(key)}
              style={{
                padding: '18px 0', fontSize: isAction ? 16 : 26, fontWeight: 700,
                background: isAction ? '#1C1C2A' : '#12121e',
                color: isAction ? '#545268' : '#C4C2D8',
                border: '1px solid #2a2a3a', cursor: 'pointer',
                fontVariantNumeric: 'tabular-nums',
                WebkitTapHighlightColor: 'transparent',
              }}
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
        style={{
          width: '100%', padding: '18px', fontSize: 18, fontWeight: 700,
          textTransform: 'uppercase', letterSpacing: '0.1em',
          background: canSend ? '#BBDD00' : '#1C1C2A',
          color: canSend ? '#0A0A10' : '#545268',
          border: 'none', cursor: canSend ? 'pointer' : 'default',
          transition: 'all 0.15s',
          WebkitTapHighlightColor: 'transparent',
        }}
      >
        Wyslij
      </button>
    </div>
  )
}

function LoadingScreen() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100dvh', color: '#545268' }}>
      Ladowanie...
    </div>
  )
}

function ErrorScreen({ message }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100dvh',
      flexDirection: 'column', gap: 12, padding: 24, textAlign: 'center' }}>
      <div style={{ fontSize: 32 }}>!</div>
      <div style={{ color: '#E53030', fontSize: 16 }}>{message}</div>
    </div>
  )
}
