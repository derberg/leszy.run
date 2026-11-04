import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { API_URL as API } from '../lib/apiOrigin.js'

// Growth at a glance: totals now, then the same figures month by month
// (Warsaw months, newest first) from GET /api/admin/stats.

const METRICS = [
  { key: 'users', total: 'users', label: 'Nowe konta',
    hint: 'Konta założone w miesiącu. Łącznie: konta, które nie zostały usunięte.' },
  { key: 'onboarded', total: 'onboarded', label: 'Z profilem',
    hint: 'Konta z wybraną nazwą użytkownika, czyli po onboardingu i akceptacji regulaminu. Liczone w miesiącu założenia konta.' },
  { key: 'clubs', total: 'clubs', label: 'Kluby',
    hint: 'Kluby założone w miesiącu.' },
  { key: 'clubJoins', total: 'clubMembers', label: 'Dołączenia do klubów', totalLabel: 'Członkowie klubów',
    hint: 'W miesiącu: dołączenia do klubów, bez założycieli, także osób, które potem odeszły. Łącznie: aktywni członkowie razem z właścicielami.' },
  { key: 'favorites', total: 'favorites', label: 'Gwiazdki',
    hint: 'Obserwowane biegi: gwiazdki w kalendarzu, także te dodane automatycznie po zapisie.' },
  { key: 'registrationEvents', total: 'registrationEvents', label: 'Wydarzenia z zapisami',
    hint: 'Wydarzenia z zapisami przez LESZY.RUN, liczone w miesiącu publikacji.' },
  { key: 'registrations', total: 'registrations', label: 'Zgłoszenia',
    hint: 'Potwierdzone zgłoszenia (opłacone lub darmowe) według dnia zapisu. Każdy członek drużyny liczy się osobno.' },
  { key: 'paidOrders', total: 'paidOrders', label: 'Opłacone zamówienia',
    hint: 'Zamówienia z wpłatą, według dnia wpłaty, bez zwróconych w całości. Także testowe.' },
  { key: 'paidAmount', total: 'paidAmount', label: 'Wpłaty', money: true,
    hint: 'Pieniądze, które zostały u organizatorów: wpłaty minus zwroty, w miesiącu wpłaty.' },
  { key: 'refundAmount', total: 'refundAmount', label: 'Zwroty', money: true,
    hint: 'Przyjęte przez dpay zwroty, w miesiącu zwrotu. Nie są wliczone w wpłaty.' },
]

const MONTH_LABEL = new Intl.DateTimeFormat('pl-PL', { month: 'long', year: 'numeric', timeZone: 'UTC' })
const monthLabel = (ym) => MONTH_LABEL.format(new Date(`${ym}-01T00:00:00Z`))
const pln = (grosze) => `${(grosze / 100).toLocaleString('pl-PL', { minimumFractionDigits: 0, maximumFractionDigits: 2 })} zł`
const fmt = (m, v) => (m.money ? pln(v) : v.toLocaleString('pl-PL'))

// Hover (or tap) a label to read what it counts. Fixed position, so the
// table's overflow container cannot clip it.
function Tip({ text, children, align = 'left' }) {
  const [pos, setPos] = useState(null)
  const show = (e) => {
    const r = e.currentTarget.getBoundingClientRect()
    const width = 256
    const left = align === 'right' ? r.right - width : r.left
    setPos({ top: r.bottom + 6, left: Math.max(8, Math.min(left, window.innerWidth - width - 8)) })
  }
  return (
    <span
      className="cursor-help underline decoration-dotted decoration-apex-dim underline-offset-4"
      onMouseEnter={show}
      onMouseLeave={() => setPos(null)}
      onClick={(e) => (pos ? setPos(null) : show(e))}
    >
      {children}
      {pos && (
        <span
          role="tooltip"
          style={{ top: pos.top, left: pos.left, width: 256 }}
          className="fixed z-50 block border border-apex-border-bright bg-apex-surface-2 px-3 py-2 font-sans text-xs normal-case tracking-normal font-normal text-apex-text text-left whitespace-normal shadow-lg"
        >
          {text}
        </span>
      )}
    </span>
  )
}

function Delta({ now, before }) {
  if (now === before) return null
  const up = now > before
  return (
    <span className={`font-mono text-[10px] ml-1.5 ${up ? 'text-apex-yellow' : 'text-apex-red'}`}>
      {up ? '▲' : '▼'}
    </span>
  )
}

export default function StatsPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['admin-stats'],
    queryFn: async () => {
      const res = await fetch(`${API}/api/admin/stats?months=12`)
      const body = await res.json()
      if (!res.ok) throw new Error(body.error || 'Nie udało się pobrać statystyk')
      return body.data
    },
  })

  const header = (
    <h1 className="font-display font-extrabold text-2xl text-apex-text-bright uppercase tracking-wider mb-6">Statystyki</h1>
  )

  if (error) return <div className="p-6 md:p-8">{header}<p className="text-apex-red font-mono text-sm">{error.message}</p></div>

  if (isLoading) {
    return (
      <div className="p-6 md:p-8 max-w-6xl">
        {header}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-8">
          {METRICS.map((m) => <div key={m.key} className="h-[86px] border border-apex-border bg-apex-surface animate-pulse" />)}
        </div>
        <div className="h-64 border border-apex-border bg-apex-surface animate-pulse" />
      </div>
    )
  }

  const { totals, months } = data
  const [current, previous] = months

  return (
    <div className="p-6 md:p-8 max-w-6xl">
      {header}

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-8">
        {METRICS.map((m) => (
          <div key={m.key} className="border border-apex-border bg-apex-surface p-3">
            <div className="font-display font-bold text-[11px] tracking-widest uppercase text-apex-muted truncate">
              <Tip text={m.hint}>{m.totalLabel || m.label}</Tip>
            </div>
            <div className="font-mono text-2xl text-apex-text-bright mt-1">{fmt(m, totals[m.total])}</div>
            <div className="font-mono text-[11px] text-apex-muted mt-1">
              {monthLabel(current.month).split(' ')[0]}: <span className="text-apex-yellow">+{fmt(m, current[m.key])}</span>
              <Delta now={current[m.key]} before={previous?.[m.key] ?? 0} />
            </div>
          </div>
        ))}
      </div>

      <h2 className="font-display font-bold text-xs tracking-widest uppercase text-apex-muted border-b border-apex-border pb-1 mb-3">
        Miesiące
      </h2>
      <div className="overflow-x-auto border border-apex-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-apex-surface">
              <th className="text-left font-display font-bold text-[11px] tracking-widest uppercase text-apex-muted px-3 py-2 whitespace-nowrap">Miesiąc</th>
              {METRICS.map((m) => (
                <th key={m.key} className="text-right font-display font-bold text-[11px] tracking-widest uppercase text-apex-muted px-3 py-2 whitespace-nowrap">
                  <Tip text={m.hint} align="right">{m.label}</Tip>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {months.map((row, i) => (
              <tr key={row.month} className={`border-t border-apex-border ${i === 0 ? 'bg-apex-yellow/5' : ''}`}>
                <td className="px-3 py-2 text-apex-text-bright whitespace-nowrap">{monthLabel(row.month)}</td>
                {METRICS.map((m) => (
                  <td key={m.key} className={`px-3 py-2 text-right font-mono whitespace-nowrap ${row[m.key] ? 'text-apex-text-bright' : 'text-apex-dim'}`}>
                    {row[m.key] ? fmt(m, row[m.key]) : '·'}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
