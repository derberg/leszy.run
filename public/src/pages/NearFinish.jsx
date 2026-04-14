import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase.js'

function formatTime(iso) {
  return new Date(iso).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

/**
 * Shows runners observed at the near-finish checkpoint.
 * @param {string} nearFinishCheckpointId - the checkpoint with is_near_finish=true
 * @param {Array} categories - all timed categories for this event
 */
export default function NearFinish({ nearFinishCheckpointId, categories }) {
  const [runners, setRunners] = useState([])
  const [loading, setLoading] = useState(true)

  const catMap = Object.fromEntries(categories.map(c => [c.id, c.name]))

  const loadData = useCallback(async () => {
    // 1. Fetch observations for this checkpoint
    const { data: obsData } = await supabase.from('checkpoint_observations')
      .select('id, checkpoint_id, bib_number, participant_id, observed_at')
      .eq('checkpoint_id', nearFinishCheckpointId)
      .order('observed_at', { ascending: false })

    const observations = obsData || []

    // 2. Get participant IDs and bib numbers to fetch participant details
    const participantIds = [...new Set(observations.filter(o => o.participant_id).map(o => o.participant_id))]
    const bibNumbers = [...new Set(observations.map(o => o.bib_number))]

    let participants = []
    if (participantIds.length > 0) {
      const { data } = await supabase.from('participants_public')
        .select('id, bib_number, first_name, last_name, category_id')
        .in('id', participantIds)
      participants = data || []
    }
    // Also fetch by bib for observations without participant_id
    if (bibNumbers.length > 0) {
      const { data } = await supabase.from('participants_public')
        .select('id, bib_number, first_name, last_name, category_id')
        .in('bib_number', bibNumbers)
      if (data) {
        const existingIds = new Set(participants.map(p => p.id))
        for (const p of data) {
          if (!existingIds.has(p.id)) participants.push(p)
        }
      }
    }

    // Build lookup maps
    const pById = Object.fromEntries(participants.map(p => [p.id, p]))
    const pByBib = Object.fromEntries(participants.map(p => [p.bib_number, p]))

    // 3. Dedup by participant (keep earliest observedAt per participant/bib)
    const seen = new Set()
    const deduped = []
    // Sort ascending to pick earliest first, then reverse for display
    const sorted = [...observations].sort((a, b) => new Date(a.observed_at) - new Date(b.observed_at))
    for (const obs of sorted) {
      const p = (obs.participant_id && pById[obs.participant_id]) || pByBib[obs.bib_number]
      const key = p ? p.id : `bib-${obs.bib_number}`
      if (seen.has(key)) continue
      seen.add(key)
      deduped.push({
        id: obs.id,
        bibNumber: obs.bib_number,
        observedAt: obs.observed_at,
        firstName: p?.first_name || '?',
        lastName: p?.last_name || '?',
        categoryName: p ? (catMap[p.category_id] || '') : '',
      })
    }

    // Sort by observed_at descending (most recent first)
    deduped.sort((a, b) => new Date(b.observedAt) - new Date(a.observedAt))

    setRunners(deduped)
    setLoading(false)
  }, [nearFinishCheckpointId, categories])

  useEffect(() => { loadData() }, [loadData])

  // Real-time: subscribe to checkpoint_observations inserts for this checkpoint
  useEffect(() => {
    const channel = supabase.channel(`near-finish-${nearFinishCheckpointId}`)
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'checkpoint_observations',
        filter: `checkpoint_id=eq.${nearFinishCheckpointId}`,
      }, () => loadData())
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [nearFinishCheckpointId, loadData])

  // Poll every 10s as fallback
  useEffect(() => {
    const interval = setInterval(loadData, 10000)
    return () => clearInterval(interval)
  }, [loadData])

  if (loading) {
    return (
      <div className="text-center py-16 text-apex-muted">
        <div className="font-display text-2xl uppercase tracking-widest animate-pulse">Ładowanie...</div>
      </div>
    )
  }

  if (runners.length === 0) {
    return (
      <div className="text-center py-16 text-apex-muted">
        <div className="font-display text-3xl uppercase tracking-widest mb-2">Nikt jeszcze nie minął tego punktu</div>
        <div className="text-sm">Ta strona aktualizuje się automatycznie.</div>
      </div>
    )
  }

  return (
    <div>
      <div className="text-center mb-8">
        <div className="font-display text-4xl tracking-widest uppercase text-apex-text-bright mb-1">Blisko Mety</div>
        <div className="text-apex-muted text-sm">{runners.length} zawodników</div>
      </div>

      <div className="border border-apex-border bg-apex-surface overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-apex-border bg-apex-surface-2">
              <th className="text-left px-3 py-2 text-xs font-bold uppercase tracking-wider text-apex-muted w-12">Nr</th>
              <th className="text-left px-3 py-2 text-xs font-bold uppercase tracking-wider text-apex-muted">Zawodnik</th>
              <th className="text-left px-3 py-2 text-xs font-bold uppercase tracking-wider text-apex-muted">Kategoria</th>
              <th className="text-left px-3 py-2 text-xs font-bold uppercase tracking-wider text-apex-muted font-mono">Godzina</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-apex-border">
            {runners.map(r => (
              <tr key={r.id} className="hover:bg-apex-surface-2 transition-colors">
                <td className="px-3 py-1.5 font-mono text-xs">#{r.bibNumber}</td>
                <td className="px-3 py-1.5">{r.firstName} {r.lastName}</td>
                <td className="px-3 py-1.5 text-apex-muted">{r.categoryName}</td>
                <td className="px-3 py-1.5 font-mono text-apex-cyan">{formatTime(r.observedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
