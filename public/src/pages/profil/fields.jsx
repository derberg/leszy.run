import { useState } from 'react'
import ClubInput from '../../components/ClubInput.jsx'

// Shared field primitives for the profile settings view. Extracted from the old
// monolithic Profil.jsx so Ustawienia.jsx (and future sections) can reuse them.

export const inputClass = 'flex-1 min-w-0 bg-apex-surface border border-apex-border text-apex-text-bright font-sans text-sm font-medium py-1.5 px-2.5 outline-none focus:border-apex-yellow-dim transition-colors'
export const sectionTitle = 'font-display font-bold text-[10px] tracking-widest uppercase text-apex-muted border-b border-apex-border pb-1 mb-3'
export const actionBtnClass = 'font-mono text-xs px-2 py-1.5 border transition-all leading-none'

export function PencilIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
    </svg>
  )
}

// Parse stored E.164 (+48xxxxxxxxx) into local digits.
// Tolerates legacy values without country code.
function parsePhone(stored) {
  if (!stored) return ''
  const digits = stored.replace(/\D/g, '')
  if (digits.startsWith('48') && digits.length === 11) return digits.slice(2)
  if (stored.startsWith('+48')) return stored.slice(3).replace(/\D/g, '')
  return digits.length === 9 ? digits : digits
}

// Strip everything not a digit; remove leading 48 / +48 / 0048 that user might type.
function normalizePhoneDigits(input) {
  let s = (input || '').replace(/[\s\-()]/g, '')
  if (s.startsWith('+48')) s = s.slice(3)
  else if (s.startsWith('0048')) s = s.slice(4)
  else if (s.startsWith('48') && s.length > 9) s = s.slice(2)
  return s.replace(/\D/g, '').slice(0, 9)
}

function formatPhoneDisplay(stored) {
  const d = parsePhone(stored)
  if (d.length !== 9) return stored || ''
  return `+48 ${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6, 9)}`
}

