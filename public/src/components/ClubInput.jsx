import { useState, useEffect, useRef } from 'react'
import { supabase } from '../lib/supabase.js'

/**
 * Club combobox: free text + fuzzy suggestions from the clubs table.
 * value: { name: string, clubId: string|null } — clubId is pinned when the
 * user picks a suggestion and cleared the moment they type again.
 */
export default function ClubInput({ value, onChange, inputClass, inputId = 'club', testId, placeholder = 'Klub Biegacza Kraków' }) {
  const [suggestions, setSuggestions] = useState([])
  const [open, setOpen] = useState(false)
  const queryRef = useRef(value.name)
  queryRef.current = value.name

  useEffect(() => {
    if (value.clubId || value.name.trim().length < 3) {
      setSuggestions([])
      setOpen(false)
      return
    }
    const q = value.name
    const t = setTimeout(async () => {
      const { data, error } = await supabase.rpc('search_clubs', { q })
      if (queryRef.current !== q) return // stale
      if (error || !data) return
      setSuggestions(data)
      setOpen(data.length > 0)
    }, 400)
    return () => clearTimeout(t)
  }, [value.name, value.clubId])

  return (
    <div className="relative">
      <input
        id={inputId}
        data-testid={testId}
        type="text"
        value={value.name}
        onChange={e => onChange({ name: e.target.value, clubId: null })}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onFocus={() => { if (suggestions.length > 0 && !value.clubId) setOpen(true) }}
        placeholder={placeholder}
        maxLength={100}
        className={inputClass}
        role="combobox"
        aria-expanded={open}
        autoComplete="off"
      />
      {open && (
        <ul role="listbox" className="absolute z-20 left-0 right-0 mt-1 bg-apex-surface border border-apex-border max-h-56 overflow-auto">
          {suggestions.map(s => (
            <li key={s.id}>
              <button
                type="button"
                role="option"
                aria-selected="false"
                onMouseDown={e => e.preventDefault()}
                onClick={() => { onChange({ name: s.name, clubId: s.id }); setOpen(false) }}
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
      {value.clubId && (
        <span className="absolute right-2.5 top-1/2 -translate-y-1/2 font-mono text-xs text-apex-yellow pointer-events-none">✓</span>
      )}
    </div>
  )
}
