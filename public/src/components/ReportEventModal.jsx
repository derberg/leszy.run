import { useState } from 'react'
import { supabase } from '../lib/supabase.js'

const VOIVODESHIPS = [
  'Dolnośląskie', 'Kujawsko-Pomorskie', 'Łódzkie', 'Lubelskie', 'Lubuskie',
  'Małopolskie', 'Mazowieckie', 'Opolskie', 'Podkarpackie', 'Podlaskie',
  'Pomorskie', 'Śląskie', 'Świętokrzyskie', 'Warmińsko-Mazurskie',
  'Wielkopolskie', 'Zachodniopomorskie',
]

const EVENT_TYPES = ['trail', 'nocny', 'ocr', 'nordic', 'ultra', 'charytatywny', 'uliczny']

const FIELDS = [
  { value: 'name', label: 'Nazwa' },
  { value: 'date', label: 'Data' },
  { value: 'location', label: 'Miejsce' },
  { value: 'voivodeship', label: 'Województwo' },
  { value: 'distances', label: 'Dystanse' },
  { value: 'event_type', label: 'Typ wydarzenia' },
  { value: 'registration_url', label: 'Link do wydarzenia' },
  { value: 'cancelled', label: 'Wydarzenie odwołane' },
]

const inputClass = 'w-full bg-apex-surface border border-apex-border text-apex-text-bright font-sans text-sm font-medium py-2 px-3 outline-none focus:border-apex-yellow-dim transition-colors'
const labelClass = 'block font-display font-bold text-[10px] tracking-widest uppercase text-apex-muted mb-1'

function getCurrentValue(event, field) {
  if (field === 'cancelled') return event.status === 'cancelled' ? 'Tak' : 'Nie'
  if (field === 'distances') return event.distances?.join(', ') || '—'
  if (field === 'event_type') return event.event_type?.join(', ') || '—'
  return event[field] || '—'
}

function SuggestedInput({ field, value, onChange }) {
  if (field === 'cancelled') return null

  if (field === 'date') {
    return <input type="date" value={value} onChange={(e) => onChange(e.target.value)} className={inputClass} />
  }

  if (field === 'voivodeship') {
    return (
      <select value={value} onChange={(e) => onChange(e.target.value)} className={`${inputClass} appearance-none cursor-pointer`}>
        <option value="">— wybierz —</option>
        {VOIVODESHIPS.map(v => <option key={v} value={v}>{v}</option>)}
      </select>
    )
  }

  if (field === 'event_type') {
    const selected = value ? value.split(',').map(s => s.trim()).filter(Boolean) : []
    return (
      <div className="flex flex-wrap gap-1.5">
        {EVENT_TYPES.map(t => (
          <button key={t} type="button"
            onClick={() => {
              const next = selected.includes(t) ? selected.filter(x => x !== t) : [...selected, t]
              onChange(next.join(', '))
            }}
            className={`font-mono text-[10px] font-semibold px-2 py-1 border transition-all ${selected.includes(t) ? 'border-apex-cyan text-apex-cyan bg-apex-cyan/10' : 'border-apex-border text-apex-muted'}`}>
            {t}
          </button>
        ))}
      </div>
    )
  }

  if (field === 'registration_url') {
    return <input type="url" value={value} onChange={(e) => onChange(e.target.value)} className={inputClass} placeholder="https://..." />
  }

  return <input type="text" value={value} onChange={(e) => onChange(e.target.value)} className={inputClass} />
}

export default function ReportEventModal({ event, onClose }) {
  const [field, setField] = useState('')
  const [suggestedValue, setSuggestedValue] = useState('')
  const [sourceUrl, setSourceUrl] = useState('')
  const [note, setNote] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState(null)
  const [honeypot, setHoneypot] = useState('')

  const canSubmit = field && !submitting && (field === 'cancelled' || suggestedValue.trim())

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!canSubmit) return
    if (honeypot) { setSubmitted(true); return }

    setSubmitting(true)
    setError(null)

    const { error: err } = await supabase.from('calendar_event_reports').insert({
      calendar_event_id: event.id,
      field,
      old_value: String(getCurrentValue(event, field)),
      suggested_value: field === 'cancelled' ? 'cancelled' : suggestedValue.trim(),
      source_url: sourceUrl.trim() || null,
      note: note.trim() || null,
    })

    setSubmitting(false)
    if (err) {
      setError('Nie udało się wysłać zgłoszenia.')
      console.error('Report error:', err.message)
    } else {
      setSubmitted(true)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60" />
      <div className="relative bg-apex-bg border border-apex-border w-full max-w-[440px] max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}>
        <div className="p-5">
          <div className="flex justify-between items-center mb-4">
            <h2 className="font-display font-bold text-base tracking-widest uppercase text-apex-text-bright">Zgłoś problem</h2>
            <button onClick={onClose} className="text-apex-muted hover:text-apex-text-bright text-lg leading-none">&times;</button>
          </div>

          <div className="text-sm text-apex-muted mb-4 truncate">{event.name}</div>

          {submitted ? (
            <div className="py-6 text-center">
              <div className="text-apex-yellow text-2xl mb-2">&#10003;</div>
              <p className="text-apex-text-bright font-display font-bold tracking-wide uppercase text-sm">Zgłoszenie wysłane</p>
              <p className="text-apex-muted text-xs mt-1">Dziękujemy za pomoc!</p>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="absolute -left-[9999px]" aria-hidden="true">
                <input type="text" name="website" tabIndex={-1} autoComplete="off" value={honeypot} onChange={(e) => setHoneypot(e.target.value)} />
              </div>

              <div>
                <label className={labelClass}>Co jest nieprawidłowe?</label>
                <select value={field} onChange={(e) => { setField(e.target.value); setSuggestedValue('') }}
                  className={`${inputClass} appearance-none cursor-pointer`}>
                  <option value="">— wybierz pole —</option>
                  {FIELDS.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
                </select>
              </div>

              {field && (
                <>
                  <div>
                    <label className={labelClass}>Obecna wartość</label>
                    <div className="text-sm text-apex-muted bg-apex-surface border border-apex-border px-3 py-2 truncate">
                      {getCurrentValue(event, field)}
                    </div>
                  </div>

                  {field !== 'cancelled' && (
                    <div>
                      <label className={labelClass}>Prawidłowa wartość</label>
                      <SuggestedInput field={field} value={suggestedValue} onChange={setSuggestedValue} />
                    </div>
                  )}

                  <div>
                    <label className={labelClass}>Link do źródła</label>
                    <input type="url" value={sourceUrl} onChange={(e) => setSourceUrl(e.target.value)} className={inputClass} placeholder="https://oficjalna-strona.pl" />
                  </div>

                  <div>
                    <label className={labelClass}>Notatka (opcjonalnie)</label>
                    <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} className={`${inputClass} resize-none`} />
                  </div>

                  {error && <div className="text-apex-red text-xs">{error}</div>}

                  <button type="submit" disabled={!canSubmit}
                    className={`w-full font-display font-bold text-xs tracking-widest uppercase py-2.5 transition-all ${canSubmit ? 'bg-apex-yellow text-apex-ink hover:bg-apex-yellow-bright' : 'bg-apex-surface-2 text-apex-muted cursor-not-allowed border border-apex-border'}`}>
                    {submitting ? 'Wysyłanie...' : 'Wyślij zgłoszenie'}
                  </button>
                </>
              )}
            </form>
          )}
        </div>
      </div>
    </div>
  )
}
