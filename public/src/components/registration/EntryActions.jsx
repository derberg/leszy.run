import { useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { formatPln } from '@registration/money.js'
import { transferAction } from '../../lib/transferCopy.js'
import ActionMenu from '../ActionMenu.jsx'
import ChangeMyCompetitionDialog from './ChangeMyCompetitionDialog.jsx'
import EditMyDataDialog from './EditMyDataDialog.jsx'

// The runner's own actions on one entry, on „Moje zapisy” (/profil/zapisy) and RA5 (Zapisano). They
// are rare, so they sit behind one small „⋯” (ActionMenu, the organizer's B3 menu) at the right end
// of the person's own line, each item only where the server says so, in this order:
// - „Zmień konkurencję” / „Popraw dane”: `actions` (the club's switches, before closes_at, never
//   for a team member; a captain only edits; selfService.js);
// - „Przekaż pakiet” to RA6: the `transfer` block (the session's own adult entry or a team's as
//   captain, transfers on, today ≤ the organizer's last day, no refund in flight; transferViews in
//   transfers.js).
// No item, no trigger. Under the person, outside the menu, stay what is not an action: an open
// competition-change surcharge („Dopłata czeka: X zł — Zapłać”, a payment owed), „Czeka na <adres>”
// while a transfer invite is open, and what the last change or edit did. A change that needs a
// surcharge opens its order page to pay at once; any other change or edit reads the list again
// (`onChanged`).
//
// `links` (Moje zapisy: the card's „Zamówienie”, „Twój zapis(y)”, in every person's menu) close the
// menu after the actions, behind a divider; with no action the menu holds the links alone.
//
// The page places the two parts: children({ menu, details }), `menu` on the person's line (null
// when there is nothing to offer), `details` under it (null when empty).

const variants = {
  // /profil/zapisy: a compact list.
  compact: { box: 'mt-0.5', text: 'font-mono text-[11px]' },
  // RA5: inside a person's card, under the competition line.
  card: { box: 'mt-2', text: 'text-sm' },
}

const PAY = 'whitespace-nowrap text-apex-yellow hover:text-apex-yellow-bright underline underline-offset-2'

/**
 * @param {{ entry: { id: string, name: string, competition: string|null, actions?: { change: boolean, edit: boolean },
 *   transfer?: { allowed: boolean, pending: { toEmail: string } | null } | null,
 *   surcharge?: { orderId: string, toCompetition: string|null, grosze: number } | null },
 *   slug?: string|null, onChanged: () => void, variant?: 'compact' | 'card',
 *   links?: Array<{ key: string, label: string, to: string, testId?: string }>,
 *   children: (parts: { menu: import('react').ReactNode, details: import('react').ReactNode }) => import('react').ReactNode }} p
 */
export default function EntryActions({ entry, slug = null, onChanged, variant = 'compact', links = [], children }) {
  const v = variants[variant]
  const navigate = useNavigate()
  const [dialog, setDialog] = useState(null)
  const [notice, setNotice] = useState(null)
  const opener = useRef(null)
  const actions = entry.actions ?? { change: false, edit: false }
  const s = entry.surcharge ?? null
  const transfer = slug ? transferAction(entry, slug) : null

  const open = (kind) => (trigger) => {
    opener.current = trigger
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
    opener.current?.focus()
  }

  const items = [
    actions.change && { key: 'change', label: 'Zmień konkurencję', onSelect: open('change'), testId: 'self-change' },
    actions.edit && { key: 'edit', label: 'Popraw dane', onSelect: open('edit'), testId: 'self-edit' },
    transfer && { key: 'transfer', label: 'Przekaż pakiet', to: transfer.href, testId: 'transfer-action' },
  ].filter(Boolean)
  if (links.length) items.push(...(items.length ? [{ key: 'links-sep', separator: true }] : []), ...links)

  const menu = items.length
    ? <ActionMenu label={`Zarządzaj zgłoszeniem: ${entry.name}`} items={items} size="sm" itemWeight="font-medium" testId="self-menu" />
    : null

  const details = (s || transfer?.pending || notice) ? (
    <div className={`${v.box} flex flex-col gap-0.5 min-w-0`} data-testid="self-service">
      {s && (
        <span className={`${v.text} text-apex-cyan-text [overflow-wrap:anywhere]`} data-testid="self-surcharge">
          Dopłata czeka: {formatPln(s.grosze)}{s.toCompetition ? ` (${s.toCompetition})` : ''} —{' '}
          <Link to={`/zamowienie/${s.orderId}`} className={PAY}>Zapłać</Link>
        </span>
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
  ) : null

  return (<>
    {children({ menu, details })}
    {dialog === 'change' && <ChangeMyCompetitionDialog entry={entry} onClose={close} onDone={done} />}
    {dialog === 'edit' && <EditMyDataDialog entry={entry} onClose={close} onDone={done} />}
  </>)
}
