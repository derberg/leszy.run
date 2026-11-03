import { useId, useState } from 'react'
import { dpayFee, formatPln } from '@registration/money.js'
import { parsePriceGrosze } from '@registration/sections.js'
import { callFunction } from '../../../../lib/auth.js'
import { btnDanger, btnPrimary } from '../../settingsUi.js'
import EntryDialog, { FieldMessage, dialogInput } from './EntryDialog.jsx'

// „Zwróć wpłatę” (B3): one row per paid order line of the entry, each with its own amount. Every
// line is one organizer-refund call with a requestKey made when the dialog opened, so a call
// repeated after a lost answer is a replay, never a second refund (D6-18). The server answers 200
// with the refund's state once dpay took the request; `unknown` leaves the money reserved and the
// row reads „ZWROT NIEPOTWIERDZONY”. Refunding the whole remaining entry amount cancels the entry,
// for a captain the whole team. The runner always gets the amount typed; dpay's commission on the
// payment and on each refund call is LESZY.RUN's cost, invoiced to the organizer (agreement §8),
// so the dialog only shows it, and leaves the invoice unsaid on a charity event.

const LINE_NAME = { entry: 'Opłata startowa', extra: 'Dodatek', donation: 'Darowizna' }
// dpay's final refusals: the refund row under that key is settled for good, so a retry needs a new
// key (a replay would answer the same refusal forever). Any other failure keeps the key: the
// request may have gone through, and the same key replays it.
const SETTLED_REFUSALS = new Set(['rejected', 'insufficient_balance', 'refund_blocked'])

const remainingOf = (line) => line.amount - line.refunded
const newKey = () => crypto.randomUUID()

/** The amount typed for one line → grosze, 0 for an empty field, or an error message. */
function amountOf(text, max) {
  if (!text.trim()) return { grosze: 0 }
  const grosze = parsePriceGrosze(text)
  if (grosze == null || grosze <= 0) return { error: 'Podaj kwotę zwrotu.' }
  if (grosze > max) return { error: `Kwota przekracza możliwą do zwrotu: ${formatPln(max)}.` }
  return { grosze }
}

/** dpay's commission behind a refund: on the entry's payment, and on each line's own refund call. */
function feeNote(row, parsed, charity) {
  const refundFee = Object.values(parsed).reduce((n, p) => n + (p.grosze ? dpayFee(p.grosze) : 0), 0)
  const note = `Prowizja operatora płatności: ${formatPln(dpayFee(row.paidAmount ?? 0))} za wpłatę + ${formatPln(refundFee)} za zwrot. Zawodnik dostaje pełną kwotę zwrotu`
  return charity ? `${note}.` : `${note}, prowizję doliczamy do faktury LESZY.RUN.`
}

/**
 * @param {{ row: object, team: object|null, charity?: boolean, onClose: () => void, onDone: (notice: object) => void,
 *   onFailed: () => void }} props
 *   `team`: the team when the row is its captain (a full refund cancels the team).
 *   `charity`: the event is a charity event (the fee note names no invoice).
 */
