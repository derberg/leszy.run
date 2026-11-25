import ActionMenu from '../../../../components/ActionMenu.jsx'
import { actionLabel } from '../../../../lib/entriesModel.js'

// The ⋯ menu of one row of the organizer's panel (B3). `actions` come from entryActions, in menu
// order; each item calls onSelect(action, triggerElement), except „Skład drużyny”, which is a link to the team's
// page (RB4). The menu itself (fixed to the viewport, so the table's horizontal scroll never clips
// it; keyboard and click-outside closing) is ActionMenu, shared with the runner's menu.

export default function EntryMenu({ name, row, actions, isTeamRow = false, isCaptain = false, squadHref = null, onSelect }) {
  const items = actions.map((action) => ({
    key: action,
    label: actionLabel(action, row, { isTeamRow, isCaptain }),
    ...(action === 'squad' && squadHref ? { to: squadHref } : { onSelect: (trigger) => onSelect(action, trigger) }),
  }))
  return <ActionMenu label={`Akcje — ${name}`} items={items} />
}
