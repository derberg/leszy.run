import { useState, useEffect, useRef } from 'react'
import { searchClubs, requestJoin } from '../lib/clubs.js'
import CreateClubForm from './CreateClubForm.jsx'
import MembershipVisibilityChoice from './MembershipVisibilityChoice.jsx'

// Search-existing→request-join / "Utwórz klub" / leave-blank picker. Replaces
// the old free-text club input (a debounced-search_clubs combobox that pinned
// a value directly). The outcomes here are actions (request a join, create a
// club) rather than pinning a free-text value. The "Utwórz klub" branch
// delegates to the shared `CreateClubForm` component (also used standalone by
// the no-club branch of /profil/klub) — same fields/testids either way
// (`create-name`, `create-description`, `create-submit`).
//
// <ClubPicker onJoined={({club, status}) => {}} onCreated={(club) => {}} onCancel={() => {}} />

const inputClass = 'w-full bg-apex-surface border border-apex-border text-apex-text-bright font-sans text-sm font-medium py-2.5 px-3.5 outline-none focus:border-apex-yellow-dim transition-colors'
const primaryBtnClass = 'font-display font-bold text-[11px] tracking-widest uppercase px-3 py-1.5 border-2 border-apex-yellow text-apex-yellow hover:bg-apex-yellow hover:text-apex-ink transition-all disabled:opacity-40 disabled:cursor-not-allowed'
const ghostBtnClass = 'font-display font-bold text-[11px] tracking-widest uppercase px-3 py-1.5 border border-apex-border text-apex-muted hover:text-apex-yellow hover:border-apex-yellow/40 transition-all disabled:opacity-40 disabled:cursor-not-allowed'

export default function ClubPicker({ onJoined, onCreated, onCancel }) {
  const [query, setQuery] = useState('')
  const [suggestions, setSuggestions] = useState([])
  const [open, setOpen] = useState(false)
  const [confirming, setConfirming] = useState(null) // club awaiting join confirmation
  const [joining, setJoining] = useState(false)
  const [pending, setPending] = useState(null) // { club, status: 'pending' } after a successful request-join
  const [error, setError] = useState(null)
  const [creating, setCreating] = useState(false)
  const [hiddenPublic, setHiddenPublic] = useState(false)
  const queryRef = useRef(query)
  queryRef.current = query

  useEffect(() => {
    if (query.trim().length < 3) {
      setSuggestions([])
      setOpen(false)
      return
    }
    const q = query
    const t = setTimeout(async () => {
      const rows = await searchClubs(q)
      if (queryRef.current !== q) return // stale response — input changed meanwhile
      setSuggestions(rows)
      setOpen(rows.length > 0)
    }, 400)
    return () => clearTimeout(t)
  }, [query])

  async function confirmJoin(club) {
    setJoining(true)
    setError(null)
    try {
      await requestJoin(club.id, { hiddenPublic })
      setPending({ club, status: 'pending' })
      setConfirming(null)
      setOpen(false)
      onJoined?.({ club, status: 'pending' })
    } catch (err) {
      setError(/należysz|already/i.test(err.message) ? 'Należysz już do klubu.' : err.message)
    } finally {
      setJoining(false)
    }
  }

  if (pending) {
    return (
      <p data-testid="club-pending-note" className="font-sans text-sm text-apex-yellow border border-apex-yellow-dim px-3 py-2">
        Wysłano prośbę o dołączenie do «{pending.club.name}» — oczekuje na akceptację.
      </p>
    )
  }

  if (creating) {
    return (
      <CreateClubForm
        onCreated={(club) => { setCreating(false); onCreated?.(club) }}
        onCancel={() => setCreating(false)}
      />
    )
  }

  return (
    <div>
      <div className="relative">
        <input
          data-testid="club-search-input"
          type="text"
          value={query}
          onChange={e => setQuery(e.target.value)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onFocus={() => { if (suggestions.length > 0) setOpen(true) }}
          placeholder="Szukaj klubu…"
          maxLength={120}
          className={inputClass}
          role="combobox"
          aria-expanded={open}
          aria-controls="club-picker-listbox"
          aria-autocomplete="list"
          autoComplete="off"
        />
        {open && (
          <ul id="club-picker-listbox" role="listbox" className="absolute z-20 left-0 right-0 mt-1 bg-apex-surface border border-apex-border max-h-56 overflow-auto">
            {suggestions.map(s => (
              <li key={s.id}>
                <button
                  type="button"
                  role="option"
                  data-testid="club-option"
                  onMouseDown={e => e.preventDefault()}
                  onClick={() => { setConfirming(s); setOpen(false); setError(null) }}
                  className="w-full text-left px-3.5 py-2 font-sans text-sm text-apex-text hover:bg-apex-bg hover:text-apex-yellow transition-colors"
                >
                  {s.name}
                  <span className="font-mono text-[10px] text-apex-muted ml-2">
                    {s.member_count} {s.member_count === 1 ? 'członek' : 'członków'}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {confirming && (
        <div className="mt-2 border border-apex-border px-3 py-2 space-y-2">
          <span className="font-sans text-sm text-apex-text">Dołączyć do «{confirming.name}»?</span>
          <MembershipVisibilityChoice value={hiddenPublic} onChange={setHiddenPublic} />
          <div className="flex items-center gap-2">
            <button data-testid="confirm-join" type="button" onClick={() => confirmJoin(confirming)} disabled={joining} className={primaryBtnClass}>
              {joining ? 'Wysyłanie…' : 'Poproś o dołączenie'}
            </button>
            <button type="button" onClick={() => setConfirming(null)} className={ghostBtnClass}>✕</button>
          </div>
        </div>
      )}

      {error && <p className="text-apex-red font-sans text-xs mt-1">{error}</p>}

      <div className="flex items-center gap-2 mt-2">
        <button type="button" data-testid="create-club-btn" onClick={() => setCreating(true)} className={ghostBtnClass}>
          Utwórz klub
        </button>
        {onCancel && (
          <button type="button" onClick={onCancel} className="font-mono text-xs text-apex-muted hover:text-apex-text-bright transition-all">
            Anuluj
          </button>
        )}
      </div>
    </div>
  )
}
