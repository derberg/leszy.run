import { useEffect, useState } from 'react'
import { callFunction } from '../../../lib/auth.js'
import { countPl, pluralPl } from '../../../lib/plural.js'

// The „Zgłoszenia” tab of a published event (A8): every registration, read
// only — imię i nazwisko, konkurencja, kategoria, data zapisu — from
// list-event-registrations. Plan 6's panel (B3) replaces it. The editor mounts
// it (Task 8c); runner data is for the club's owner and admins only.
// Once anybody has paid or owes a payment, the header carries B3's counts
// („X opłaconych · Y czeka na wpłatę”, in the count's Polish form) and a „Płatność” column appears.

const when = new Intl.DateTimeFormat('pl-PL', {
  timeZone: 'Europe/Warsaw', day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit',
})

const PAYMENT = { paid: 'opłacone', free: 'bez opłaty' }

function paymentText(r) {
  if (r.paymentStatus === 'awaiting') return r.expiresAt ? `czeka na wpłatę do ${when.format(new Date(r.expiresAt))}` : 'czeka na wpłatę'
  return PAYMENT[r.paymentStatus] ?? '—'
}

export default function Zgloszenia({ eventId }) {
  const [state, setState] = useState({ status: 'loading', rows: [], counts: null })

  useEffect(() => {
    let active = true
    callFunction('list-event-registrations', { eventId })
      .then((r) => { if (active) setState({ status: 'ok', rows: r.data ?? [], counts: r.counts ?? null }) })
      .catch(() => { if (active) setState({ status: 'error', rows: [], counts: null }) })
    return () => { active = false }
  }, [eventId])

  if (state.status === 'loading') {
    return <div className="flex flex-col gap-1.5" aria-busy="true">{[0, 1, 2].map((i) => <div key={i} className="h-11 bg-apex-surface" />)}</div>
  }
  if (state.status === 'error') return <p className="text-apex-red text-sm">Nie udało się wczytać zgłoszeń.</p>
  if (state.rows.length === 0) return <p className="text-apex-muted text-sm" data-testid="registrations-empty">Brak zgłoszeń.</p>

  const counts = state.counts
  const payments = !!counts && counts.paid + counts.awaiting > 0

  return (
    <div className="flex flex-col gap-2">
      {payments && (
        <p className="font-mono text-xs uppercase text-apex-muted" data-testid="registrations-counts">
          <span className="text-apex-yellow">{countPl(counts.paid, ['opłacone', 'opłacone', 'opłaconych'])}</span> · <span className="text-apex-cyan">{counts.awaiting} {pluralPl(counts.awaiting, 'czeka', 'czekają', 'czeka')} na wpłatę</span>
          {counts.free > 0 && <> · {counts.free} bez opłaty</>}
          {counts.placesLeft != null && <> · <span className="text-apex-text-bright" data-testid="registrations-places-left">{countPl(counts.placesLeft, ['wolne miejsce', 'wolne miejsca', 'wolnych miejsc'])}</span></>}
        </p>
      )}
      <div className="border border-apex-border overflow-x-auto" data-testid="registrations">
        <table className="w-full text-sm">
          <thead className="bg-apex-surface-2 font-mono text-[10px] tracking-widest uppercase text-apex-muted text-left">
            <tr>
              <th className="px-3 py-2 font-normal">Imię i nazwisko</th>
              <th className="px-3 py-2 font-normal">Konkurencja</th>
              <th className="px-3 py-2 font-normal">Kategoria</th>
              {payments && <th className="px-3 py-2 font-normal">Płatność</th>}
              <th className="px-3 py-2 font-normal whitespace-nowrap">Data zapisu</th>
            </tr>
          </thead>
          <tbody>
            {state.rows.map((r) => (
              <tr key={r.id} className="border-t border-apex-border">
                <td className="px-3 py-2.5 text-apex-text-bright font-semibold">{r.name}</td>
                <td className="px-3 py-2.5">{r.competition}</td>
                <td className="px-3 py-2.5 font-mono">{r.ageGroupLabel}</td>
                {payments && (
                  <td className={`px-3 py-2.5 font-mono whitespace-nowrap ${r.paymentStatus === 'paid' ? 'text-apex-yellow' : r.paymentStatus === 'awaiting' ? 'text-apex-cyan' : 'text-apex-muted'}`}
                    data-testid="registration-payment">
                    {paymentText(r)}
                  </td>
                )}
                <td className="px-3 py-2.5 font-mono whitespace-nowrap">{when.format(new Date(r.createdAt))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
