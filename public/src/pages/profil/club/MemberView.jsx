// Roster + followed-events + leave-club view for an active club member.
// Fleshed out in a follow-up task; Klub.jsx (Task 7) already wires it in so
// the /profil/klub route and section shell build and render end-to-end.
export default function MemberView({ club }) {
  return (
    <div data-testid="club-roster">
      <p className="font-sans text-sm text-apex-text">Jesteś członkiem klubu «{club.name}».</p>
    </div>
  )
}
