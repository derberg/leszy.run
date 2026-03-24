import { useState, useEffect, useRef, useCallback } from 'react'
import { useEvent } from '../hooks/useEvent.js'
import { supabase } from '../lib/supabase.js'

const PIN_KEY = 'leszyrun_checkin_pin'

export default function AdminCheckin() {
  const { event, loading: eventLoading, error: eventError } = useEvent()
  const preselectedParticipantId = new URLSearchParams(window.location.search).get('p')
  const [pin, setPin] = useState(() => localStorage.getItem(PIN_KEY) || '')
  const [pinVerified, setPinVerified] = useState(false)
  const [pinError, setPinError] = useState(null)
  const [pinInput, setPinInput] = useState('')
  const [verifying, setVerifying] = useState(false)

  // Check stored pin on load
  useEffect(() => {
    if (!event || !pin) return
    supabase.rpc('verify_checkin_pin', { p_event_id: event.id, p_pin: pin })
      .then(({ data, error }) => {
        if (!error && data === true) setPinVerified(true)
        else { localStorage.removeItem(PIN_KEY); setPin('') }
      })
  }, [event, pin])

  const handlePinSubmit = async (e) => {
    e.preventDefault()
    if (!event || !pinInput.trim()) return
    setVerifying(true)
    setPinError(null)

    const { data, error } = await supabase.rpc('verify_checkin_pin', { p_event_id: event.id, p_pin: pinInput.trim() })
    if (error || data !== true) {
      setPinError('Nieprawidlowy PIN.')
      setVerifying(false)
      return
    }

    localStorage.setItem(PIN_KEY, pinInput.trim())
    setPin(pinInput.trim())
    setPinVerified(true)
    setVerifying(false)
  }

  if (eventLoading) return <div className="flex items-center justify-center min-h-screen text-apex-muted">Ladowanie...</div>
  if (eventError) return <div className="flex items-center justify-center min-h-screen text-apex-red">{eventError}</div>

  if (pinVerified) {
    return <AdminPanel event={event} pin={pin} preselectedParticipantId={preselectedParticipantId} />
  }

  if (!pinVerified) {
    return (
      <div className="min-h-screen bg-apex-bg text-apex-text-bright flex items-center justify-center">
        <form onSubmit={handlePinSubmit} className="max-w-sm w-full px-6">
          <div className="text-center mb-8">
            <div className="font-display text-3xl uppercase tracking-widest mb-2">Odprawa</div>
            <div className="text-apex-muted text-sm">{event.name}</div>
          </div>
          <div className="mb-4">
            <label className="text-xs text-apex-muted uppercase tracking-wider block mb-2">PIN</label>
            <input
              type="password"
              inputMode="numeric"
              maxLength={6}
              value={pinInput}
              onChange={(e) => setPinInput(e.target.value)}
              className="w-full bg-apex-surface border border-apex-border px-4 py-3 text-center text-2xl font-mono tracking-[0.5em] text-apex-text-bright focus:outline-none focus:border-apex-yellow"
              autoFocus
            />
          </div>
          {pinError && <div className="text-apex-red text-sm text-center mb-4">{pinError}</div>}
          <button
            type="submit"
            disabled={verifying || pinInput.length < 4}
            className={`w-full py-3 font-bold uppercase tracking-wider transition-colors ${
              pinInput.length >= 4 && !verifying
                ? 'bg-apex-yellow text-apex-ink hover:bg-apex-yellow-bright'
                : 'bg-apex-surface-2 text-apex-muted cursor-not-allowed'
            }`}
          >
            {verifying ? 'Sprawdzanie...' : 'Zaloguj'}
          </button>
        </form>
      </div>
    )
  }

}

