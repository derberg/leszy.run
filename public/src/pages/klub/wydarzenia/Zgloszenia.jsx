import { useEffect, useState } from 'react'
import { callFunction } from '../../../lib/auth.js'
import { countPl, pluralPl } from '../../../lib/plural.js'

// The „Zgłoszenia” tab of a published event (A8): every registration, read
// only — imię i nazwisko, konkurencja, kategoria, regulamin, data zapisu — from
// list-event-registrations. Plan 6's panel (B3) replaces it. The editor mounts
// it (Task 8c); runner data is for the club's owner and admins only.
// Once anybody has paid or owes a payment, the header carries B3's counts
// („X opłaconych · Y czeka na wpłatę”, in the count's Polish form) and a „Płatność” column appears.
// Plan 4 task 6: the „Regulamin” column (each person's consent state), „Czeka na zgody: N” with
// a filter, and on a row still waiting „Przypomnij” (remind-consent) and „Podpisany w biurze”
// (mark-consent-office). Plan 6 moves the two buttons into the row's ⋯ menu.

const when = new Intl.DateTimeFormat('pl-PL', {
  timeZone: 'Europe/Warsaw', day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit',
})

const PAYMENT = { paid: 'opłacone', free: 'bez opłaty' }
const LIVE = new Set(['confirmed', 'pending_payment'])

function paymentText(r) {
  if (r.paymentStatus === 'awaiting') return r.expiresAt ? `czeka na wpłatę do ${when.format(new Date(r.expiresAt))}` : 'czeka na wpłatę'
  return PAYMENT[r.paymentStatus] ?? '—'
}

/** → [text, colour class] of the „Regulamin” cell. */
function consentCell(r) {
  if (!LIVE.has(r.status)) return ['—', 'text-apex-muted']
  if (r.consentState === 'awaiting') return ['czeka na zgodę', 'text-apex-cyan']
  if (r.consentState === 'office') return ['podpisany w biurze', 'text-apex-text-bright']
  if (r.role === 'minor') return ['✓ opiekun', 'text-apex-yellow']
  return ['✓ zaakceptowany', 'text-apex-yellow']
}

const waiting = (r) => r.status === 'confirmed' && r.consentState === 'awaiting'

const smallBtn = 'min-h-9 px-2.5 border font-sans font-bold text-sm whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed'
const remindBtn = `${smallBtn} border-apex-border-bright text-apex-text-bright hover:border-apex-yellow-dim`
const officeBtn = `${smallBtn} border-apex-yellow-dim text-apex-yellow hover:bg-apex-yellow hover:text-apex-ink`

