// Arms the checkpoint pipeline on the ACTUAL start of the race, not a clock
// time or the event's calendar date. Signal: any race_run belonging to one of
// the event's categories has gone 'active' (or already 'finished' — covers
// the agent booting after the gun). Multi-wave events arm at the EARLIEST
// start (any matching row is enough — we don't need to know which one).
//
// Errors (network blip, RLS hiccup, malformed response) must never crash the
// poll loop and must never falsely arm — check() returns false and the next
// tick tries again.
export function createArmer({ supabase, eventId, pollMs = 15000 }) {
  let timer = null

  async function check() {
    try {
      const catRes = await supabase.from('categories').select('id').eq('event_id', eventId)
      if (catRes.error) return false
      const ids = (catRes.data ?? []).map((c) => c.id)
      if (ids.length === 0) return false
      const runRes = await supabase.from('race_runs').select('id').in('category_id', ids).in('status', ['active', 'finished'])
      if (runRes.error) return false
      return (runRes.data ?? []).length > 0
    } catch {
      return false
    }
  }

  function start(onArmed) {
    if (timer) return
    timer = setInterval(async () => {
      const armed = await check()
      if (armed) {
        stop()
        onArmed()
      }
    }, pollMs)
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null }
  }

  return { check, start, stop }
}
