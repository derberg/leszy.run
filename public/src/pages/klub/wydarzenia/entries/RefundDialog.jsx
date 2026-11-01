import { useId, useState } from 'react'
import { formatPln } from '@registration/money.js'
import { parsePriceGrosze } from '@registration/sections.js'
import { callFunction } from '../../../../lib/auth.js'
import { btnDanger, btnPrimary } from '../../settingsUi.js'
import EntryDialog, { FieldMessage, dialogInput } from './EntryDialog.jsx'

// „Zwróć wpłatę” (B3): one row per paid order line of the entry, each with its own amount. Every
// line is one organizer-refund call with a requestKey made when the dialog opened, so a call
// repeated after a lost answer is a replay, never a second refund (D6-18). The server answers 200
// with the refund's state once dpay took the request; `unknown` leaves the money reserved and the
// row reads „ZWROT NIEPOTWIERDZONY”. Refunding the whole remaining entry amount cancels the entry,
// for a captain the whole team.

const LINE_NAME = { entry: 'Opłata startowa', extra: 'Dodatek', donation: 'Darowizna' }
// dpay's final refusals: the refund row under that key is settled for good, so a retry needs a new
// key (a replay would answer the same refusal forever). Any other failure keeps the key: the
// request may have gone through, and the same key replays it.
const SETTLED_REFUSALS = new Set(['rejected', 'insufficient_balance'])

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

/**
 * @param {{ row: object, team: object|null, onClose: () => void, onDone: (notice: object) => void,
 *   onFailed: () => void }} props
 *   `team`: the team when the row is its captain (a full refund cancels the team).
 */
export default function RefundDialog({ row, team, onClose, onDone, onFailed }) {
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
    </EntryDialog>
  )
}
