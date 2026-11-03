import { useRef, useState } from 'react'
import { splitTownInput, townCandidates, townSearchUrl } from '../../lib/townSearch.js'
import { btnGhost, fieldInput, fieldLabel, errorClass } from '../../pages/klub/settingsUi.js'

// „Miejscowość” with a Nominatim lookup on Enter, blur or „Pokaż na mapie” — never
// per keystroke. Picking a candidate sets the town label, its area
// („GM. PILCHOWICE · ŚLĄSKIE”) and the pin; one candidate is picked at once.
// Text after the first comma is not part of the town: it reaches onPick as `rest`.
export default function TownSearch({ id = 'town', townLabel, townArea, onPick, disabled = false }) {
  const [text, setText] = useState(townLabel ?? '')
  const [candidates, setCandidates] = useState([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const lastQuery = useRef((townLabel ?? '').trim())
  const restRef = useRef('')

  async function search() {
    const typed = text.trim()
    if (!typed || typed === lastQuery.current || busy) return
    lastQuery.current = typed
    const { town: q, rest } = splitTownInput(typed)
    restRef.current = rest
    if (!q) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(townSearchUrl(q), { headers: { Accept: 'application/json' } })
      const found = townCandidates(await res.json())
      if (found.length === 1) pick(found[0])
      else {
        setCandidates(found)
        if (!found.length) setError('Nie znaleziono miejscowości.')
      }
    } catch {
      lastQuery.current = ''
      setError('Wyszukiwanie nie działa. Spróbuj ponownie.')
    } finally {
      setBusy(false)
    }
  }

  function pick(c) {
    setText(c.label)
    lastQuery.current = c.label
    setCandidates([])
    setError(null)
    onPick(c, { rest: restRef.current })
    restRef.current = ''
  }

  return (
    <div>
      <label htmlFor={id} className={fieldLabel}>Miejscowość</label>
      <div className="flex gap-2">
        <input
          id={id}
          className={fieldInput}
          value={text}
          disabled={disabled}
          autoComplete="off"
          onChange={(e) => setText(e.target.value)}
          onBlur={search}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); search() } }}
        />
        <button type="button" className={`${btnGhost} whitespace-nowrap shrink-0`} disabled={disabled || busy} onClick={search}>Pokaż na mapie</button>
      </div>
      <div className="font-mono text-xs text-apex-muted mt-1.5">Enter albo „Pokaż na mapie” stawia pinezkę. Możesz ją potem przesunąć.</div>
      {townArea && !candidates.length && (
        <div data-testid="town-area" className="font-mono text-xs text-apex-muted mt-1.5">{townArea}</div>
      )}
      {candidates.length > 0 && (
        <ul data-testid="town-candidates" className="mt-1.5 border border-apex-border-mid divide-y divide-apex-border">
          {candidates.map((c) => (
            <li key={`${c.label}|${c.area}`}>
              <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => pick(c)}
                className="w-full text-left px-3.5 py-2 hover:bg-apex-surface-2 flex flex-wrap items-baseline gap-x-3">
                <span className="font-sans text-base text-apex-text-bright">{c.label}</span>
                <span className="font-mono text-xs text-apex-muted">{c.area}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <p className={`${errorClass} mt-1.5`}>{error}</p>}
    </div>
  )
}