function AdminPanel({ event, pin, preselectedParticipantId }) {
  const [mode, setMode] = useState('search') // 'scan' | 'search'
  const [selectedParticipant, setSelectedParticipant] = useState(null)
  const [flash, setFlash] = useState(null) // { type: 'success' | 'error', message }

  // Load preselected participant from QR link
  useEffect(() => {
    if (!preselectedParticipantId || selectedParticipant) return
    supabase
      .from('participants')
      .select('id, first_name, last_name, bib_number, category_id, birth_date')
      .eq('id', preselectedParticipantId)
      .single()
      .then(async ({ data, error }) => {
        if (error || !data) return
        const { data: cats } = await supabase.from('categories').select('id, name').eq('event_id', event.id)
        const category = (cats || []).find(c => c.id === data.category_id)
        setSelectedParticipant({ ...data, categoryName: category?.name })
      })
  }, [preselectedParticipantId])

  const handleParticipantFound = (participant) => {
    setSelectedParticipant(participant)
  }

  const handleCheckinComplete = (message) => {
    setSelectedParticipant(null)
    setFlash({ type: 'success', message })
    setTimeout(() => setFlash(null), 3000)
  }

  const handleError = (message) => {
    setFlash({ type: 'error', message })
    setTimeout(() => setFlash(null), 3000)
  }

  if (selectedParticipant) {
    return (
      <ParticipantCheckin
        event={event}
        participant={selectedParticipant}
        pin={pin}
        onComplete={handleCheckinComplete}
        onError={handleError}
        onBack={() => setSelectedParticipant(null)}
      />
    )
  }

  return (
    <div className="min-h-screen bg-apex-bg text-apex-text-bright">
      <div className="max-w-lg mx-auto px-6 py-8">
        <div className="text-center mb-6">
          <div className="font-display text-3xl uppercase tracking-widest mb-1">Odprawa</div>
          <div className="text-apex-muted text-sm">{event.name}</div>
        </div>

        {/* Flash */}
        {flash && (
          <div className={`border p-3 text-center text-sm mb-6 ${
            flash.type === 'success'
              ? 'border-green-700 bg-green-900/30 text-green-400'
              : 'border-apex-red bg-apex-red-dim/30 text-apex-red'
          }`}>
            {flash.message}
          </div>
        )}

        {/* Mode toggle */}
        <div className="flex border border-apex-border mb-6">
          <button
            onClick={() => setMode('scan')}
            className={`flex-1 py-3 text-xs font-bold uppercase tracking-wider transition-colors ${
              mode === 'scan' ? 'bg-apex-yellow-bright text-apex-ink' : 'text-apex-muted hover:text-apex-text'
            }`}
          >
            Skanuj QR
          </button>
          <button
            onClick={() => setMode('search')}
            className={`flex-1 py-3 text-xs font-bold uppercase tracking-wider transition-colors border-l border-apex-border ${
              mode === 'search' ? 'bg-apex-yellow-bright text-apex-ink' : 'text-apex-muted hover:text-apex-text'
            }`}
          >
            Szukaj
          </button>
        </div>

        {mode === 'scan' && (
          <QrScanner event={event} onFound={handleParticipantFound} onError={handleError} />
        )}
        {mode === 'search' && (
          <ManualSearch event={event} onFound={handleParticipantFound} />
        )}
      </div>
    </div>
  )
}

function QrScanner({ event, onFound, onError }) {
  const scannerRef = useRef(null)
  const containerRef = useRef(null)

  useEffect(() => {
    let html5Qrcode = null

    import('html5-qrcode').then(({ Html5Qrcode }) => {
      html5Qrcode = new Html5Qrcode('qr-reader')
      scannerRef.current = html5Qrcode

      html5Qrcode.start(
        { facingMode: 'environment' },
        { fps: 10, qrbox: 250 },
        async (decodedText) => {
          // Pause scanning while processing
          try { await html5Qrcode.pause() } catch {}

          // decodedText may be a full URL or a plain participant ID
          const raw = decodedText.trim()
          let participantId = raw
          try {
            const url = new URL(raw)
            participantId = url.searchParams.get('p') || raw
          } catch {}
          const { data, error } = await supabase
            .from('participants')
            .select('id, first_name, last_name, bib_number, category_id, birth_date')
            .eq('id', participantId)
            .single()

          if (error || !data) {
            onError('Nie rozpoznano kodu QR.')
            try { await html5Qrcode.resume() } catch {}
            return
          }

          // Validate belongs to event
          const { data: cats } = await supabase
            .from('categories')
            .select('id, name')
            .eq('event_id', event.id)

          const catIds = (cats || []).map(c => c.id)
          if (!catIds.includes(data.category_id)) {
            onError('Uczestnik nie nalezy do tego wydarzenia.')
            try { await html5Qrcode.resume() } catch {}
            return
          }

          const category = (cats || []).find(c => c.id === data.category_id)
          onFound({ ...data, categoryName: category?.name })
        }
      ).catch(() => {
        onError('Nie udalo sie uruchomic kamery.')
      })
    })

    return () => {
      if (scannerRef.current) {
        scannerRef.current.stop().catch(() => {})
      }
    }
  }, [event.id])

  return (
    <div>
      <div id="qr-reader" ref={containerRef} className="mb-4" />
      <div className="text-apex-muted text-xs text-center">Skieruj kamere na kod QR uczestnika.</div>
    </div>
  )
}

