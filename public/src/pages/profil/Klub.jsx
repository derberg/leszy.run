import { Link } from 'react-router-dom'
import useSeo from '../../hooks/useSeo.js'
import { sectionTitle } from './fields.jsx'
import ClubPicker from '../../components/ClubPicker.jsx'
import ClubPrompts from './club/prompts.jsx'
import { useProfil } from './context.js'

// /profil/klub — slim hub: prompts, "my clubs" cards linking into the
// standalone /klub/:slug/* area, and the create/join picker when clubless.
export default function Klub() {
  useSeo({ title: 'Klub — Leszy.run', path: '/profil/klub', noindex: true })
  const { myClubs, refreshProfileData } = useProfil()

  return (
    <section>
      <div className={sectionTitle}>Klub</div>

      <ClubPrompts />

      {(myClubs ?? []).length > 0 ? (
        <div className="space-y-2" data-testid="my-clubs">
          {myClubs.map((c) => (
            <Link key={c.club_id} to={`/klub/${c.slug}/panel`} data-testid="my-club-card"
              className="flex items-center gap-3 border border-apex-border px-3.5 py-3 no-underline hover:border-apex-yellow/40 transition-all">
              {c.logo_url ? (
                <img src={c.logo_url} alt="" className="w-10 h-10 object-cover border border-apex-border shrink-0" />
              ) : (
                <div className="w-10 h-10 shrink-0 bg-apex-surface border border-apex-border flex items-center justify-center font-display font-bold text-apex-yellow">
                  {c.name?.[0]?.toUpperCase() || '?'}
                </div>
              )}
              <div className="min-w-0 flex-1">
                <div className="font-display font-bold text-sm text-apex-text-bright truncate">{c.name}</div>
                <div className="font-mono text-[10px] text-apex-muted">
                  {{ owner: 'Właściciel', admin: 'Administrator', member: 'Członek' }[c.role] || c.role}
                  {' · '}{c.member_count} {c.member_count === 1 ? 'członek' : 'członków'}
                </div>
              </div>
              <span className="font-mono text-xs text-apex-yellow shrink-0">Otwórz →</span>
            </Link>
          ))}
        </div>
      ) : (
        <div className="space-y-4">
          <p className="font-sans text-xs text-apex-muted -mt-2">
            Nie należysz jeszcze do żadnego klubu. Znajdź istniejący i poproś o dołączenie, albo załóż nowy.
          </p>
          <ClubPicker onJoined={() => refreshProfileData()} onCreated={() => refreshProfileData()} />
        </div>
      )}
    </section>
  )
}
