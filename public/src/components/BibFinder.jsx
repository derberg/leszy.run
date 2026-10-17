import { useState, useEffect, useMemo, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabase.js'
import { useCategoryResults } from '../hooks/useCategoryResults.js'
import { formatDuration } from '../lib/formatDuration.js'
import { RunnerResultCard, estimatePositions, findRunners, bibCouldMatch, runnerSummary, anonymizedName } from '../ui/index.js'

/**
 * "Znajdź swój wynik": type a bib (or a name) and see that runner's result,
 * whatever category they ran in. The bib is kept in the address as ?nr=, so
 * the link a runner shares opens on their own result.
 *
 * @param {string} eventId
 * @param {Array} categories - the categories shown on the page: [{ id, name }]
 */
export default function BibFinder({ eventId, categories }) {
  const [searchParams, setSearchParams] = useSearchParams()
  const [mode, setMode] = useState('bib')
  const [query, setQuery] = useState(() => searchParams.get('nr') || '')
  const [participants, setParticipants] = useState(null)
  const loadingRef = useRef(false)
  const inputRef = useRef(null)

  const categoryIds = useMemo(() => categories.map(c => c.id), [categories])
  const categoryName = useMemo(() => Object.fromEntries(categories.map(c => [c.id, c.name])), [categories])

  // The roster is fetched on first use, not on every page view: most viewers
  // never search, and a live race page is opened by many people at once.
  const loadParticipants = () => {
    if (participants || loadingRef.current || !categoryIds.length) return
    loadingRef.current = true
    supabase.from('participants_public')
      .select('id, bib_number, first_name, last_name, category_id, deleted_at')
      .in('category_id', categoryIds)
      .then(({ data, error }) => {
        loadingRef.current = false
        if (error || !data) return
        setParticipants(data.map(p => ({
          ...p, bibNumber: p.bib_number, firstName: p.first_name, lastName: p.last_name,
        })))
      }, () => { loadingRef.current = false })
  }

  useEffect(() => {
    if (query) loadParticipants()
  }, [query, categoryIds]) // eslint-disable-line react-hooks/exhaustive-deps

  // Keep ?nr= in step with a bib search, without adding history entries.
  useEffect(() => {
    const nr = mode === 'bib' ? query.trim().replace(/^#/, '') : ''
    if ((searchParams.get('nr') || '') === nr) return
    const next = new URLSearchParams(searchParams)
    if (nr) next.set('nr', nr)
    else next.delete('nr')
    setSearchParams(next, { replace: true })
  }, [mode, query]) // eslint-disable-line react-hooks/exhaustive-deps

  const matches = participants ? findRunners(participants, query, mode) : []
  const trimmed = query.trim()
  const single = matches.length === 1 ? matches[0] : null

  const switchMode = (next) => {
    setMode(next)
    setQuery('')
    inputRef.current?.focus()
  }

  const pick = (p) => {
    setMode('bib')
    setQuery(String(p.bibNumber))
  }

  return (
    <div className="w-full md:max-w-xl md:mx-auto bg-apex-surface border border-apex-border px-4 py-3 mb-6 flex flex-col gap-2.5">
      <label htmlFor="bib-finder" className="font-mono text-[11px] font-semibold tracking-[0.15em] uppercase text-apex-yellow-dim">
        Znajdź swój wynik
      </label>
      <div className={`flex items-center gap-2.5 border-2 h-13 pl-3 pr-1 bg-apex-surface ${trimmed ? 'border-apex-yellow' : 'border-apex-text-bright'}`}>
        <span aria-hidden="true" className="font-mono text-xl font-bold text-apex-dim">{mode === 'bib' ? '#' : ''}</span>
        <input
          id="bib-finder"
          ref={inputRef}
          type="search"
          inputMode={mode === 'bib' ? 'numeric' : 'text'}
          pattern={mode === 'bib' ? '[0-9]*' : undefined}
          autoComplete="off"
          enterKeyHint="search"
          placeholder={mode === 'bib' ? 'Numer startowy' : 'Imię lub nazwisko'}
          value={query}
          onFocus={loadParticipants}
          onChange={e => setQuery(mode === 'bib' ? e.target.value.replace(/[^0-9]/g, '') : e.target.value)}
          className={`flex-1 min-w-0 bg-transparent outline-none text-xl font-bold text-apex-text-bright placeholder:text-apex-dim placeholder:font-semibold [&::-webkit-search-cancel-button]:hidden ${mode === 'bib' ? 'font-mono' : ''}`}
        />
        {query && (
          <button type="button" aria-label="Wyczyść" onClick={() => { setQuery(''); inputRef.current?.focus() }}
            className="w-11 h-11 flex items-center justify-center text-apex-muted hover:text-apex-text-bright">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        )}
      </div>
      <button type="button" onClick={() => switchMode(mode === 'bib' ? 'name' : 'bib')}
        className="self-start text-sm font-semibold text-apex-yellow underline underline-offset-4">
        {mode === 'bib' ? 'albo szukaj po nazwisku' : 'wróć do numeru startowego'}
      </button>

      {trimmed && participants === null && (
        <div className="h-24 bg-apex-surface-2 animate-pulse" />
      )}

      {single && (
        <FoundRunner key={single.id} eventId={eventId} participant={single} categoryName={categoryName[single.category_id]} />
      )}

      {matches.length > 1 && (
        <ul className="border border-apex-border divide-y divide-apex-border">
          {matches.slice(0, 20).map(p => (
            <li key={p.id}>
              <button type="button" onClick={() => pick(p)}
                className="w-full flex items-center gap-3 px-3 py-2.5 min-h-11 text-left hover:bg-apex-surface-2">
                <span className="font-mono text-sm font-bold text-apex-text-bright w-12">#{p.bibNumber}</span>
                <span className="flex-1 min-w-0 flex flex-col">
                  <span className="font-bold text-apex-text-bright truncate">{anonymizedName(p).displayName}</span>
                  <span className="text-xs text-apex-muted">{categoryName[p.category_id]}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {participants && trimmed && matches.length === 0 && (mode === 'name' ? trimmed.length >= 2 : !bibCouldMatch(participants, trimmed)) && (
        <div className="border border-dashed border-apex-border-bright px-3.5 py-3">
          <div className="font-bold text-apex-text-bright">
            {mode === 'bib' ? `Nie ma numeru ${trimmed} w wynikach` : 'Nikogo takiego nie ma w wynikach'}
          </div>
          <div className="text-sm text-apex-text">Sprawdź numer na swoim numerze startowym.</div>
        </div>
      )}
    </div>
  )
}

function FoundRunner({ eventId, participant, categoryName }) {
  const { raceRun, results, checkpoints, observations, loaded } = useCategoryResults(eventId, participant.category_id)
  const [shareLabel, setShareLabel] = useState('Udostępnij')

  const summary = useMemo(() => {
    if (!raceRun) return null
    return runnerSummary(estimatePositions(results, checkpoints, observations), participant.id, checkpoints, observations, raceRun.started_at)
  }, [raceRun, results, checkpoints, observations, participant.id])

  if (!loaded) return <div className="h-24 bg-apex-surface-2 animate-pulse" />

  const share = async () => {
    const url = `${window.location.origin}${window.location.pathname}?nr=${participant.bibNumber}`
    try {
      if (navigator.share) {
        await navigator.share({ url, title: `Wynik #${participant.bibNumber}` })
        return
      }
      await navigator.clipboard.writeText(url)
      setShareLabel('Skopiowano link')
      setTimeout(() => setShareLabel('Udostępnij'), 2000)
    } catch {
      // The viewer closed the share sheet, or the clipboard was refused: nothing to do.
    }
  }

  return (
    <RunnerResultCard
      participant={participant}
      categoryName={categoryName}
      summary={summary}
      formatDuration={formatDuration}
      onShare={share}
      shareLabel={shareLabel}
    />
  )
}