export function EditablePhoneField({ value, onSave }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(parsePhone(value))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  async function save() {
    const digits = normalizePhoneDigits(draft)
    if (digits === '') {
      setSaving(true)
      await onSave('phone', null)
      setSaving(false)
      setEditing(false)
      return
    }
    if (digits.length !== 9) {
      setError('Numer musi mieć 9 cyfr (bez +48).')
      return
    }
    setError(null)
    setSaving(true)
    await onSave('phone', `+48${digits}`)
    setSaving(false)
    setEditing(false)
  }

  if (editing) {
    return (
      <div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 bg-apex-surface border border-apex-border px-2 py-1.5 text-sm font-mono text-apex-muted shrink-0" title="Obecnie wspieramy tylko numery polskie">
            +48
          </div>
          <input
            data-testid="input-phone"
            type="tel"
            inputMode="numeric"
            value={draft}
            onChange={e => { setDraft(e.target.value); setError(null) }}
            placeholder="123 456 789"
            className={inputClass}
            autoFocus
          />
          <button
            data-testid="save-phone"
            onClick={save}
            disabled={saving}
            className={`${actionBtnClass} border-apex-yellow text-apex-yellow hover:bg-apex-yellow hover:text-apex-ink`}
          >
            OK
          </button>
          <button onClick={() => { setEditing(false); setError(null) }} className={`${actionBtnClass} border-apex-border text-apex-muted hover:text-apex-text-bright hover:border-apex-border`}>✕</button>
        </div>
        {error && <p className="text-apex-red font-mono text-[10px] mt-1">{error}</p>}
        <p className="text-apex-muted font-mono text-[9px] mt-1">Wspieramy tylko numery polskie. Numer wykorzystamy do powiadomień SMS o wydarzeniach.</p>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-2 group">
      <span className="font-sans text-sm text-apex-text">
        {value ? formatPhoneDisplay(value) : <span className="text-apex-muted italic">nie ustawiono</span>}
      </span>
      <button
        data-testid="edit-phone"
        onClick={() => { setDraft(parsePhone(value)); setError(null); setEditing(true) }}
        aria-label="Edytuj telefon"
        title="Edytuj"
        className="p-1 text-apex-muted md:opacity-0 md:group-hover:opacity-100 hover:text-apex-yellow transition-all"
      >
        <PencilIcon />
      </button>
    </div>
  )
}

export const VOIVODESHIP_OPTIONS = [
  'Dolnośląskie', 'Kujawsko-Pomorskie', 'Łódzkie', 'Lubelskie', 'Lubuskie',
  'Małopolskie', 'Mazowieckie', 'Opolskie', 'Podkarpackie', 'Podlaskie',
  'Pomorskie', 'Śląskie', 'Świętokrzyskie', 'Warmińsko-Mazurskie',
  'Wielkopolskie', 'Zachodniopomorskie',
]

export const GENDER_LABELS = { M: 'Mężczyzna', F: 'Kobieta', X: 'Inna' }

export function EditableField({ fieldKey, value, onSave, type = 'text', options, displayValue }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value ?? '')
  const [saving, setSaving] = useState(false)

  async function save() {
    setSaving(true)
    await onSave(fieldKey, draft === '' ? null : draft)
    setSaving(false)
    setEditing(false)
  }

  if (editing) {
    return (
      <div className="flex items-center gap-2">
        {options ? (
          <select
            data-testid={`input-${fieldKey}`}
            value={draft}
            onChange={e => setDraft(e.target.value)}
            className={`${inputClass} appearance-none cursor-pointer`}
            autoFocus
          >
            <option value="">— nie ustawiono —</option>
            {options.map(o => (
              <option key={o.value ?? o} value={o.value ?? o}>{o.label ?? o}</option>
            ))}
          </select>
        ) : (
          <input
            data-testid={`input-${fieldKey}`}
            type={type}
            value={draft}
            onChange={e => setDraft(e.target.value)}
            className={inputClass}
            autoFocus
          />
        )}
        <button
          data-testid={`save-${fieldKey}`}
          onClick={save}
          disabled={saving}
          className={`${actionBtnClass} border-apex-yellow text-apex-yellow hover:bg-apex-yellow hover:text-apex-ink`}
        >
          OK
        </button>
        <button
          onClick={() => setEditing(false)}
          className={`${actionBtnClass} border-apex-border text-apex-muted hover:text-apex-text-bright hover:border-apex-border`}
        >
          ✕
        </button>
      </div>
    )
  }

  const shown = displayValue !== undefined ? displayValue : value

  return (
    <div className="flex items-center gap-2 group">
      <span className="font-sans text-sm text-apex-text">
        {shown || <span className="text-apex-muted italic">nie ustawiono</span>}
      </span>
      <button
        data-testid={`edit-${fieldKey}`}
        onClick={() => { setDraft(value ?? ''); setEditing(true) }}
        aria-label="Edytuj"
        title="Edytuj"
        className="p-1 text-apex-muted md:opacity-0 md:group-hover:opacity-100 hover:text-apex-yellow transition-all"
      >
        <PencilIcon />
      </button>
    </div>
  )
}

export function EditableClubField({ value, onSaveClub }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState({ name: value || '', clubId: null })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  async function save() {
    setSaving(true)
    setError(null)
    try {
      await onSaveClub(draft)
      setEditing(false)
    } catch {
      setError('Nie udało się zapisać klubu.')
    } finally {
      setSaving(false)
    }
  }

  if (editing) {
    return (
      <>
        <div className="flex items-center gap-2">
          <div className="flex-1 min-w-0">
            <ClubInput value={draft} onChange={setDraft} inputClass={inputClass} inputId="club-edit" testId="input-club" />
          </div>
          <button
            data-testid="save-club"
            onClick={save}
            disabled={saving}
            className={`${actionBtnClass} border-apex-yellow text-apex-yellow hover:bg-apex-yellow hover:text-apex-ink`}
          >
            OK
          </button>
          <button onClick={() => { setEditing(false); setError(null) }} className={`${actionBtnClass} border-apex-border text-apex-muted hover:text-apex-text-bright hover:border-apex-border`}>✕</button>
        </div>
        {error && <p className="text-apex-red font-sans text-xs mt-1">{error}</p>}
      </>
    )
  }

  return (
    <div className="flex items-center gap-2 group">
      <span className="font-sans text-sm text-apex-text">
        {value || <span className="text-apex-muted italic">nie ustawiono</span>}
      </span>
      <button
        data-testid="edit-club"
        onClick={() => { setDraft({ name: value || '', clubId: null }); setError(null); setEditing(true) }}
        aria-label="Edytuj klub"
        title="Edytuj"
        className="p-1 text-apex-muted md:opacity-0 md:group-hover:opacity-100 hover:text-apex-yellow transition-all"
      >
        <PencilIcon />
      </button>
    </div>
  )
}
