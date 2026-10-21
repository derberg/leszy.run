// One JSON document per event holds everything the public results page shows.
// `api/results.js` builds it on Vercel, the CDN serves it to every viewer, and
// the views below cut it into what each part of the page reads.

const PAGE = 1000

// A run that has started. A cancelled restart keeps its rows, and they must not
// be shown.
const SHOWN = new Set(['active', 'finished'])

// PostgREST answers at most 1000 rows whatever the query asks for, so a bigger
// table is read in pages. The query orders by a unique key, or a page boundary
// can skip or repeat a row.
async function readAll(query) {
  const rows = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await query().range(from, from + PAGE - 1)
    if (error) throw new Error(error.message)
    rows.push(...data)
    if (data.length < PAGE) return rows
  }
}

/**
 * Reads one event's public results from Supabase. The anon key can read more
 * than the page shows, so everything the page does not show is left out here:
 * the document is pushed into every viewer's browser and the CDN.
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase - an anon client
 * @param {string} eventId
 */
export async function buildResultsSnapshot(supabase, eventId) {
  const [allCategories, allCheckpoints] = await Promise.all([
    // The tabs follow the order the organizer created the categories in.
    readAll(() => supabase.from('categories').select('id, name, untimed')
      .eq('event_id', eventId).order('created_at').order('id')),
    readAll(() => supabase.from('checkpoints').select('id, name, km_marker, private, is_near_finish')
      .eq('event_id', eventId).order('id')),
  ])
  // An untimed category has no times or places, so the results page has
  // nothing to show for it. A timed kids' category shows like any other.
  const categories = allCategories.filter(c => !c.untimed).map(c => ({ id: c.id, name: c.name }))
  // A private checkpoint holds volunteer entries only operators review, such as
  // the manual finish. The near-finish checkpoint stays even when private,
  // because "Blisko Mety" lists the passes there.
  const checkpoints = allCheckpoints.filter(c => !c.private || c.is_near_finish)
  const categoryIds = categories.map(c => c.id)
  const checkpointIds = checkpoints.map(c => c.id)

  const [raceRuns, participants, checkpointCategories, allObservations] = await Promise.all([
    categoryIds.length ? readAll(() => supabase.from('race_runs')
      .select('id, status, category_id, started_at, created_at')
      .in('category_id', categoryIds).order('id')) : [],
    categoryIds.length ? readAll(() => supabase.from('participants_public')
      .select('id, bib_number, first_name, last_name, club, category_id, emoji, gender, deleted_at')
      .in('category_id', categoryIds).order('id')) : [],
    checkpointIds.length ? readAll(() => supabase.from('checkpoint_categories')
      .select('checkpoint_id, category_id')
      .in('checkpoint_id', checkpointIds).order('checkpoint_id').order('category_id')) : [],
    checkpointIds.length ? readAll(() => supabase.from('checkpoint_observations')
      .select('id, checkpoint_id, participant_id, bib_number, observed_at')
      .in('checkpoint_id', checkpointIds).order('id')) : [],
  ])

  const shownRuns = raceRuns.filter(r => SHOWN.has(r.status))
  const runIds = shownRuns.map(r => r.id)
  const results = runIds.length ? await readAll(() => supabase.from('results')
    .select('id, race_run_id, participant_id, start_time, finish_time, duration_ms, gun_duration_ms, status')
    .in('race_run_id', runIds).order('id')) : []

  // Nobody passes a checkpoint before the first gun of the event. categoryView
  // applies each category's own gun on top of this.
  const guns = shownRuns.map(r => Date.parse(r.started_at)).filter(Number.isFinite)
  const firstGun = guns.length ? Math.min(...guns) : null
  const observations = firstGun === null ? []
    : allObservations.filter(o => Date.parse(o.observed_at) >= firstGun)

  return { categories, checkpoints, checkpointCategories, raceRuns, participants, results, observations }
}

/** Whether a run of the event is under way, so the page needs fresh data often. */
export function isLive(snapshot) {
  return snapshot.raceRuns.some(r => r.status === 'active')
}

const EMPTY_CATEGORY = { category: null, raceRun: null, results: [], checkpoints: [], observations: [], loaded: false }

/**
 * The category's latest started run.
 * @param {Array} raceRuns
 * @param {string} categoryId
 */
export function latestRun(raceRuns, categoryId) {
  return raceRuns
    .filter(r => r.category_id === categoryId && SHOWN.has(r.status))
    .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))[0] || null
}

