import { useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { formatPln } from '@registration/money.js'
import ChangeMyCompetitionDialog from './ChangeMyCompetitionDialog.jsx'
import EditMyDataDialog from './EditMyDataDialog.jsx'

// The runner's own actions under one entry (spec Part 2), on „Moje zapisy” (/profil/zapisy) and RA5
// (Zapisano): „Zmień konkurencję” and „Popraw dane” where the server's `actions` say so (the club's
// switches, before closes_at, never for a team member; a captain only edits; selfService.js), and an
// open competition-change surcharge as „Dopłata czeka: X zł — Zapłać”. A change that needs a
// surcharge opens its order page to pay at once; any other change or edit reads the list again
// (`onChanged`) and says what happened here.

const variants = {
  // /profil/zapisy: a compact list.
  compact: {
    box: 'mt-1 flex flex-wrap items-center gap-x-4 gap-y-1',
    action: 'whitespace-nowrap font-mono text-[11px] text-apex-yellow hover:text-apex-yellow-bright underline-offset-2 hover:underline',
    text: 'font-mono text-[11px]',
  },
  // RA5: under a person's card, like „Przekaż pakiet innej osobie →”.
  card: {
    box: 'flex flex-wrap items-center gap-x-5 gap-y-1 pt-2.5 mt-2.5 border-t border-apex-border',
    action: 'whitespace-nowrap text-base font-bold text-apex-yellow hover:text-apex-yellow-bright underline-offset-2 hover:underline',
    text: 'text-sm',
  },
}

/**
 * @param {{ entry: { id: string, name: string, competition: string|null, actions?: { change: boolean, edit: boolean },
 *   surcharge?: { orderId: string, toCompetition: string|null, grosze: number } | null },
 *   onChanged: () => void, variant?: 'compact' | 'card' }} p
 */
export default function EntrySelfService({ entry, onChanged, variant = 'compact' }) {
  const v = variants[variant]
  const navigate = useNavigate()
  const [dialog, setDialog] = useState(null)
  const [notice, setNotice] = useState(null)
  const opener = useRef(null)
  const actions = entry.actions ?? { change: false, edit: false }
  const s = entry.surcharge ?? null
  if (!actions.change && !actions.edit && !s && !notice) return null

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

  return (
    <div data-testid="self-service">
      <div className={v.box}>
        {s && (
          <span className={`${v.text} text-apex-cyan-text [overflow-wrap:anywhere]`} data-testid="self-surcharge">
            Dopłata czeka: {formatPln(s.grosze)}{s.toCompetition ? ` (${s.toCompetition})` : ''} —{' '}
            <Link to={`/zamowienie/${s.orderId}`} className={v.action}>Zapłać</Link>
          </span>
        )}
        {actions.change && (
          <button type="button" className={v.action} onClick={open('change')} data-testid="self-change"
            aria-label={`Zmień konkurencję — ${entry.name}`}>
            Zmień konkurencję
          </button>
        )}
        {actions.edit && (
          <button type="button" className={v.action} onClick={open('edit')} data-testid="self-edit"
            aria-label={`Popraw dane — ${entry.name}`}>
            Popraw dane
          </button>
        )}
      </div>
      {notice && (
        <p role="status" className={`mt-1 ${v.text} ${notice.error ? 'text-apex-red' : 'text-apex-text-bright'} [overflow-wrap:anywhere]`}
          data-testid="self-notice">
          {notice.text}
        </p>
      )}
      {dialog === 'change' && <ChangeMyCompetitionDialog entry={entry} onClose={close} onDone={done} />}
      {dialog === 'edit' && <EditMyDataDialog entry={entry} onClose={close} onDone={done} />}
    </div>
  )
}
