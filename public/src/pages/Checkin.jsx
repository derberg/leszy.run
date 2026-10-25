import { useState, useEffect, useRef, useCallback } from 'react'
import { useEvent } from '../hooks/useEvent.js'
import { supabase } from '../lib/supabase.js'
import { FUNCTIONS_BASE } from '../lib/auth.js'
import { QRCodeCanvas } from 'qrcode.react'
import useSeo from '../hooks/useSeo.js'
import { cardContent, cardFileName, renderCheckinCard, shareMode, downloadFile } from '../lib/checkinCard.js'

// Every participant read and the check-in write go through the self-checkin
// edge function. The link's `t` proves it came from the SMS; the participant
// id alone is public, so it no longer checks anybody in.
async function selfCheckin(body) {
  const res = await fetch(`${FUNCTIONS_BASE}/self-checkin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json = await res.json().catch(() => ({}))
  return res.ok ? { data: json.data } : { error: json.error || `HTTP ${res.status}`, status: res.status }
}

export default function Checkin() {
  useSeo({ title: 'Check-in', noindex: true })
  const { event, loading: eventLoading, error: eventError } = useEvent()
  const linkParams = new URLSearchParams(window.location.search)
  const participantId = linkParams.get('p')
  const token = linkParams.get('t')

  const [participant, setParticipant] = useState(null)
  const [documents, setDocuments] = useState([])
  const [checkedIn, setCheckedIn] = useState(false)
  const [acknowledged, setAcknowledged] = useState({})
  const [submitting, setSubmitting] = useState(false)
  const [confirmError, setConfirmError] = useState(null)
  const [loadError, setLoadError] = useState(null)
  const [loading, setLoading] = useState(true)
  const qrRef = useRef(null)
  const [cardFile, setCardFile] = useState(null)

  const loadData = useCallback(async () => {
    if (!event || !participantId) return

    const { data: found, error: findErr } = await selfCheckin({
      action: 'get', event_id: event.id, participant_id: participantId, token,
    })
    if (findErr || !found) {
      setLoadError(findErr && findErr.status !== 404
        ? 'Nie udało się wczytać danych. Odśwież stronę.'
        : 'Nieprawidłowy lub nieaktualny link. Poproś organizatora o nowy.')
      setLoading(false)
      return
    }
    const pData = found.participant

    const { data: cats } = await supabase
      .from('categories')
      .select('id, name')
      .eq('event_id', event.id)
    const category = (cats || []).find(c => c.id === pData.category_id)
    setParticipant({ ...pData, categoryName: category?.name })

    // Fetch event documents (needed for both check-in form and confirmation screen info links)
    const minor = pData.minor
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

    if (found.checkedIn) setCheckedIn(true)
    setLoading(false)
  }, [event, participantId, token])

  useEffect(() => { loadData() }, [loadData])

  const acknowledgeDocs = documents.filter(d => d.type === 'acknowledge')
  const provideDocs = documents.filter(d => d.type === 'provide')
  const infoDocs = documents.filter(d => d.type === 'info')
  const allAcknowledged = acknowledgeDocs.every(d => acknowledged[d.id])

  const handleConfirm = async () => {
    if (!allAcknowledged || submitting) return
    setSubmitting(true)
    setConfirmError(null)

    const { error } = await selfCheckin({
      action: 'confirm',
      event_id: event.id,
      participant_id: participantId,
      token,
      acknowledged: acknowledgeDocs.map(d => d.id),
    })
    if (error) {
      console.error('[checkin] confirm error', error)
      setConfirmError('Nie udało się zameldować. Spróbuj ponownie albo zgłoś się do biura zawodów.')
      setSubmitting(false)
      return
    }

    setCheckedIn(true)
    setSubmitting(false)
  }

  // Render the card as soon as the confirmation screen is up, so the tap on
  // "Udostępnij" can call navigator.share straight away. iOS Safari refuses a
  // share that follows slow async work inside the click handler.
  useEffect(() => {
    if (!checkedIn || !participant || !event) return
    let cancelled = false
    const qrCanvas = qrRef.current?.querySelector('canvas')
    if (!qrCanvas) return
    const content = cardContent({ event, participant, minor: participant.minor })
    renderCheckinCard(qrCanvas, content, cardFileName(participant, participantId))
      .then(file => { if (!cancelled) setCardFile(file) })
      .catch(err => console.error('[checkin] card render error', err))
    return () => { cancelled = true }
  }, [checkedIn, participant, event, participantId])

  const canShare = cardFile ? shareMode(navigator, cardFile) === 'share' : false

  const shareCard = async () => {
    if (!cardFile) return
    try {
      await navigator.share({ files: [cardFile], title: `Check-in: ${event.name}` })
    } catch (err) {
      // AbortError = the runner closed the share sheet; nothing to do.
      if (err?.name !== 'AbortError') downloadFile(cardFile)
    }
  }

  const saveCard = () => {
    if (cardFile) downloadFile(cardFile)
  }

  if (eventLoading || loading) {
    return <div className="flex items-center justify-center min-h-screen text-apex-muted">Ładowanie...</div>
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

  const minor = !!participant?.minor

  // Already checked in — show QR
  if (checkedIn) {
    return (
      <div className="min-h-screen bg-apex-bg text-apex-text-bright">
        <div className="max-w-md mx-auto px-6 py-12 text-center">
          <div className="font-display text-4xl uppercase tracking-widest mb-2">Zameldowano!</div>
          <div className="text-apex-muted text-sm mb-2">{participant?.first_name} {participant?.last_name} &middot; #{participant?.bib_number}</div>
          
          {participant?.emoji && (
            <div className="mb-8">
              <div className="text-3xl mb-2">{participant.emoji}</div>
              <div className="text-apex-muted text-xs uppercase tracking-wider">Twoja emotka</div>
            </div>
          )}

          <div ref={qrRef} className="inline-block bg-white p-4 mb-6">
            <QRCodeCanvas value={`${window.location.origin}/events/${event.slug}/admin/checkin?p=${participantId}`} size={280} />
          </div>

          <div className="flex flex-col gap-3 mb-6">
            {canShare && (
              <button
                onClick={shareCard}
                className="w-full py-3 font-bold uppercase tracking-wider text-apex-ink bg-apex-yellow hover:bg-apex-yellow-bright transition-colors"
              >
                Udostępnij
              </button>
            )}
            <button
              onClick={saveCard}
              disabled={!cardFile}
              className={canShare
                ? 'w-full py-3 font-bold uppercase tracking-wider border border-apex-yellow text-apex-yellow hover:bg-apex-yellow hover:text-apex-ink transition-colors disabled:opacity-50'
                : 'w-full py-3 font-bold uppercase tracking-wider text-apex-ink bg-apex-yellow hover:bg-apex-yellow-bright transition-colors disabled:opacity-50'}
            >
              Zapisz obraz
            </button>
          </div>

          <div className="border border-apex-yellow/40 bg-apex-yellow/10 text-apex-yellow text-sm px-4 py-3 mb-6">
            Przed startem zgłoś się z tym kodem QR do <strong>biura zawodów</strong>, aby odebrać pakiet startowy.
          </div>

          {minor && (
            <div className="border-2 border-apex-red bg-apex-red-dim/20 p-4 mb-6">
              <div className="font-display text-base uppercase tracking-wider text-apex-red mb-1">Pamiętaj!</div>
              <div className="text-apex-text-bright text-sm leading-relaxed">
                Jako uczestnik niepełnoletni <strong>musisz dostarczyć podpisaną zgodę opiekuna w formie papierowej</strong> do biura zawodów.
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

          {infoDocs.length > 0 && (
            <div className="mt-6 mb-6">
              <div className="text-xs text-apex-muted uppercase tracking-wider mb-3">Informacje</div>
              {infoDocs.map(doc => (
                <div key={doc.id} className="text-sm text-apex-text mb-2 pl-2 border-l-2 border-apex-yellow/40">
                  {doc.url ? (
                    <a href={doc.url} target="_blank" rel="noopener noreferrer" className="text-apex-cyan hover:underline">
                      {doc.name} ↗
                    </a>
                  ) : doc.name}
                </div>
              ))}
            </div>
          )}

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
            <div className="font-display text-lg uppercase tracking-wider text-apex-red mb-2">Uczestnik niepełnoletni</div>
            <div className="text-apex-text-bright text-sm leading-relaxed">
              Wymagana jest <strong>pisemna zgoda opiekuna prawnego</strong>, wydrukowana i podpisana.
            </div>
            <div className="text-apex-text-bright text-sm leading-relaxed mt-2">
              Dokument <strong>musi być dostarczony w formie papierowej</strong> do biura zawodów przed startem.
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

        {/* Info links (non-blocking) */}
        {infoDocs.length > 0 && (
          <div className="mb-6">
            <div className="text-xs text-apex-muted uppercase tracking-wider mb-3">Informacje</div>
            {infoDocs.map(doc => (
              <div key={doc.id} className="text-sm text-apex-text mb-2 pl-2 border-l-2 border-apex-yellow/40">
                {doc.url ? (
                  <a href={doc.url} target="_blank" rel="noopener noreferrer" className="text-apex-cyan hover:underline">
                    {doc.name} ↗
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
          {submitting ? 'Wysyłanie...' : 'Potwierdzam'}
        </button>
        {confirmError && (
          <div className="mt-3 border border-apex-red/50 bg-apex-red/10 text-apex-red px-3 py-2 text-sm text-center">{confirmError}</div>
        )}
      </div>
    </div>
  )
}
