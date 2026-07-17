import useSeo from '../../hooks/useSeo.js'
import useClub from '../../hooks/useClub.js'
import { sectionTitle } from './fields.jsx'
import ClubPicker from '../../components/ClubPicker.jsx'
import MemberView from './club/MemberView.jsx'
import ManagePanel from './club/ManagePanel.jsx'
import ClubPrompts from './club/prompts.jsx'

// /profil/klub — the club hub. Branches on the caller's active club (from
// useClub, which wraps get-club): no active club → create/join picker;
// active member → MemberView; active owner/admin → ManagePanel (which itself
// embeds MemberView so managers see the same roster/followed-events). The
// nominee/pending-join/direct-invite prompts render at the top regardless of
// branch — a nominee or invitee may already be a member elsewhere, or of no
// club at all.
export default function Klub() {
  useSeo({ title: 'Klub — Leszy.run', path: '/profil/klub', noindex: true })

  const { ready, club, me, members, followedEvents, error, reload } = useClub()

  return (
    <section>
      <div className={sectionTitle}>Klub</div>

      <ClubPrompts reloadClub={reload} />

      {!ready ? (
        <p className="font-mono text-sm text-apex-muted animate-pulse py-8">Ładowanie…</p>
      ) : error ? (
        <p className="font-sans text-sm text-apex-red py-4">{error}</p>
      ) : !club ? (
        <div className="space-y-4">
          <p className="font-sans text-xs text-apex-muted -mt-2">
            Nie należysz jeszcze do żadnego klubu. Znajdź istniejący i poproś o dołączenie, albo załóż nowy.
          </p>
          <ClubPicker onJoined={() => reload()} onCreated={() => reload()} />
        </div>
      ) : (me.role === 'owner' || me.role === 'admin') ? (
        <ManagePanel club={club} me={me} members={members} followedEvents={followedEvents} reload={reload} />
      ) : (
        <MemberView club={club} me={me} members={members} followedEvents={followedEvents} reload={reload} />
      )}
    </section>
  )
}
