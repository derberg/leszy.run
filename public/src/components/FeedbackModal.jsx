import { useState } from 'react'
import { supabase } from '../lib/supabase.js'

const CATEGORIES = [
  { value: 'missing_feature', label: 'Brakująca funkcja' },
  { value: 'bug', label: 'Błąd' },
  { value: 'content', label: 'Treść / dane' },
  { value: 'other', label: 'Inne' },
]

const inputClass = 'w-full bg-apex-surface border border-apex-border text-apex-text-bright font-sans text-sm font-medium py-2 px-3 outline-none focus:border-apex-yellow-dim transition-colors'
const labelClass = 'block font-display font-bold text-[10px] tracking-widest uppercase text-apex-muted mb-1'

export default function FeedbackModal({ onClose }) {
  const [category, setCategory] = useState('')
  const [message, setMessage] = useState('')
  const [email, setEmail] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState(null)
  const [honeypot, setHoneypot] = useState('')

  const canSubmit = category && message.trim() && !submitting

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!canSubmit) return
    if (honeypot) { setSubmitted(true); return }

    setSubmitting(true)
    setError(null)

    const { error: err } = await supabase.from('website_feedback').insert({
      category,
      message: message.trim(),
      email: email.trim() || null,
    })

    setSubmitting(false)
    if (err) {
      setError('Nie udało się wysłać sugestii.')
      console.error('Feedback error:', err.message)
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
            <h2 className="font-display font-bold text-base tracking-widest uppercase text-apex-text-bright">Pomóż ulepszyć</h2>
            <button onClick={onClose} className="text-apex-muted hover:text-apex-text-bright text-lg leading-none">&times;</button>
          </div>

          <p className="text-sm text-apex-muted mb-4">Masz pomysł jak ulepszyć stronę? Podziel się z nami!</p>

          {submitted ? (
            <div className="py-6 text-center">
              <div className="text-apex-yellow text-2xl mb-2">&#10003;</div>
              <p className="text-apex-text-bright font-display font-bold tracking-wide uppercase text-sm">Dziękujemy za sugestię!</p>
              <p className="text-apex-muted text-xs mt-1">Przejrzymy Twoje zgłoszenie.</p>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="absolute -left-[9999px]" aria-hidden="true">
                <input type="text" name="website" tabIndex={-1} autoComplete="off" value={honeypot} onChange={(e) => setHoneypot(e.target.value)} />
              </div>

              <div>
                <label className={labelClass}>Kategoria</label>
                <select value={category} onChange={(e) => setCategory(e.target.value)}
                  className={`${inputClass} appearance-none cursor-pointer`}>
                  <option value="">— wybierz —</option>
                  {CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                </select>
              </div>

              <div>
                <label className={labelClass}>Wiadomość</label>
                <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={4}
                  className={`${inputClass} resize-none`} placeholder="Opisz swoją sugestię..." />
              </div>

              <div>
                <label className={labelClass}>Email</label>
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
                  className={inputClass} placeholder="opcjonalnie, jeśli chcesz odpowiedź" />
              </div>

              {error && <div className="text-apex-red text-xs">{error}</div>}

              <button type="submit" disabled={!canSubmit}
                className={`w-full font-display font-bold text-xs tracking-widest uppercase py-2.5 transition-all ${canSubmit ? 'bg-apex-yellow text-apex-ink hover:bg-apex-yellow-bright' : 'bg-apex-surface-2 text-apex-muted cursor-not-allowed border border-apex-border'}`}>
                {submitting ? 'Wysyłanie...' : 'Wyślij sugestię'}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  )
}
