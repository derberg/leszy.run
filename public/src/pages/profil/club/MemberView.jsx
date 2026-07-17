import { useState } from 'react'
import StarButton from '../../../components/StarButton.jsx'
import { slugify } from '../../../lib/slugify.js'
import { manageMember } from '../../../lib/clubs.js'
import { sectionTitle, actionBtnClass } from '../fields.jsx'

const ROLE_LABELS = { owner: 'Właściciel', admin: 'Administrator', member: 'Członek' }

function RoleTag({ role }) {
  const yellow = role === 'owner'
  return (
    <span className={`px-1.5 py-0.5 text-[9px] font-mono border flex-shrink-0 ${
      yellow ? 'border-apex-yellow-dim text-apex-yellow' : 'border-apex-border text-apex-muted'
    }`}>
      {ROLE_LABELS[role] || role}
    </span>
  )
}

// Roster + followed-events aggregate + leave action for an active club
// member. Also embedded by ManagePanel.jsx so owners/admins see the same
// view below their manage controls.
// <MemberView club me members followedEvents reload />
export default function MemberView({ club, me, members, followedEvents, reload }) {
  const [leaving, setLeaving] = useState(false)
  const [error, setError] = useState(null)

  const activeMembers = (members ?? []).filter((m) => m.status === 'active')

  async function handleLeave() {
    setLeaving(true)
    setError(null)
    try {
      await manageMember(club.id, 'leave')
      await reload()
    } catch (err) {
      setError(err.message)
    } finally {
      setLeaving(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start gap-3">
        {club.logo_url && (
          <div className="w-14 h-14 border border-apex-border bg-apex-surface shrink-0 overflow-hidden">
            <img src={club.logo_url} alt={`Logo ${club.name}`} className="w-full h-full object-cover" />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <h2 className="font-display font-bold text-lg text-apex-text-bright truncate">{club.name}</h2>
          {club.description && (
            <p className="font-sans text-sm text-apex-text mt-0.5">{club.description}</p>
          )}
          <p className="font-mono text-[10px] text-apex-muted mt-1">
            {[club.city, club.voivodeship].filter(Boolean).join(', ')}
            {(club.city || club.voivodeship) && activeMembers.length > 0 ? ' · ' : ''}
            {activeMembers.length > 0 && `${activeMembers.length} ${activeMembers.length === 1 ? 'członek' : 'członków'}`}
          </p>
          <a
            href={`/klub/${club.slug}`}
            target="_blank"
            rel="noopener"
            className="inline-block mt-1.5 font-mono text-xs text-apex-yellow underline"
          >
            Zobacz publiczną stronę klubu
          </a>
        </div>
      </div>

      <div>
        <div className={sectionTitle}>Klubowicze</div>
        <div data-testid="club-roster" className="space-y-0">
          {activeMembers.map((m) => (
            <div key={m.user_id} className="flex items-center gap-3 py-2 border-b border-apex-border/50 text-xs">
              <span className="flex-1 text-apex-text truncate">
                {m.display_name || m.nickname || 'Uczestnik anonimowy'}
              </span>
              <RoleTag role={m.role} />
            </div>
          ))}
        </div>
      </div>

      <div>
        <div className={sectionTitle}>Nadchodzące biegi, które śledzą klubowicze</div>
        <p className="font-sans text-xs text-apex-muted -mt-2 mb-2">
          To biegi, które obserwują członkowie klubu — nie potwierdzone zapisy.
        </p>
        {(!followedEvents || followedEvents.length === 0) ? (
          <p className="font-sans text-sm text-apex-muted py-2">Nikt z klubu nie obserwuje jeszcze żadnego biegu.</p>
        ) : (
          <div data-testid="club-followed-events" className="space-y-0">
            {followedEvents.map(({ event, count }) => (
              <div key={event.id} className="flex items-center gap-3 py-2.5 border-b border-apex-border/50 text-xs">
                <span className="font-mono text-[11px] font-semibold text-apex-yellow flex-shrink-0">
                  {new Date(event.date).toLocaleDateString('pl-PL', { day: '2-digit', month: '2-digit', year: 'numeric' })}
                </span>
                <a
                  href={`/kalendarz/${slugify(event.name, event.date)}`}
                  className={`flex-1 truncate no-underline hover:text-apex-yellow ${event.status === 'cancelled' ? 'line-through text-apex-muted' : 'text-apex-text'}`}
                >
                  {event.name}
                </a>
                <span className="font-mono text-[10px] text-apex-muted flex-shrink-0">
                  {count} {count === 1 ? 'klubowicz' : 'klubowiczów'} obserwuje
                </span>
                <StarButton eventId={event.id} />
              </div>
            ))}
          </div>
        )}
      </div>

      {me.role !== 'owner' && (
        <div>
          <button
            data-testid="leave-club-btn"
            onClick={handleLeave}
            disabled={leaving}
            className={`${actionBtnClass} border-apex-red text-apex-red hover:bg-apex-red hover:text-apex-ink disabled:opacity-40`}
          >
            {leaving ? 'Opuszczanie…' : 'Opuść klub'}
          </button>
          {error && <p className="text-apex-red font-sans text-xs mt-1.5">{error}</p>}
        </div>
      )}
    </div>
  )
}
