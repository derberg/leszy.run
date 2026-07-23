import { useState } from 'react'
import { createClub } from '../lib/clubs.js'
import MembershipVisibilityChoice from './MembershipVisibilityChoice.jsx'

// Standalone create-club form, extracted from ClubPicker.jsx so it can be
// reused both inline inside the picker's "Utwórz klub" branch and standalone
// in the no-club branch of /profil/klub (Klub.jsx). Same fields/testids as
// before the extraction — no public-interface change for existing callers.
//
// <CreateClubForm onCreated={(club) => {}} onCancel={() => {}} />
// onCancel is optional — omit it when there is no natural "cancel" step
// (e.g. the standalone /profil/klub no-club branch).

const inputClass = 'w-full bg-apex-surface border border-apex-border text-apex-text-bright font-sans text-sm font-medium py-2.5 px-3.5 outline-none focus:border-apex-yellow-dim transition-colors'
const primaryBtnClass = 'font-display font-bold text-[11px] tracking-widest uppercase px-3 py-1.5 border-2 border-apex-yellow text-apex-yellow hover:bg-apex-yellow hover:text-apex-ink transition-all disabled:opacity-40 disabled:cursor-not-allowed'
const ghostBtnClass = 'font-display font-bold text-[11px] tracking-widest uppercase px-3 py-1.5 border border-apex-border text-apex-muted hover:text-apex-yellow hover:border-apex-yellow/40 transition-all disabled:opacity-40 disabled:cursor-not-allowed'

export default function CreateClubForm({ onCreated, onCancel }) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)
  const [hiddenPublic, setHiddenPublic] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    const trimmed = name.trim()
    if (trimmed.length < 2 || trimmed.length > 120) {
      setError('Nazwa klubu musi mieć 2–120 znaków.')
      return
    }
    setError(null)
    setSubmitting(true)
    try {
      const { club } = await createClub({ name: trimmed, ...(description.trim() ? { description: description.trim() } : {}), hidden_public: hiddenPublic })
      onCreated?.(club)
    } catch (err) {
      if (/already|istnieje/i.test(err.message)) setError('Klub o tej nazwie już istnieje.')
      else if (/należysz|member/i.test(err.message)) setError('Należysz już do klubu.')
      else setError(err.message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-2">
      <div>
        <input
          data-testid="create-name"
          type="text"
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="Klub Biegacza Kraków"
          maxLength={120}
          className={inputClass}
          autoFocus
        />
        <p className="font-mono text-[10px] text-apex-muted mt-0.5">{name.length}/120</p>
      </div>
      <textarea
        data-testid="create-description"
        value={description}
        onChange={e => setDescription(e.target.value)}
        placeholder="Opis klubu (opcjonalnie)"
        rows={2}
        className={`${inputClass} resize-none`}
      />
      <MembershipVisibilityChoice value={hiddenPublic} onChange={setHiddenPublic} />
      {error && <p className="text-apex-red font-sans text-xs">{error}</p>}
      <div className="flex items-center gap-2">
        <button type="submit" data-testid="create-submit" disabled={submitting} className={primaryBtnClass}>
          {submitting ? 'Tworzenie…' : 'Utwórz klub'}
        </button>
        {onCancel && (
          <button type="button" onClick={onCancel} className={ghostBtnClass}>Anuluj</button>
        )}
      </div>
    </form>
  )
}