function ConsentActions({ row, onOffice }) {
  const [busy, setBusy] = useState(null)
  const [reminded, setReminded] = useState(false)
  const [error, setError] = useState(null)

  async function run(kind) {
    setBusy(kind)
    setError(null)
    try {
      if (kind === 'remind') {
        await callFunction('remind-consent', { registrationId: row.id })
        setReminded(true)
      } else {
        await callFunction('mark-consent-office', { registrationId: row.id })
        onOffice(row.id)
      }
    } catch (err) {
      setError(err.status == null ? 'Brak połączenia.' : err.message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex gap-1.5">
        {reminded
          ? <span className="min-h-9 px-2.5 flex items-center font-mono text-xs uppercase text-apex-muted whitespace-nowrap" data-testid="reminded">Wysłano</span>
          : <button type="button" className={remindBtn} disabled={busy !== null} onClick={() => run('remind')}>Przypomnij</button>}
        <button type="button" className={officeBtn} disabled={busy !== null} onClick={() => run('office')}>Podpisany w biurze</button>
      </div>
      {error && <span className="text-apex-red text-xs" role="alert">{error}</span>}
    </div>
  )
}

export default function Zgloszenia({ eventId }) {
  const [state, setState] = useState({ status: 'loading', rows: [], counts: null })
  const [onlyWaiting, setOnlyWaiting] = useState(false)

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
  const awaitingConsent = counts?.awaitingConsent ?? state.rows.filter(waiting).length
  // The consent header appears once anybody was added by somebody else, and stays at 0 after the last one is settled.
  const consentHeader = awaitingConsent > 0 || state.rows.some((r) => r.role === 'adult')
  const actions = state.rows.some(waiting)
  const rows = onlyWaiting ? state.rows.filter(waiting) : state.rows

  function markedOffice(id) {
    setState((s) => ({
      ...s,
      rows: s.rows.map((r) => (r.id === id ? { ...r, consentState: 'office' } : r)),
      counts: s.counts ? { ...s.counts, awaitingConsent: Math.max(0, (s.counts.awaitingConsent ?? 0) - 1) } : s.counts,
    }))
  }

  return (
    <div className="flex flex-col gap-2 min-w-0 max-w-full">
      {payments && (
        <p className="font-mono text-xs uppercase text-apex-muted" data-testid="registrations-counts">
          <span className="text-apex-yellow">{countPl(counts.paid, ['opłacone', 'opłacone', 'opłaconych'])}</span> · <span className="text-apex-cyan">{counts.awaiting} {pluralPl(counts.awaiting, 'czeka', 'czekają', 'czeka')} na wpłatę</span>
          {counts.free > 0 && <> · {counts.free} bez opłaty</>}
          {counts.placesLeft != null && <> · <span className="text-apex-text-bright" data-testid="registrations-places-left">{countPl(counts.placesLeft, ['wolne miejsce', 'wolne miejsca', 'wolnych miejsc'])}</span></>}
        </p>
      )}
      {consentHeader && (
        <div className="flex flex-wrap items-center justify-between gap-2" data-testid="awaiting-consent">
          <span className={`font-mono text-xs uppercase ${awaitingConsent > 0 ? 'text-apex-cyan' : 'text-apex-muted'}`}>Czeka na zgody: {awaitingConsent}</span>
          <button type="button" aria-pressed={onlyWaiting} onClick={() => setOnlyWaiting((v) => !v)}
            className={`${smallBtn} ${onlyWaiting ? 'border-apex-yellow text-apex-yellow' : 'border-apex-border-bright text-apex-text'}`}>
            Tylko czekające
          </button>
        </div>
      )}
      <div className="relative border border-apex-border overflow-x-auto max-w-full" data-testid="registrations">
        <table className="w-full text-sm">
          <thead className="bg-apex-surface-2 font-mono text-[10px] tracking-widest uppercase text-apex-muted text-left">
            <tr>
              <th className="px-3 py-2 font-normal">Imię i nazwisko</th>
              <th className="px-3 py-2 font-normal">Konkurencja</th>
              <th className="px-3 py-2 font-normal">Kategoria</th>
              {payments && <th className="px-3 py-2 font-normal">Płatność</th>}
              <th className="px-3 py-2 font-normal">Regulamin</th>
              <th className="px-3 py-2 font-normal whitespace-nowrap">Data zapisu</th>
              {actions && <th className="px-3 py-2 font-normal"><span className="sr-only">Akcje</span></th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const [consentText, consentColour] = consentCell(r)
              const sub = r.role === 'minor'
                ? (r.guardianRemoved ? 'kontakt opiekuna usunięty' : r.guardianName ? `opiekun: ${r.guardianName}` : null)
                : r.registeredBy ? `zapisał(a): ${r.registeredBy}` : null
              return (
                <tr key={r.id} className="border-t border-apex-border align-top">
                  <td className="px-3 py-2.5">
                    <span className="block text-apex-text-bright font-semibold">{r.name}</span>
                    {sub && (
                      <span className={`block text-xs ${r.guardianRemoved ? 'text-apex-red' : 'text-apex-muted'}`}
                        data-testid={r.guardianRemoved ? 'guardian-removed' : 'registration-sub'}>{sub}</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5">{r.competition}</td>
                  <td className="px-3 py-2.5 font-mono">{r.ageGroupLabel}</td>
                  {payments && (
                    <td className={`px-3 py-2.5 font-mono whitespace-nowrap ${r.paymentStatus === 'paid' ? 'text-apex-yellow' : r.paymentStatus === 'awaiting' ? 'text-apex-cyan' : 'text-apex-muted'}`}
                      data-testid="registration-payment">
                      {paymentText(r)}
                    </td>
                  )}
                  <td className={`px-3 py-2.5 font-mono whitespace-nowrap ${consentColour}`} data-testid="registration-consent">{consentText}</td>
                  <td className="px-3 py-2.5 font-mono whitespace-nowrap">{when.format(new Date(r.createdAt))}</td>
                  {actions && (
                    <td className="px-3 py-2">{waiting(r) && <ConsentActions row={r} onOffice={markedOffice} />}</td>
                  )}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
