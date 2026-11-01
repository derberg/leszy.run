import { useState } from 'react'
import { formatPln } from '@registration/money.js'
import { callFunction } from '../../../../lib/auth.js'
import { btnDanger } from '../../settingsUi.js'
import EntryDialog from './EntryDialog.jsx'

// „Anuluj zgłoszenie” / „Anuluj nieopłacone zgłoszenie” (B3): organizer-entry-action cancel. An
// unpaid entry cancels its whole order and refunds nothing (D6-16, D6-24); a captain takes the
// whole team; a paid entry is cancelled without a refund, which the dialog states as an amount.

export default function CancelDialog({ row, team, onClose, onDone, onFailed }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const unpaid = row.statusKey === 'awaiting'
  const kept = row.paidAmount > 0 ? row.paidAmount - row.refunded : 0
  const title = team ? 'Anulować drużynę?' : unpaid ? 'Anulować nieopłacone zgłoszenie?' : 'Anulować zgłoszenie?'
  const subtitle = team ? `${team.name} · ${team.size} os.` : `${row.name} · ${row.competition}`

  async function cancel() {
    setBusy(true)
    setError(null)
    try {
      await callFunction('organizer-entry-action', { action: 'cancel', registrationId: row.id })
      onDone({ text: `Anulowano — ${team ? team.name : row.name}.` })
    } catch (err) {
      setError(err.status == null ? 'Brak połączenia.' : err.message)
      setBusy(false)
      onFailed()
    }
  }

  return (
    <EntryDialog testId="cancel-dialog" title={title} subtitle={subtitle} busy={busy} onClose={onClose} error={error} closeLabel="Nie"
      actions={(
        <button type="button" className={btnDanger} disabled={busy} onClick={cancel}>
          {team ? 'Anuluj drużynę' : unpaid ? 'Anuluj nieopłacone zgłoszenie' : 'Anuluj zgłoszenie'}
        </button>
      )}>
      {kept > 0 && <p className="font-mono text-sm text-apex-red" data-testid="cancel-no-refund">BEZ ZWROTU · {formatPln(kept)}</p>}
    </EntryDialog>
  )
}
