import { useState, useEffect, useCallback, useRef, useId } from 'react'
import { supabase } from '../lib/supabase.js'
import { applyResultChange, canApplyResultChange, coalesce } from '../lib/liveResults.js'

/**
 * One category's latest started run, its results, its public checkpoints and the
 * observations at them, kept live over realtime. Shared by the category section
 * and the bib finder so both read the same rows the same way.
 *
 * @returns {{ category, raceRun, results, checkpoints, observations, loaded }}
 */
export function useCategoryResults(eventId, categoryId) {
  // The section and the finder can show the same category at once. Each needs
  // its own channel: supabase-js keys channels by name, so a shared name would
  // let one unmount remove the other's subscription.
  const instanceId = useId()
  const [category, setCategory] = useState(null)
  const [raceRun, setRaceRun] = useState(null)
  const [results, setResults] = useState([])
  const [checkpoints, setCheckpoints] = useState([])
  const [observations, setObservations] = useState([])
  // False until the first load has answered, so a caller can tell "no result
  // yet" from "not loaded yet".
  const [loaded, setLoaded] = useState(false)
  const checkpointsRef = useRef([])
  const pMapRef = useRef({})
  // Retries a load the API failed, spread over 5–10 s.
  const loadDataRef = useRef(null)
  const retryRef = useRef(null)
  if (!retryRef.current) retryRef.current = coalesce(() => loadDataRef.current(), 5000, 5000)

  const loadData = useCallback(async () => {
    if (!categoryId) return
    const [catRes, runRes, cpRes, cpCatRes] = await Promise.all([
      supabase.from('categories').select('id, name').eq('id', categoryId).single(),
      supabase.from('race_runs').select('id, started_at, status').eq('category_id', categoryId)
        .in('status', ['active', 'finished']).order('created_at', { ascending: false }).limit(1).single(),
      supabase.from('checkpoints').select('id, name, km_marker')
        .eq('event_id', eventId).neq('private', true).order('km_marker'),
      supabase.from('checkpoint_categories').select('checkpoint_id, category_id')
        .eq('category_id', categoryId),
    ])

    if (catRes.data) setCategory(catRes.data)
    if (cpRes.data) {
      // Filter checkpoints: include those assigned to this category or with no category restriction
      const linkedCpIds = new Set((cpCatRes.data || []).map(l => l.checkpoint_id))
      const allCpCatRes = await supabase.from('checkpoint_categories').select('checkpoint_id')
        .in('checkpoint_id', cpRes.data.map(c => c.id))
      const restrictedCpIds = new Set((allCpCatRes.data || []).map(l => l.checkpoint_id))
      const filtered = cpRes.data.filter(c => !restrictedCpIds.has(c.id) || linkedCpIds.has(c.id))
      setCheckpoints(filtered)
      checkpointsRef.current = filtered
    }

    const run = runRes.data
    // PGRST116 is .single() finding no started run: genuinely nothing to show.
    // Any other error is an overloaded API, so try again rather than go blank.
    if (runRes.error && runRes.error.code !== 'PGRST116') { retryRef.current.trigger(); return }
    if (!run) { setLoaded(true); return }
    setRaceRun(run)

    const [resultRows, participantRows] = await Promise.all([
      supabase.from('results').select('id, race_run_id, participant_id, start_time, finish_time, duration_ms, gun_duration_ms, status').eq('race_run_id', run.id),
      supabase.from('participants_public').select('id, bib_number, first_name, last_name, club, category_id, emoji, gender, deleted_at').eq('category_id', categoryId),
    ])

    if (resultRows.error || participantRows.error) { retryRef.current.trigger(); return }

    const pMap = Object.fromEntries((participantRows.data || []).map(p => [p.id, {
      ...p, firstName: p.first_name, lastName: p.last_name, bibNumber: p.bib_number, gender: p.gender, deleted_at: p.deleted_at,
    }]))
    pMapRef.current = pMap

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
    setLoaded(true)

    if (cpRes.data?.length) {
      const cpIds = checkpointsRef.current.map(c => c.id)
      // observed_at >= run.started_at is REQUIRED, not an over-cautious guard: a
      // runner cannot have reached a mid-course checkpoint before the gun, so an
      // earlier observation is a ghost read (agent armed pre-start, or a leftover
      // from a previous attempt at the race) and must never be rendered as a
      // checkpoint split.
      //
      // Do NOT "fix" a missing checkpoint time by widening or removing this
      // window — that was tried on 2026-08-07 and it made the results page show
      // 5 runners as having passed 5 km before the race began. If an observation
      // is missing here, the bug is upstream: checkpoint_observations is
      // UNIQUE(checkpoint_id, bib_number) for the WHOLE event with no
      // race_run_id, and trg_checkpoint_obs_priority drops any later insert for
      // that pair — so one pre-start ghost read permanently occupies the slot and
      // the runner's real pass can never be recorded. Fix the scoping, not the view.
      const { data: obsData } = await supabase.from('checkpoint_observations')
        .select('id, checkpoint_id, participant_id, bib_number, observed_at')
        .in('checkpoint_id', cpIds)
        .gte('observed_at', run.started_at)
      // Filter out observations from participants in other categories
      setObservations((obsData || []).filter(o =>
        !o.participant_id || pMap[o.participant_id]
      ).map(o => ({
        ...o,
        checkpointId: o.checkpoint_id,
        participantId: o.participant_id,
        bibNumber: o.bib_number,
        observedAt: o.observed_at,
      })))
    }
  }, [eventId, categoryId])

  loadDataRef.current = loadData
  useEffect(() => () => retryRef.current.cancel(), [])

  useEffect(() => { loadData() }, [loadData])

  useEffect(() => {
    if (!raceRun?.id) return

    // A change carries the whole row, so it is applied in place. Only a runner
    // this page has not loaded yet costs a reload, and a burst of those costs
    // one, spread over 10–15 s so the open tabs do not all ask at once.
    const reload = coalesce(loadData, 10000, 5000)
    const channel = supabase.channel(`public-results-${categoryId}-${raceRun.id}-${instanceId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'results',
        filter: `race_run_id=eq.${raceRun.id}` }, (payload) => {
          if (!canApplyResultChange(payload, pMapRef.current)) { reload.trigger(); return }
          setResults(prev => applyResultChange(prev, payload, pMapRef.current) ?? prev)
        })
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

    return () => { reload.cancel(); supabase.removeChannel(channel) }
  }, [raceRun?.id, categoryId, loadData, instanceId])

  return { category, raceRun, results, checkpoints, observations, loaded }
}
