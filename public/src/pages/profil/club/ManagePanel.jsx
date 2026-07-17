import MemberView from './MemberView.jsx'

// Owner/admin manage panel — roster+roles, pending requests, invites, edit,
// transfer, delete. Fleshed out in a follow-up task; Klub.jsx (Task 7) already
// wires it in so the /profil/klub route and section shell build end-to-end.
export default function ManagePanel({ club, me, members, followedEvents, reload }) {
  return (
    <div data-testid="manage-panel" className="space-y-8">
      <p className="font-sans text-sm text-apex-text">Zarządzasz klubem «{club.name}».</p>
      <MemberView club={club} me={me} members={members} followedEvents={followedEvents} reload={reload} />
    </div>
  )
}
