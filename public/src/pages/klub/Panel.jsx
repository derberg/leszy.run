import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import useSeo from '../../hooks/useSeo.js'
import StarButton from '../../components/StarButton.jsx'
import MembershipVisibilityChoice from '../../components/MembershipVisibilityChoice.jsx'
import { slugify } from '../../lib/slugify.js'
import { manageMember } from '../../lib/clubs.js'
import { followerNames, splitFollowers } from '../../lib/clubFollowers.js'
import { sectionTitle, actionBtnClass } from '../profil/fields.jsx'
import { useKlub } from './context.js'

// Club home page. ClubLayout's header already renders logo + name + public-page
// link, so this starts with description/location/member-count (copied from
// public/src/pages/profil/club/MemberView.jsx:53-60), then "moje członkostwo"
// (role + joined date + visibility toggle), followed events (FollowedEvent
// below, grown out of MemberView.jsx:86-114) and the leave button
// (MemberView.jsx:116-128).
// Roster now lives on Czlonkowie.jsx (sections/Roster.jsx).

const ROLE_LABELS = { owner: 'Właściciel', admin: 'Administrator', member: 'Członek' }
const FOLLOWERS_SHOWN = 3

function MyMembership() {
  const { club, me, reload } = useKlub()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  async function setVisibility(hidden) {
    setBusy(true)
    setError(null)
    try {
      await manageMember(club.id, 'set-visibility', { hidden_public: hidden })
      await reload()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <div className={sectionTitle}>Moje członkostwo</div>
      <p className="font-sans text-xs text-apex-muted mb-2">
        Rola: <span className="text-apex-text">{ROLE_LABELS[me.role] || me.role}</span>
        {me.joined_at && (
          <>
            {' '}· Dołączono:{' '}
            <span className="text-apex-text">
              {new Date(me.joined_at).toLocaleDateString('pl-PL', { day: '2-digit', month: '2-digit', year: 'numeric' })}
            </span>
          </>
        )}
      </p>
      <div className={busy ? 'opacity-50 pointer-events-none' : ''}>
        <MembershipVisibilityChoice value={!!me.hidden_public} onChange={setVisibility} />
      </div>
      {error && <p className="text-apex-red font-sans text-xs mt-1.5">{error}</p>}
      <p className="font-sans text-[11px] text-apex-muted mt-1.5">
        Zmiana widoczności pojawi się na publicznej stronie klubu po jej kolejnym odświeżeniu.
      </p>
    </div>
  )
}

// One followed race: the race on the first line, who from the club follows it on
// the second. Only members who share what they follow reach `followers` — the
// edge function filters on privacy_settings.favorites before counting or naming.
// `followers` may be absent if the deployed function still predates it, and then
// the row falls back to the bare count it used to show.
function FollowedEvent({ entry, members }) {
  const { event, count, followers } = entry
  const [expanded, setExpanded] = useState(false)
  const names = followerNames(followers, members)
  const { shown, hidden } = splitFollowers(names, FOLLOWERS_SHOWN)

  return (
    <div className="py-2.5 border-b border-apex-border/50 text-xs">
      <div className="flex items-center gap-3">
        <span className="font-mono text-[11px] font-semibold text-apex-yellow flex-shrink-0">
          {new Date(event.date).toLocaleDateString('pl-PL', { day: '2-digit', month: '2-digit', year: 'numeric' })}
        </span>
        <a
          href={`/kalendarz/${slugify(event.name, event.date)}`}
          className={`flex-1 truncate no-underline hover:text-apex-yellow ${event.status === 'cancelled' ? 'line-through text-apex-muted' : 'text-apex-text'}`}
        >
          {event.name}
        </a>
        <StarButton eventId={event.id} />
      </div>
      <p data-testid={`club-followers-${event.id}`} className="font-mono text-[10px] text-apex-muted mt-1 pr-8">
        {names.length === 0
          ? `${count} ${count === 1 ? 'klubowicz' : 'klubowiczów'} obserwuje`
          : (expanded ? names : shown).join(', ')}
        {hidden.length > 0 && (
          <button
            type="button"
            data-testid={`club-followers-toggle-${event.id}`}
            onClick={() => setExpanded((v) => !v)}
            className="ml-1.5 text-apex-yellow hover:text-apex-yellow-bright underline-offset-2 hover:underline"
          >
            {expanded ? 'zwiń' : `+${hidden.length}`}
          </button>
        )}
      </p>
    </div>
  )
}

export default function Panel() {
  const { club, me, followedEvents, members } = useKlub()
  const navigate = useNavigate()
  const [leaving, setLeaving] = useState(false)
  const [error, setError] = useState(null)

  useSeo({ title: `Panel — ${club.name} — Leszy.run`, noindex: true })

  const activeMembers = (members ?? []).filter((m) => m.status === 'active')

  async function handleLeave() {
    setLeaving(true)
    setError(null)
    try {
      await manageMember(club.id, 'leave')
      navigate('/profil/klub')
    } catch (err) {
      setError(err.message)
      setLeaving(false)
    }
  }

  return (
    <div className="space-y-8">
      <div>
        {club.description && (
          <p className="font-sans text-sm text-apex-text mt-0.5">{club.description}</p>
        )}
        <p className="font-mono text-[10px] text-apex-muted mt-1">
          {[club.city, club.voivodeship].filter(Boolean).join(', ')}
          {(club.city || club.voivodeship) && activeMembers.length > 0 ? ' · ' : ''}
          {activeMembers.length > 0 && `${activeMembers.length} ${activeMembers.length === 1 ? 'członek' : 'członków'}`}
        </p>
      </div>

      <MyMembership />

      <div>
        <div className={sectionTitle}>Nadchodzące biegi, które śledzą klubowicze</div>
        <p className="font-sans text-xs text-apex-muted -mt-2 mb-2">
          To biegi, które obserwują członkowie klubu — nie potwierdzone zapisy.
        </p>
        {(!followedEvents || followedEvents.length === 0) ? (
          <p className="font-sans text-sm text-apex-muted py-2">Nikt z klubu nie obserwuje jeszcze żadnego biegu.</p>
        ) : (
          <div data-testid="club-followed-events" className="space-y-0">
            {followedEvents.map((entry) => (
              <FollowedEvent key={entry.event.id} entry={entry} members={members} />
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
