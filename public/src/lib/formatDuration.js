// Always H:MM:SS, hours included even when zero: a bare "47:18" reads like a
// clock time, and every time on this page is a duration.
export function formatDuration(ms) {
  if (ms == null) return '—'
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60
  return `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`
}
