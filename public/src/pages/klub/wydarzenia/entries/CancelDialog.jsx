import { useState } from 'react'
import { formatPln } from '@registration/money.js'
import { callFunction } from '../../../../lib/auth.js'
import { btnDanger } from '../../settingsUi.js'
import EntryDialog from './EntryDialog.jsx'

// „Anuluj zgłoszenie” / „Anuluj nieopłacone zgłoszenie” / „Anuluj drużynę” (B3):
// organizer-entry-action cancel. An unpaid entry cancels its whole order and refunds nothing
// (D6-16, D6-24), so with more than one person in that order the dialog names every one of them
// (ruling 6); a captain takes the whole team; a paid entry is cancelled without a refund, which the
// dialog states as an amount.

/**
 * @param {{ row: object, team: object|null, orderRows: object[], onClose: () => void,
 *   onDone: (notice: object) => void, onFailed: () => void }} props
 *   `orderRows`: the live rows of the order an unpaid row belongs to, the row itself included.
 */
export default function CancelDialog({ row, team, orderRows = [row], onClose, onDone, onFailed }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const unpaid = row.statusKey === 'awaiting'
  const group = !team && unpaid && orderRows.length > 1 ? orderRows : null
  const kept = row.paidAmount > 0 ? row.paidAmount - row.refunded : 0
  const title = team ? 'Anulować drużynę?'
    : group ? `Anulować nieopłacone zamówienie (${group.length} os.)?`
      : unpaid ? 'Anulować nieopłacone zgłoszenie?' : 'Anulować zgłoszenie?'
  const subtitle = team ? `${team.name} · ${team.size} os.` : group ? null : `${row.name} · ${row.competition}`
  const action = team ? 'Anuluj drużynę'
    : group ? `Anuluj zamówienie (${group.length} os.)`
      : unpaid ? 'Anuluj nieopłacone zgłoszenie' : 'Anuluj zgłoszenie'

  async function cancel() {
    setBusy(true)
    setError(null)
    try {
      await callFunction('organizer-entry-action', { action: 'cancel', registrationId: row.id })
      onDone({ text: `Anulowano — ${team ? team.name : group ? group.map((r) => r.name).join(', ') : row.name}.` })
    } catch (err) {
      setError(err.status == null ? 'Brak połączenia.' : err.message)
      setBusy(false)
      onFailed()
    }
  }

  return (
    <EntryDialog testId="cancel-dialog" title={title} subtitle={subtitle} busy={busy} onClose={onClose} error={error} closeLabel="Nie"
      actions={<button type="button" className={btnDanger} disabled={busy} onClick={cancel}>{action}</button>}>
      {group && (
        <ul className="flex flex-col border-t border-apex-border" data-testid="cancel-people">
          {group.map((r) => (
            <li key={r.id} className="py-2 border-b border-apex-border font-sans text-base text-apex-text-bright break-words">
              {r.name} · {r.competition}
            </li>
          ))}
        </ul>
      )}
      {kept > 0 && <p className="font-mono text-sm text-apex-red" data-testid="cancel-no-refund">BEZ ZWROTU · {formatPln(kept)}</p>}
    </EntryDialog>
  )
}