export default function RefundDialog({ row, team, charity = false, onClose, onDone, onFailed }) {
  const ids = useId()
  const lines = row.lines ?? []
  const [amounts, setAmounts] = useState(() => Object.fromEntries(lines.map((l) => [l.id, ''])))
  const [keys, setKeys] = useState(() => Object.fromEntries(lines.map((l) => [l.id, newKey()])))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const parsed = Object.fromEntries(lines.map((l) => [l.id, amountOf(amounts[l.id] ?? '', remainingOf(l))]))
  const invalid = Object.values(parsed).some((p) => p.error)
  const total = Object.values(parsed).reduce((n, p) => n + (p.grosze ?? 0), 0)
  // The entry line refunded to its last grosz cancels the entry (finish_organizer_refund), counted
  // on accepted refunds only: while one is unconfirmed, the last grosz cancels nothing yet.
  const cancels = !(row.refundUnconfirmed > 0) && lines.some((l) => l.kind === 'entry' && remainingOf(l) > 0 && parsed[l.id].grosze === remainingOf(l))
  const label = `Zwróć ${formatPln(total)}${cancels ? (team ? ` i anuluj drużynę (${team.size} os.)` : ' i anuluj zgłoszenie') : ''}`

  async function refund() {
    setBusy(true)
    setError(null)
    let refunded = 0
    let unconfirmed = false
    const done = []
    let current = null
    try {
      for (const line of lines) {
        const grosze = parsed[line.id].grosze ?? 0
        if (!grosze) continue
        current = line.id
        const r = await callFunction('organizer-refund', { lineId: line.id, grosze, requestKey: keys[line.id], registrationId: row.id })
        done.push(line.id)
        if (r.data?.status === 'unknown') {
          unconfirmed = true
          break
        }
        refunded += grosze
      }
    } catch (err) {
      // What went through is done: those lines get a fresh key, the list is re-read and the
      // dialog stays open on the refusal.
      const fresh = SETTLED_REFUSALS.has(err.code) ? [...done, current] : done
      setKeys((k) => ({ ...k, ...Object.fromEntries(fresh.map((id) => [id, newKey()])) }))
      setAmounts((a) => ({ ...a, ...Object.fromEntries(done.map((id) => [id, ''])) }))
      setError(err.status == null ? 'Brak połączenia.' : err.message)
      setBusy(false)
      onFailed()
      return
    }
    // An unconfirmed line stops the rest; what went through before it is said too.
    onDone(unconfirmed
      ? { text: `${refunded > 0 ? `Zwrócono ${formatPln(refunded)}. ` : ''}Zwrot niepotwierdzony — ${row.name}.`, error: true }
      : { text: `Zwrócono ${formatPln(refunded)} — ${row.name}.` })
  }

  return (
    <EntryDialog testId="refund-dialog" title="Zwróć wpłatę" subtitle={team ? `${team.name} · ${team.size} os.` : row.name}
      busy={busy} onClose={onClose} error={error} wide
      actions={(
        <button type="button" className={cancels ? btnDanger : btnPrimary} disabled={busy || invalid || total === 0} onClick={refund}>
          {label}
        </button>
      )}>
      <ul className="flex flex-col">
        {lines.map((line, i) => {
          const max = remainingOf(line)
          const inputId = `${ids}-${i}`
          const err = parsed[line.id].error
          const name = [LINE_NAME[line.kind] ?? line.kind, row.competition, formatPln(line.amount)]
          if (line.refunded > 0) name.push(`zwrócono ${formatPln(line.refunded)}`)
          return (
            <li key={line.id} className="py-3 border-b border-apex-border flex flex-col gap-2 min-w-0" data-testid="refund-line">
              <span className="font-sans text-base text-apex-text-bright break-words">{name.join(' · ')}</span>
              {max > 0 && (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <label htmlFor={inputId} className="sr-only">Kwota zwrotu — {name[0]}</label>
                  <span className="flex items-center gap-2">
                    <input id={inputId} inputMode="decimal" autoComplete="off" value={amounts[line.id]} disabled={busy}
                      aria-invalid={err ? 'true' : undefined} aria-describedby={`${inputId}-max${err ? ` ${inputId}-err` : ''}`}
                      onChange={(e) => setAmounts({ ...amounts, [line.id]: e.target.value })}
                      className={`${dialogInput} w-32 font-mono text-right`} />
                    <span className="font-mono text-apex-muted">zł</span>
                  </span>
                  <span id={`${inputId}-max`} className="font-mono text-sm text-apex-muted whitespace-nowrap">Maks. {formatPln(max)}</span>
                </div>
              )}
              <FieldMessage id={`${inputId}-err`} message={err} />
            </li>
          )
        })}
      </ul>
      {total > 0 && (
        <p className="font-sans text-sm text-apex-muted pt-3" data-testid="refund-fee">{feeNote(row, parsed, charity)}</p>
      )}
    </EntryDialog>
  )
}
