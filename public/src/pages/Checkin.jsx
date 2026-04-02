import { useState, useEffect, useRef, useCallback } from 'react'
import { useEvent } from '../hooks/useEvent.js'
import { supabase } from '../lib/supabase.js'
import { QRCodeCanvas } from 'qrcode.react'

function isMinor(birthDate, eventDate) {
  if (!birthDate) return false
  const birth = new Date(birthDate)
  const event = new Date(eventDate)
  const age = event.getFullYear() - birth.getFullYear()
  const monthDiff = event.getMonth() - birth.getMonth()
  if (monthDiff < 0 || (monthDiff === 0 && event.getDate() < birth.getDate())) return age - 1 < 18
  return age < 18
}

export default function Checkin() {
  const { event, loading: eventLoading, error: eventError } = useEvent()
  const participantId = new URLSearchParams(window.location.search).get('p')

  const [participant, setParticipant] = useState(null)
  const [documents, setDocuments] = useState([])
  const [checkedIn, setCheckedIn] = useState(false)
  const [acknowledged, setAcknowledged] = useState({})
  const [submitting, setSubmitting] = useState(false)
  const [loadError, setLoadError] = useState(null)
  const [loading, setLoading] = useState(true)
  const qrRef = useRef(null)

  const loadData = useCallback(async () => {
    if (!event || !participantId) return

    // Fetch participant via RPC (PII not exposed through direct table access)
    const { data: pData, error: pErr } = await supabase
      .rpc('get_participant_for_checkin', { p_participant_id: participantId })

    if (pErr || !pData) {
      setLoadError('Nie znaleziono uczestnika.')
      setLoading(false)
      return
    }

    // Validate participant belongs to this event's categories
    const { data: cats } = await supabase
      .from('categories')
      .select('id, name')
      .eq('event_id', event.id)

    const catIds = (cats || []).map(c => c.id)
    if (!catIds.includes(pData.category_id)) {
      setLoadError('Uczestnik nie nalezy do tego wydarzenia.')
      setLoading(false)
      return
    }

    const category = (cats || []).find(c => c.id === pData.category_id)
    setParticipant({ ...pData, categoryName: category?.name })

    // Check if already checked in
    const { data: checkinData } = await supabase
      .from('checkins')
      .select('id')
      .eq('participant_id', participantId)
      .limit(1)

    if (checkinData && checkinData.length > 0) {
      setCheckedIn(true)
      setLoading(false)
      return
    }

    // Fetch event documents
    const minor = isMinor(pData.birth_date, event.date)
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
    setLoading(false)
  }, [event, participantId])

  useEffect(() => { loadData() }, [loadData])

  const acknowledgeDocs = documents.filter(d => d.type === 'acknowledge')
  const provideDocs = documents.filter(d => d.type === 'provide')
  const allAcknowledged = acknowledgeDocs.every(d => acknowledged[d.id])

  const handleConfirm = async () => {
    if (!allAcknowledged || submitting) return
    setSubmitting(true)

    // Insert checkin
    const { data: checkinRow, error: checkinErr } = await supabase
      .from('checkins')
      .insert({ participant_id: participantId, event_id: event.id })
      .select('id')
      .single()

    if (checkinErr) {
      console.error('[checkin] insert error', checkinErr)
      setSubmitting(false)
      return
    }

    // Insert checkin_documents
    const docRows = documents.map(d => ({
      checkin_id: checkinRow.id,
      document_id: d.id,
      status: d.type === 'acknowledge' ? 'accepted' : 'pending',
    }))

    if (docRows.length > 0) {
      const { error: docErr } = await supabase.from('checkin_documents').insert(docRows)
      if (docErr) console.error('[checkin] doc insert error', docErr)
    }

    setCheckedIn(true)
    setSubmitting(false)
  }

  const downloadQR = () => {
    const canvas = qrRef.current?.querySelector('canvas')
    if (!canvas) return
    const url = canvas.toDataURL('image/png')
    const a = document.createElement('a')
    a.href = url
    a.download = `checkin-${participant?.bib_number || participantId}.png`
    a.click()
  }

  if (eventLoading || loading) {
    return <div className="flex items-center justify-center min-h-screen text-apex-muted">Ladowanie...</div>
  }
  if (eventError) {
    return <div className="flex items-center justify-center min-h-screen text-apex-red">{eventError}</div>
  }
  if (!participantId) {
    return <div className="flex items-center justify-center min-h-screen text-apex-red">Brak identyfikatora uczestnika w URL.</div>
  }
  if (loadError) {
    return <div className="flex items-center justify-center min-h-screen text-apex-red">{loadError}</div>
  }

  const minor = isMinor(participant?.birth_date, event?.date)

  // Already checked in — show QR
  if (checkedIn) {
    return (
      <div className="min-h-screen bg-apex-bg text-apex-text-bright">
        <div className="max-w-md mx-auto px-6 py-12 text-center">
          <div className="font-display text-4xl uppercase tracking-widest mb-2">Zameldowano!</div>
          <div className="text-apex-muted text-sm mb-8">{participant?.first_name} {participant?.last_name} &middot; #{participant?.bib_number}</div>

          <div ref={qrRef} className="inline-block bg-white p-4 mb-6">
            <QRCodeCanvas value={`${window.location.origin}/events/${event.slug}/admin/checkin?p=${participantId}`} size={200} />
          </div>

          <div className="border border-apex-yellow/40 bg-apex-yellow/10 text-apex-yellow text-sm px-4 py-3 mb-6">
            Przed startem zglos sie z tym kodem QR do <strong>biura zawodow</strong>, aby odebrac pakiet startowy.
          </div>

          {minor && (
            <div className="border-2 border-apex-red bg-apex-red-dim/20 p-4 mb-6">
              <div className="font-display text-base uppercase tracking-wider text-apex-red mb-1">Pamietaj!</div>
              <div className="text-apex-text-bright text-sm leading-relaxed">
                Jako uczestnik niepelnoletni <strong>musisz dostarczyc podpisana zgode opiekuna w formie papierowej</strong> do biura zawodow.
                Bez tego dokumentu <strong>nie zostaniesz dopuszczony/a do startu</strong>.
              </div>
            </div>
          )}

          {participant?.tshirt_size && (
            <div className="border border-apex-yellow/40 bg-apex-yellow/10 p-5">
              <div className="font-display text-lg uppercase tracking-wider text-apex-yellow mb-1">Koszulka</div>
              <div className="text-apex-text-bright text-sm">
                Pamiętaj odebrać koszulkę (rozmiar <strong className="text-apex-yellow">{participant.tshirt_size}</strong>) w biurze zawodów.
              </div>
            </div>
          )}

          <button
            onClick={downloadQR}
            className="w-full py-3 font-bold uppercase tracking-wider text-apex-ink bg-apex-yellow hover:bg-apex-yellow-bright transition-colors"
          >
            Zapisz QR
          </button>
        </div>
      </div>
    )
  }

  // Check-in form
  return (
    <div className="min-h-screen bg-apex-bg text-apex-text-bright">
      <div className="max-w-md mx-auto px-6 py-12">
        <div className="text-center mb-8">
          <div className="font-display text-4xl uppercase tracking-widest mb-1">{event.name}</div>
          <div className="text-apex-muted text-sm">{event.date}{event.location ? ` · ${event.location}` : ''}</div>
        </div>

        {/* Participant info */}
        <div className="border border-apex-border bg-apex-surface p-5 mb-6">
          <div className="text-xs text-apex-muted uppercase tracking-wider mb-2">Uczestnik</div>
          <div className="font-display text-2xl tracking-wider">{participant.first_name} {participant.last_name}</div>
          <div className="text-apex-text text-sm mt-1">
            Nr startowy: <span className="font-mono font-bold text-apex-yellow">#{participant.bib_number}</span>
          </div>
          {participant.categoryName && (
            <div className="text-apex-muted text-xs mt-1">Kategoria: {participant.categoryName}</div>
          )}
        </div>

        {/* Minor banner */}
        {minor && (
          <div className="border-2 border-apex-red bg-apex-red-dim/20 p-5 mb-6">
            <div className="font-display text-lg uppercase tracking-wider text-apex-red mb-2">Uczestnik niepelnoletni</div>
            <div className="text-apex-text-bright text-sm leading-relaxed">
              Wymagana jest <strong>pisemna zgoda opiekuna prawnego</strong>, wydrukowana i podpisana.
            </div>
            <div className="text-apex-text-bright text-sm leading-relaxed mt-2">
              Dokument <strong>musi byc dostarczony w formie papierowej</strong> do biura zawodow przed startem.
              Bez niego uczestnik <strong>nie zostanie dopuszczony do startu</strong>.
            </div>
          </div>
        )}

        {/* Acknowledge documents */}
        {acknowledgeDocs.length > 0 && (
          <div className="mb-6">
            <div className="text-xs text-apex-muted uppercase tracking-wider mb-3">Dokumenty do zaakceptowania</div>
            {acknowledgeDocs.map(doc => (
              <label key={doc.id} className="flex items-start gap-3 mb-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={!!acknowledged[doc.id]}
                  onChange={(e) => setAcknowledged(prev => ({ ...prev, [doc.id]: e.target.checked }))}
                  className="mt-1 accent-apex-yellow"
                />
                <div>
                  {doc.url ? (
                    <a href={doc.url} target="_blank" rel="noopener noreferrer" className="text-apex-cyan hover:underline text-sm">
                      {doc.name}
                    </a>
                  ) : (
                    <span className="text-apex-text-bright text-sm">{doc.name}</span>
                  )}
                </div>
              </label>
            ))}
          </div>
        )}

        {/* Provide documents (reminders) */}
        {provideDocs.length > 0 && (
          <div className="mb-6">
            <div className="text-xs text-apex-muted uppercase tracking-wider mb-3">Dokumenty do dostarczenia</div>
            {provideDocs.map(doc => (
              <div key={doc.id} className="text-sm text-apex-text mb-2 pl-2 border-l-2 border-apex-border">
                {doc.url ? (
                  <a href={doc.url} target="_blank" rel="noopener noreferrer" className="text-apex-cyan hover:underline">
                    {doc.name}
                  </a>
                ) : doc.name}
              </div>
            ))}
          </div>
        )}

        {/* Confirm button */}
        <button
          onClick={handleConfirm}
          disabled={!allAcknowledged || submitting}
          className={`w-full py-4 font-bold text-lg uppercase tracking-wider transition-colors ${
            allAcknowledged && !submitting
              ? 'bg-apex-yellow text-apex-ink hover:bg-apex-yellow-bright cursor-pointer'
              : 'bg-apex-surface-2 text-apex-muted cursor-not-allowed'
          }`}
        >
          {submitting ? 'Wysylanie...' : 'Potwierdzam'}
        </button>
      </div>
    </div>
  )
}
