import { clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs) {
  return twMerge(clsx(inputs))
}

export function formatDuration(ms) {
  if (!ms) return '—'
  const totalMs = Math.floor(ms)
  const totalSeconds = Math.floor(totalMs / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const millis = String(totalMs % 1000).padStart(3, '0')
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${millis}`
  return `${minutes}:${String(seconds).padStart(2, '0')}.${millis}`
}

export function formatDateTime(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 })
}

export function formatDate(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('pl-PL')
}

const STATUS_LABELS = {
  registered: 'Zarejestrowany',
  checked_in: 'Zameldowany',
  started: 'Na trasie',
  finished: 'Ukończony',
  dnf: 'DNF',
  dns: 'DNS',
  dsq: 'DSQ',
  pending: 'Oczekujący',
  active: 'Aktywny',
  cancelled: 'Anulowany',
}

export function statusLabel(status) {
  return STATUS_LABELS[status] || status
}

const STATUS_COLORS = {
  registered: 'bg-transparent text-apex-muted border-apex-border-bright',
  checked_in: 'bg-transparent text-apex-cyan border-apex-cyan',
  started: 'bg-transparent text-apex-cyan border-apex-cyan',
  finished: 'bg-transparent text-apex-yellow border-apex-yellow',
  dnf: 'bg-transparent text-amber-400 border-amber-500',
  dns: 'bg-transparent text-amber-500 border-amber-600',
  dsq: 'bg-transparent text-apex-red border-apex-red',
  pending: 'bg-transparent text-apex-muted border-apex-border-mid',
  active: 'bg-apex-yellow text-black border-apex-yellow',
  cancelled: 'bg-transparent text-apex-dim border-apex-border',
}

export function statusColor(status) {
  return STATUS_COLORS[status] || 'bg-transparent text-apex-muted border-apex-border-mid'
}
