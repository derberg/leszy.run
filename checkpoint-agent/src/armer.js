// Arms the checkpoint pipeline on the ACTUAL start of the race, not a clock
// time or the event's calendar date. Signal: any race_run belonging to one of
// the event's categories has gone 'active' (or already 'finished' — covers
// the agent booting after the gun). Multi-wave events arm at the EARLIEST
// start (any matching row is enough — we don't need to know which one).
//
// Arming must also be REVOKED when that signal goes away. A race_run can be
// cancelled, or deleted outright (resetting test data between attempts). An
// agent that stays armed then keeps recording, and because
// checkpoint_observations is UNIQUE(checkpoint_id, bib_number) with a trigger
// that drops any later insert for that pair, those reads permanently occupy the
// runner's slot — so their real pass in the NEXT run can never be recorded.
// Observed 2026-08-07: 5 of 20 runners were left with a checkpoint observation
// timestamped before the gun of the run they actually ran, and no way to fix it.
//
// Errors (network blip, RLS hiccup, malformed response) must never crash the
// poll loop, never falsely arm, and — just as importantly — never falsely
// DISARM: dropping real reads mid-race because Supabase hiccuped would be worse
// than the bug above. Hence probe() distinguishes "definitely no run" from
// "could not tell", and watch() only acts on the former.
export function createArmer({ supabase, eventId, pollMs = 15000 }) {
  let timer = null

  // { ok: true, armed } when the answer is known; { ok: false } when it is not.
  async function probe() {
    try {
      const catRes = await supabase.from('categories').select('id').eq('event_id', eventId)
      if (catRes.error) return { ok: false }
      const ids = (catRes.data ?? []).map((c) => c.id)
      // No categories is a definite answer: there cannot be a run.
      if (ids.length === 0) return { ok: true, armed: false }
      const runRes = await supabase.from('race_runs').select('id').in('category_id', ids).in('status', ['active', 'finished'])
      if (runRes.error) return { ok: false }
      return { ok: true, armed: (runRes.data ?? []).length > 0 }
    } catch {
      return { ok: false }
    }
  }

  // Boolean convenience form: treats "could not tell" as not armed. Safe for a
  // one-shot pre-arm question, NOT for deciding to disarm.
  async function check() {
    const r = await probe()
    return r.ok ? r.armed : false
  }

  // Continuous watch. Calls onChange(armed) on every CONFIRMED transition away
  // from `initial`, and keeps polling in both directions — this is what makes
  // disarming possible. Pass the agent's current arm state as `initial` so a
  // freshly-restored armed session isn't re-announced.
  function watch(onChange, initial = false) {
    if (timer) return
    let current = initial
    timer = setInterval(async () => {
      const r = await probe()
      if (!r.ok) return                 // indeterminate — hold the current state
      if (r.armed === current) return
      current = r.armed
      onChange(r.armed)
    }, pollMs)
    timer.unref?.()
  }

  // One-shot form: fires once on arming and stops polling. Kept for callers that
  // genuinely only need "tell me when it starts".
  function start(onArmed) {
    if (timer) return
    timer = setInterval(async () => {
      const r = await probe()
      if (r.ok && r.armed) {
        stop()
        onArmed()
      }
    }, pollMs)
    timer.unref?.()
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null }
  }

  return { check, probe, watch, start, stop }
}
