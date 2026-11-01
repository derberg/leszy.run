import { Link } from 'react-router-dom'
import { transferAction } from '../../lib/transferCopy.js'

// RA5's transfer action under one person (Zapisano for my-event-registrations rows, Zamowienie for a
// paid order's lines; both carry the server's `transfer` block). Shown only where the server says
// the session may hand this entry on now (ruling 3), with „Czeka na <adres>” while an invite is open.
// `row` is { id | registrationId, transfer }.
export default function TransferLink({ row, slug }) {
  const id = row?.id ?? row?.registrationId
  const action = slug && id ? transferAction({ ...row, id }, slug) : null
  if (!action) return null
  return (
    <div className="flex flex-col gap-1 pt-2.5 mt-2.5 border-t border-apex-border" data-testid="transfer-action">
      <Link to={action.href} className="self-start whitespace-nowrap text-base font-bold text-apex-yellow hover:text-apex-yellow-bright underline-offset-2 hover:underline">
        {action.label}
      </Link>
      {action.pending && <span className="text-sm text-apex-text-bright [overflow-wrap:anywhere]">{action.pending}</span>}
    </div>
  )
}