function ManualSearch({ event, onFound }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [searching, setSearching] = useState(false)

  const handleSearch = async () => {
    if (!query.trim()) return
    setSearching(true)

    // Get event categories first
    const { data: cats } = await supabase
      .from('categories')
      .select('id, name')
      .eq('event_id', event.id)

    const catIds = (cats || []).map(c => c.id)
    if (catIds.length === 0) { setResults([]); setSearching(false); return }

    const catMap = Object.fromEntries((cats || []).map(c => [c.id, c.name]))

    // Search by bib or name
    const isNumeric = /^\d+$/.test(query.trim())
    let data = []

    if (isNumeric) {
      const { data: d } = await supabase
        .from('participants')
        .select('id, first_name, last_name, bib_number, category_id, birth_date')
        .in('category_id', catIds)
        .eq('bib_number', parseInt(query.trim(), 10))
      data = d || []
    } else {
      const { data: d } = await supabase
        .from('participants')
        .select('id, first_name, last_name, bib_number, category_id, birth_date')
        .in('category_id', catIds)
        .or(`first_name.ilike.%${query.trim()}%,last_name.ilike.%${query.trim()}%`)
        .limit(20)
      data = d || []
    }

    setResults(data.map(p => ({ ...p, categoryName: catMap[p.category_id] })))
    setSearching(false)
  }

  return (
    <div>
      <div className="flex gap-2 mb-4">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
          placeholder="Numer startowy lub nazwisko"
          className="flex-1 bg-apex-surface border border-apex-border px-4 py-3 text-apex-text-bright focus:outline-none focus:border-apex-yellow"
          autoFocus
        />
        <button
          onClick={handleSearch}
          disabled={searching}
          className="px-6 py-3 bg-apex-yellow text-apex-ink font-bold uppercase tracking-wider hover:bg-apex-yellow-bright transition-colors"
        >
          Szukaj
        </button>
      </div>

      {results.length > 0 && (
        <div className="space-y-1">
          {results.map(p => (
            <button
              key={p.id}
              onClick={() => onFound(p)}
              className="w-full text-left border border-apex-border bg-apex-surface px-4 py-3 hover:bg-apex-surface-2 transition-colors"
            >
              <span className="font-mono text-apex-yellow mr-2">#{p.bib_number}</span>
              <span className="text-apex-text-bright">{p.first_name} {p.last_name}</span>
              {p.categoryName && <span className="text-apex-muted text-xs ml-2">{p.categoryName}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function ParticipantCheckin({ event, participant, pin, onComplete, onError, onBack }) {
  const [documents, setDocuments] = useState([])
  const [checkinDocs, setCheckinDocs] = useState({}) // { docId: status }
  const [alreadyCheckedIn, setAlreadyCheckedIn] = useState(false)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [minorPaperConfirmed, setMinorPaperConfirmed] = useState(false)

  useEffect(() => {
    loadDocuments()
  }, [participant.id])

  const loadDocuments = async () => {
    // Check if already checked in
    const { data: existing } = await supabase
      .from('checkins')
      .select('id, checked_in_at')
      .eq('participant_id', participant.id)
      .limit(1)

    if (existing?.[0]?.checked_in_at) {
      setAlreadyCheckedIn(true)
      setLoading(false)
      return
    }

    // Fetch event documents
    const minor = isMinor(participant.birth_date, event.date)
    const { data: docs } = await supabase
      .from('event_documents')
      .select('id, name, url, type, required_for')
      .eq('event_id', event.id)

    const applicableDocs = (docs || []).filter(d => {
      if (d.required_for === 'all') return true
      if (d.required_for === 'minors' && minor) return true
      if (d.required_for === 'adults' && !minor) return true
      return false
    })

    setDocuments(applicableDocs)

    // Initialize doc statuses
    const initial = {}
    for (const d of applicableDocs) {
      initial[d.id] = d.type === 'acknowledge' ? 'accepted' : 'pending'
    }
    setCheckinDocs(initial)
    setLoading(false)
  }

  function isMinor(birthDate, eventDate) {
    if (!birthDate) return false
    const birth = new Date(birthDate)
    const evDate = new Date(eventDate)
    const age = evDate.getFullYear() - birth.getFullYear()
    const monthDiff = evDate.getMonth() - birth.getMonth()
    if (monthDiff < 0 || (monthDiff === 0 && evDate.getDate() < birth.getDate())) return age - 1 < 18
    return age < 18
  }

  const handleConfirm = async () => {
    if (submitting) return
    setSubmitting(true)

    const docPayload = Object.entries(checkinDocs).map(([docId, status]) => ({
      document_id: docId,
      status,
    }))

    const { data, error } = await supabase.rpc('checkin_confirm', {
      p_participant_id: participant.id,
      p_pin: pin,
      p_documents: docPayload,
    })

    if (error) {
      onError(`Blad: ${error.message}`)
      setSubmitting(false)
      return
    }

    onComplete(`${participant.first_name} ${participant.last_name} (#${participant.bib_number}) zameldowany!`)
  }

  if (loading) {
    return <div className="flex items-center justify-center min-h-screen text-apex-muted">Ladowanie...</div>
  }

  const minor = isMinor(participant.birth_date, event.date)

  return (
    <div className="min-h-screen bg-apex-bg text-apex-text-bright">
      <div className="max-w-lg mx-auto px-6 py-8">
        <button onClick={onBack} className="text-xs text-apex-muted uppercase tracking-wider hover:text-apex-text mb-6 inline-block">
          &larr; Powrot
        </button>

        {/* Participant info */}
        <div className="border border-apex-border bg-apex-surface p-6 mb-6 text-center">
          <div className="font-display text-2xl tracking-wider mb-1">{participant.first_name} {participant.last_name}</div>
          <div className="font-display text-6xl text-apex-yellow tracking-wider my-4">#{participant.bib_number}</div>
          {participant.categoryName && (
            <div className="text-apex-muted text-sm">{participant.categoryName}</div>
          )}
          {minor && (
            <div className="text-apex-cyan text-xs mt-2 uppercase tracking-wider">Niepelnoletni</div>
          )}
        </div>

        {/* Minor warning — must confirm paper received */}
        {minor && !alreadyCheckedIn && (
          <div className="border-2 border-apex-red bg-apex-red-dim/20 p-5 mb-6">
            <div className="font-display text-lg uppercase tracking-wider text-apex-red mb-2">Uczestnik niepelnoletni</div>
            <div className="text-apex-text-bright text-sm leading-relaxed mb-3">
              Uczestnik niepelnoletni <strong>musi dostarczyc podpisana zgode opiekuna prawnego w formie papierowej</strong>.
              Bez tego dokumentu uczestnik <strong>nie moze zostac dopuszczony do startu</strong>.
            </div>
            <label className="flex items-center gap-3 cursor-pointer border border-apex-red/40 bg-apex-bg p-3">
              <input
                type="checkbox"
                checked={minorPaperConfirmed}
                onChange={(e) => setMinorPaperConfirmed(e.target.checked)}
                className="accent-apex-yellow w-5 h-5"
              />
              <span className="text-apex-text-bright text-sm font-bold">
                Potwierdzam odbiór podpisanej zgody opiekuna w formie papierowej
              </span>
            </label>
          </div>
        )}

        {alreadyCheckedIn && (
          <div className="border border-green-700 bg-green-900/30 p-4 text-center text-green-400 mb-6">
            Ten uczestnik jest juz zameldowany.
          </div>
        )}

        {!alreadyCheckedIn && (
          <>
            {/* Document checklist */}
            {documents.length > 0 && (
              <div className="mb-6">
                <div className="text-xs text-apex-muted uppercase tracking-wider mb-3">Dokumenty</div>
                {documents.map(doc => (
                  <label key={doc.id} className="flex items-center gap-3 mb-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={checkinDocs[doc.id] === 'accepted' || checkinDocs[doc.id] === 'verified'}
                      onChange={(e) => {
                        setCheckinDocs(prev => ({
                          ...prev,
                          [doc.id]: e.target.checked
                            ? (doc.type === 'provide' ? 'verified' : 'accepted')
                            : 'pending',
                        }))
                      }}
                      className="accent-apex-yellow"
                    />
                    <div>
                      <span className="text-apex-text-bright text-sm">{doc.name}</span>
                      <span className={`ml-2 text-xs uppercase tracking-wider ${
                        doc.type === 'provide' ? 'text-apex-cyan' : 'text-apex-muted'
                      }`}>
                        {doc.type === 'provide' ? 'do dostarczenia' : 'akceptacja'}
                      </span>
                    </div>
                  </label>
                ))}
              </div>
            )}

            <button
              onClick={handleConfirm}
              disabled={submitting || (minor && !minorPaperConfirmed)}
              className={`w-full py-4 font-bold text-lg uppercase tracking-wider transition-colors ${
                !submitting && (!minor || minorPaperConfirmed)
                  ? 'bg-apex-yellow text-apex-ink hover:bg-apex-yellow-bright cursor-pointer'
                  : 'bg-apex-surface-2 text-apex-muted cursor-not-allowed'
              }`}
            >
              {submitting ? 'Meldowanie...' : 'Zamelduj'}
            </button>
            {minor && !minorPaperConfirmed && (
              <div className="text-apex-red text-xs text-center mt-2 uppercase tracking-wider">
                Potwierdz odbiór zgody opiekuna, aby zameldowac
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
