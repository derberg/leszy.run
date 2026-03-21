import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase } from '../lib/supabase.js'
import { Podium, CheckpointTrackingTable, estimatePositions } from '../ui/index.js'


function formatDuration(ms) {
  if (!ms) return '\u2014'
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`
  return `${m}:${String(sec).padStart(2,'0')}`
}

function formatTime(iso) {
  return new Date(iso).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export default function CategorySection({ eventId, categoryId }) {
  const [category, setCategory] = useState(null)
  const [raceRun, setRaceRun] = useState(null)
  const [results, setResults] = useState([])
  const [checkpoints, setCheckpoints] = useState([])
  const [observations, setObservations] = useState([])
  const checkpointsRef = useRef([])

  const loadData = useCallback(async () => {
    const [catRes, runRes, cpRes] = await Promise.all([
      supabase.from('categories').select('id, name, distance_meters').eq('id', categoryId).single(),
      supabase.from('race_runs').select('id, started_at, status').eq('category_id', categoryId)
        .in('status', ['active', 'finished']).order('created_at', { ascending: false }).limit(1).single(),
      supabase.from('checkpoints').select('id, name, km_marker')
        .eq('event_id', eventId).order('km_marker'),
    ])

    if (catRes.data) setCategory(catRes.data)
    if (cpRes.data) {
      setCheckpoints(cpRes.data)
      checkpointsRef.current = cpRes.data
    }

    const run = runRes.data
    if (!run) return
    setRaceRun(run)

    const [resultRows, participantRows] = await Promise.all([
      supabase.from('results').select('id, race_run_id, participant_id, start_time, finish_time, duration_ms, gun_duration_ms, status').eq('race_run_id', run.id),
      supabase.from('participants').select('id, bib_number, first_name, last_name, club, category_id, emoji, gender').eq('category_id', categoryId),
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
    }))

    setResults(enrichedResults)

    if (cpRes.data?.length) {
      const cpIds = cpRes.data.map(c => c.id)
      const { data: obsData } = await supabase.from('checkpoint_observations')
        .select('id, checkpoint_id, participant_id, bib_number, observed_at')
        .in('checkpoint_id', cpIds)
        .gte('observed_at', run.started_at)
      setObservations((obsData || []).map(o => ({
        ...o,
        checkpointId: o.checkpoint_id,
        participantId: o.participant_id,
        bibNumber: o.bib_number,
        observedAt: o.observed_at,
      })))
    }
  }, [eventId, categoryId])

  useEffect(() => { loadData() }, [loadData])

  useEffect(() => {
    if (!raceRun?.id) return

    const channel = supabase.channel(`public-results-${categoryId}-${raceRun.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'results',
        filter: `race_run_id=eq.${raceRun.id}` }, () => loadData())
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'checkpoint_observations' },
        (payload) => {
          const obs = payload.new
          if (!checkpointsRef.current.some(c => c.id === obs.checkpoint_id)) return
          setObservations(prev => {
            const exists = prev.some(o => o.id === obs.id)
            if (exists) return prev
            return [...prev, {
              id: obs.id,
              checkpointId: obs.checkpoint_id,
              participantId: obs.participant_id,
              bibNumber: obs.bib_number,
              observedAt: obs.observed_at,
            }]
          })
        })
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [raceRun?.id, categoryId, loadData])

  const enrichedResults = estimatePositions(results, checkpoints, observations)
  const top3 = enrichedResults.slice(0, 3)
  const animals = top3.map(r => r.participant?.emoji || '\u{1F3C3}')

  return (
    <div>
      <div className="text-center mb-10">
        <div className="font-display text-5xl tracking-widest uppercase text-white mb-1">
          {category?.name || '\u2014'}
        </div>
        {category?.distance_meters && (
          <div className="text-apex-muted text-sm">{(category.distance_meters / 1000).toFixed(1)} km</div>
        )}
        {raceRun?.started_at && (
          <div className="text-apex-text text-sm">Start {formatTime(raceRun.started_at)}</div>
        )}
      </div>

      {top3.length > 0 && (
        <div className="mb-10">
          <div className="font-display text-2xl tracking-widest uppercase text-apex-text text-center mb-6">Podium</div>
          <Podium top3={top3} animals={animals} formatDuration={formatDuration} />
        </div>
      )}

      {enrichedResults.length > 0 && (
        <div className="mb-8">
          <div className="font-display text-xl tracking-widest uppercase text-apex-text mb-3">Wyniki</div>
          <CheckpointTrackingTable
            results={enrichedResults}
            checkpoints={checkpoints}
            observations={observations}
            formatTime={formatTime}
            formatDuration={formatDuration}
          />
        </div>
      )}

      {!raceRun && (
        <div className="text-center py-12 text-apex-text">
          <div className="font-display text-4xl uppercase tracking-widest mb-2">Oczekiwanie</div>
          <div className="text-sm">Wyscig jeszcze nie wystartowal. Ta strona aktualizuje sie automatycznie.</div>
        </div>
      )}
    </div>
  )
}