/**
 * The public checkpoints a category passes, by km. A checkpoint linked to no
 * category is passed by all of them.
 */
function categoryCheckpoints(snapshot, categoryId) {
  const restricted = new Set(snapshot.checkpointCategories.map(l => l.checkpoint_id))
  const linked = new Set(snapshot.checkpointCategories
    .filter(l => l.category_id === categoryId).map(l => l.checkpoint_id))
  return snapshot.checkpoints
    .filter(c => !c.private && (!restricted.has(c.id) || linked.has(c.id)))
    .sort((a, b) => (a.km_marker ?? Infinity) - (b.km_marker ?? Infinity))
    .map(c => ({ id: c.id, name: c.name, km_marker: c.km_marker }))
}

/**
 * What one category section shows.
 * @param {object|null} snapshot - null until the first snapshot arrives
 * @param {string} categoryId
 * @returns {{ category, raceRun, results, checkpoints, observations, loaded: boolean }}
 */
export function categoryView(snapshot, categoryId) {
  if (!snapshot || !categoryId) return EMPTY_CATEGORY
  const cat = snapshot.categories.find(c => c.id === categoryId)
  const category = cat ? { id: cat.id, name: cat.name } : null
  const checkpoints = categoryCheckpoints(snapshot, categoryId)
  const run = latestRun(snapshot.raceRuns, categoryId)
  if (!run) return { category, raceRun: null, results: [], checkpoints, observations: [], loaded: true }

  const pMap = Object.fromEntries(snapshot.participants
    .filter(p => p.category_id === categoryId)
    .map(p => [p.id, { ...p, firstName: p.first_name, lastName: p.last_name, bibNumber: p.bib_number }]))

  const results = snapshot.results
    .filter(r => r.race_run_id === run.id)
    .map(r => ({
      ...r,
      participantId: r.participant_id,
      startTime: r.start_time,
      finishTime: r.finish_time,
      durationMs: r.duration_ms,
      gunDurationMs: r.gun_duration_ms,
      participant: pMap[r.participant_id],
    }))
    // estimatePositions keeps the input order for runners it cannot tell
    // apart, such as DNS runners with no times. Sorting by bib makes that
    // order fixed and easy to scan.
    .sort((a, b) => (a.participant?.bibNumber ?? Infinity) - (b.participant?.bibNumber ?? Infinity) || a.id.localeCompare(b.id))

  // observed_at >= run.started_at is REQUIRED, not an over-cautious guard: a
  // runner cannot have reached a mid-course checkpoint before the gun, so an
  // earlier observation is a ghost read (agent armed pre-start, or a leftover
  // from a previous attempt at the race) and must never be rendered as a
  // checkpoint split.
  //
  // Do NOT "fix" a missing checkpoint time by widening or removing this
  // window. That was tried on 2026-08-07 and it made the results page show
  // 5 runners as having passed 5 km before the race began. If an observation
  // is missing here, the bug is upstream: checkpoint_observations is
  // UNIQUE(checkpoint_id, bib_number) for the WHOLE event with no
  // race_run_id, and trg_checkpoint_obs_priority drops any later insert for
  // that pair, so one pre-start ghost read permanently occupies the slot and
  // the runner's real pass can never be recorded. Fix the scoping, not the view.
  const gun = run.started_at ? Date.parse(run.started_at) : null
  const cpIds = new Set(checkpoints.map(c => c.id))
  const observations = gun === null ? [] : snapshot.observations
    .filter(o => cpIds.has(o.checkpoint_id) && Date.parse(o.observed_at) >= gun)
    // An observation of a runner from another category belongs to their section.
    .filter(o => !o.participant_id || pMap[o.participant_id])
    .map(o => ({
      ...o,
      checkpointId: o.checkpoint_id,
      participantId: o.participant_id,
      bibNumber: o.bib_number,
      observedAt: o.observed_at,
    }))

  return { category, raceRun: run, results, checkpoints, observations, loaded: true }
}

/**
 * What "Blisko Mety" reads: the observations at the near-finish checkpoint,
 * the event's participants, and the results of its started runs.
 */
export function nearFinishInputs(snapshot, checkpointId) {
  return {
    observations: snapshot.observations.filter(o => o.checkpoint_id === checkpointId),
    participants: snapshot.participants,
    results: snapshot.results,
  }
}
