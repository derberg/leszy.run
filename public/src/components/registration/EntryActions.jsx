import { useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { formatPln } from '@registration/money.js'
import { transferAction } from '../../lib/transferCopy.js'
import ChangeMyCompetitionDialog from './ChangeMyCompetitionDialog.jsx'
import EditMyDataDialog from './EditMyDataDialog.jsx'

// The runner's own actions under one entry, on „Moje zapisy” (/profil/zapisy) and RA5 (Zapisano):
// one row, in this order, each only where the server says so:
// - „Zmień konkurencję →” / „Popraw dane →”: `actions` (the club's switches, before closes_at, never
//   for a team member; a captain only edits; selfService.js);
// - „Przekaż pakiet →” to RA6: the `transfer` block (the session's own adult entry or a team's as
//   captain, transfers on, today ≤ the organizer's last day, no refund in flight; transferViews in
//   transfers.js), with „Czeka na <adres>” under the row while an invite is open.
// An open competition-change surcharge reads „Dopłata czeka: X zł — Zapłać” above the row. A change
// that needs a surcharge opens its order page to pay at once; any other change or edit reads the
// list again (`onChanged`) and says what happened here.
// Right-aligned; under 640 px the actions stack one per line, still right-aligned, so they sit on
// the same edge as the card's other links („Zamówienie →”, „Twój zapis →”).

const ACTION = 'whitespace-nowrap text-base font-bold text-apex-yellow hover:text-apex-yellow-bright underline-offset-2 hover:underline'

const variants = {
  // /profil/zapisy: a compact list.
  compact: {
    box: 'mt-1.5',
    text: 'font-mono text-[11px]',
    pay: 'whitespace-nowrap font-mono text-[11px] text-apex-yellow hover:text-apex-yellow-bright underline-offset-2 hover:underline',
  },
  // RA5: under a person's card.
  card: {
    box: 'pt-2.5 mt-2.5 border-t border-apex-border',
    text: 'text-sm',
    pay: ACTION,
  },
}

/**
 * @param {{ entry: { id: string, name: string, competition: string|null, actions?: { change: boolean, edit: boolean },
 *   transfer?: { allowed: boolean, pending: { toEmail: string } | null } | null,
 *   surcharge?: { orderId: string, toCompetition: string|null, grosze: number } | null },
 *   slug?: string|null, onChanged: () => void, variant?: 'compact' | 'card' }} p
 */
export default function EntryActions({ entry, slug = null, onChanged, variant = 'compact' }) {
  const v = variants[variant]
  const navigate = useNavigate()
  const [dialog, setDialog] = useState(null)
  const [notice, setNotice] = useState(null)
  const opener = useRef(null)
  const actions = entry.actions ?? { change: false, edit: false }
  const s = entry.surcharge ?? null
  const transfer = slug ? transferAction(entry, slug) : null
  if (!actions.change && !actions.edit && !transfer && !s && !notice) return null

  const open = (kind) => (e) => {
    opener.current = e.currentTarget
    setNotice(null)
    setDialog(kind)
  }
  const close = () => {
    setDialog(null)
    opener.current?.focus()
  }
  const done = (r) => {
    setDialog(null)
    if (r.surchargeOrderId) {
      navigate(`/zamowienie/${r.surchargeOrderId}`)
      return
    }
    setNotice(r)
    onChanged()
  }
  const arrow = <span aria-hidden="true"> →</span>

  return (<>
    <div className={`${v.box} flex flex-col items-end gap-1 text-right`} data-testid="self-service">
      {s && (
        <span className={`${v.text} text-apex-cyan-text [overflow-wrap:anywhere]`} data-testid="self-surcharge">
          Dopłata czeka: {formatPln(s.grosze)}{s.toCompetition ? ` (${s.toCompetition})` : ''} —{' '}
          <Link to={`/zamowienie/${s.orderId}`} className={v.pay}>Zapłać</Link>
        </span>
      )}
      {(actions.change || actions.edit || transfer) && (
        <div className="flex flex-col items-end gap-1 sm:flex-row sm:flex-wrap sm:justify-end sm:items-center sm:gap-x-5"
          data-testid="entry-actions">
          {actions.change && (
            <button type="button" className={ACTION} onClick={open('change')} data-testid="self-change"
              aria-label={`Zmień konkurencję — ${entry.name}`}>
              Zmień konkurencję{arrow}
            </button>
          )}
          {actions.edit && (
            <button type="button" className={ACTION} onClick={open('edit')} data-testid="self-edit"
              aria-label={`Popraw dane — ${entry.name}`}>
              Popraw dane{arrow}
            </button>
          )}
          {transfer && (
            <Link to={transfer.href} className={ACTION} data-testid="transfer-action"
              aria-label={`Przekaż pakiet — ${entry.name}`}>
              Przekaż pakiet{arrow}
            </Link>
          )}
        </div>
      )}
      {transfer?.pending && (
        <span className={`${v.text} text-apex-text-bright [overflow-wrap:anywhere]`} data-testid="entry-transfer-pending">{transfer.pending}</span>
      )}
      {notice && (
        <p role="status" className={`${v.text} ${notice.error ? 'text-apex-red' : 'text-apex-text-bright'} [overflow-wrap:anywhere]`}
          data-testid="self-notice">
          {notice.text}
        </p>
      )}
    </div>
    {dialog === 'change' && <ChangeMyCompetitionDialog entry={entry} onClose={close} onDone={done} />}
    {dialog === 'edit' && <EditMyDataDialog entry={entry} onClose={close} onDone={done} />}
  </>)
}
