import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase } from '../lib/supabase.js'
import { estimatePositions } from '../ui/index.js'

function formatTime(iso) {
  return new Date(iso).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

/**
 * Live tracking view — shows all on-course runners across all categories,
 * sorted by position (closest to finish first). Top 3 rendered larger.
 */
export default function LiveTracking({ eventId, categories }) {
  const [allOnCourse, setAllOnCourse] = useState([])
  const [loading, setLoading] = useState(true)
  const checkpointsRef = useRef([])
  const [checkpoints, setCheckpoints] = useState([])

  const loadData = useCallback(async () => {
    // Load checkpoints for this event
    const { data: cpData } = await supabase.from('checkpoints')
      .select('id, name, km_marker')
      .eq('event_id', eventId)
      .order('km_marker')
    const cps = cpData || []
    setCheckpoints(cps)
    checkpointsRef.current = cps

    // For each category, load its active race run + results + participants + observations
    const combined = []

    for (const cat of categories) {
      const { data: runData } = await supabase.from('race_runs')
        .select('id, started_at, status')
        .eq('category_id', cat.id)
        // IMPORTANT: Must include 'finished' — results must stay visible after race stops.
        .in('status', ['active', 'finished'])
        .order('created_at', { ascending: false })
        .limit(1)
        .single()

      if (!runData) continue

      const [resultRows, participantRows] = await Promise.all([
        supabase.from('results')
          .select('id, race_run_id, participant_id, start_time, finish_time, duration_ms, gun_duration_ms, status')
          .eq('race_run_id', runData.id),
        supabase.from('participants')
          .select('id, bib_number, first_name, last_name, club, category_id, emoji, gender')
          .eq('category_id', cat.id),
      ])

      const pMap = Object.fromEntries((participantRows.data || []).map(p => [p.id, {
        ...p, firstName: p.first_name, lastName: p.last_name, bibNumber: p.bib_number, gender: p.gender,
      }]))

      const enrichedResults = (resultRows.data || []).map(r => ({
        ...r,
        participantId: r.participant_id,
        startTime: r.start_time,
        finishTime: r.finish_time,
        durationMs: r.duration_ms,
        gunDurationMs: r.gun_duration_ms,
        participant: pMap[r.participant_id],
        _categoryName: cat.name,
        _categoryDistance: cat.distance_meters,
      }))

      // Load observations
      let obs = []
      if (cps.length > 0) {
        const cpIds = cps.map(c => c.id)
        const { data: obsData } = await supabase.from('checkpoint_observations')
          .select('id, checkpoint_id, participant_id, bib_number, observed_at')
          .in('checkpoint_id', cpIds)
          .gte('observed_at', runData.started_at)
        obs = (obsData || []).map(o => ({
          ...o,
          checkpointId: o.checkpoint_id,
          participantId: o.participant_id,
          bibNumber: o.bib_number,
          observedAt: o.observed_at,
        }))
      }

      // Use estimatePositions to get proper ordering per category
      const ranked = estimatePositions(enrichedResults, cps, obs)

      // Filter to only on-course: started but not finished
      const onCourse = ranked.filter(r => r.startTime && !r.finishTime)
      combined.push(...onCourse)
    }

    // Sort the combined list: runners with checkpoint obs first (by furthest CP then earliest time),
    // then started-only runners (by start time)
    combined.sort((a, b) => {
      const aObs = a._obs, bObs = b._obs
      if (aObs && bObs) {
        if (aObs.checkpointIdx !== bObs.checkpointIdx) return bObs.checkpointIdx - aObs.checkpointIdx
        return new Date(aObs.observedAt) - new Date(bObs.observedAt)
      }
      if (aObs) return -1
      if (bObs) return 1
      return new Date(a.startTime) - new Date(b.startTime)
    })

    setAllOnCourse(combined)
    setLoading(false)
  }, [eventId, categories])

  useEffect(() => { loadData() }, [loadData])

  // Real-time: reload on any results or checkpoint_observations change
  useEffect(() => {
    const channel = supabase.channel(`live-tracking-${eventId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'results' }, () => loadData())
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'checkpoint_observations' }, () => loadData())
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [eventId, loadData])

  // Also poll every 10s as fallback
  useEffect(() => {
    const interval = setInterval(loadData, 10000)
    return () => clearInterval(interval)
  }, [loadData])

  if (loading) {
    return (
      <div className="text-center py-16 text-apex-muted">
        <div className="font-display text-2xl uppercase tracking-widest animate-pulse">Ladowanie...</div>
      </div>
    )
  }

  if (allOnCourse.length === 0) {
    return (
      <div className="text-center py-16 text-apex-muted">
        <div className="font-display text-3xl uppercase tracking-widest mb-2">Brak zawodnikow na trasie</div>
        <div className="text-sm">Ta strona aktualizuje sie automatycznie.</div>
      </div>
    )
  }

  // Build checkpoint index map for status display
  const cpIndexById = Object.fromEntries(checkpoints.map((cp, i) => [cp.id, i]))

  const getLocationLabel = (r) => {
    if (r._obs) {
      const cp = checkpoints[r._obs.checkpointIdx]
      if (cp) return cp.name + (cp.km_marker ? ` (km ${cp.km_marker})` : '')
    }
    return 'Start'
  }

  const top3 = allOnCourse.slice(0, 3)
  const rest = allOnCourse.slice(3)

  return (
    <div>
      <div className="text-center mb-8">
        <div className="font-display text-4xl tracking-widest uppercase text-apex-text-bright mb-1">Na Trasie</div>
        <div className="text-apex-muted text-sm">{allOnCourse.length} zawodnikow</div>
      </div>

      {/* Top 3 — large cards */}
      <div className="space-y-3 mb-6">
        {top3.map((r, i) => {
          const p = r.participant
          const loc = getLocationLabel(r)
          return (
            <div key={r.id} className="border border-apex-border bg-apex-surface px-5 py-4 flex items-center gap-4">
              <div className="font-display text-5xl text-apex-yellow leading-none w-14 text-center shrink-0">
                {i + 1}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline gap-2 mb-1 flex-wrap">
                  {p?.emoji && <span className="text-2xl leading-none">{p.emoji}</span>}
                  <span className="font-display text-2xl uppercase tracking-wide text-apex-text-bright break-words min-w-0">
                    {p?.firstName} {p?.lastName}
                  </span>
                  <span className="font-mono text-sm text-apex-muted shrink-0">#{p?.bibNumber}</span>
                </div>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                  <span className="text-apex-muted">{r._categoryName}</span>
                  <span className="flex items-center gap-1.5 text-apex-cyan">
                    <span className="inline-block w-1.5 h-1.5 rounded-full bg-apex-cyan animate-pulse" />
                    {loc}
                  </span>
                  {r._obs?.observedAt && (
                    <span className="font-mono text-apex-muted text-xs">{formatTime(r._obs.observedAt)}</span>
                  )}
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {/* Rest — compact table */}
      {rest.length > 0 && (
        <>
          {/* Desktop */}
          <div className="hidden md:block border border-apex-border bg-apex-surface">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-apex-border bg-apex-surface-2">
                  <th className="text-left px-3 py-2 text-xs font-bold uppercase tracking-wider text-apex-muted w-12">Poz.</th>
                  <th className="text-left px-3 py-2 text-xs font-bold uppercase tracking-wider text-apex-muted w-12">Nr</th>
                  <th className="text-left px-3 py-2 text-xs font-bold uppercase tracking-wider text-apex-muted">Zawodnik</th>
                  <th className="text-left px-3 py-2 text-xs font-bold uppercase tracking-wider text-apex-muted">Kategoria</th>
                  <th className="text-left px-3 py-2 text-xs font-bold uppercase tracking-wider text-apex-cyan">Lokalizacja</th>
                  <th className="text-left px-3 py-2 text-xs font-bold uppercase tracking-wider text-apex-muted font-mono">Czas</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-apex-border">
                {rest.map((r, i) => {
                  const p = r.participant
                  const loc = getLocationLabel(r)
                  return (
                    <tr key={r.id} className="hover:bg-apex-surface-2 transition-colors">
                      <td className="px-3 py-1.5 font-display text-lg text-apex-yellow">{i + 4}</td>
                      <td className="px-3 py-1.5 font-mono text-xs">#{p?.bibNumber}</td>
                      <td className="px-3 py-1.5">
                        {p?.emoji && <span className="mr-1">{p.emoji}</span>}
                        {p?.firstName} {p?.lastName}
                      </td>
                      <td className="px-3 py-1.5 text-apex-muted">{r._categoryName}</td>
                      <td className="px-3 py-1.5 text-apex-cyan">
                        <span className="inline-block w-1.5 h-1.5 rounded-full bg-apex-cyan animate-pulse mr-1.5 align-middle" />
                        {loc}
                      </td>
                      <td className="px-3 py-1.5 font-mono text-apex-muted text-xs">
                        {r._obs?.observedAt ? formatTime(r._obs.observedAt) : r.startTime ? formatTime(r.startTime) : '—'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {/* Mobile cards */}
          <div className="md:hidden space-y-1.5">
            {rest.map((r, i) => {
              const p = r.participant
              const loc = getLocationLabel(r)
              return (
                <div key={r.id} className="border border-apex-border bg-apex-surface px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className="font-display text-lg text-apex-yellow w-8 text-center shrink-0">{i + 4}</span>
                    <span className="font-mono text-xs text-apex-muted">#{p?.bibNumber}</span>
                    <span className="text-sm flex-1 truncate">{p?.firstName} {p?.lastName}</span>
                  </div>
                  <div className="flex items-center gap-3 ml-8 text-xs">
                    <span className="text-apex-muted">{r._categoryName}</span>
                    <span className="text-apex-cyan">
                      <span className="inline-block w-1 h-1 rounded-full bg-apex-cyan animate-pulse mr-1 align-middle" />
                      {loc}
                    </span>
                  </div>
                </div>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
