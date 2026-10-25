import { Link } from 'react-router-dom'
import useFavorites from '../hooks/useFavorites.js'
import useClubStarts from '../hooks/useClubStarts.js'
import { signOut } from '../lib/auth.js'
import { upcomingStarts, clubLinks, shortDate } from '../lib/accountMenu.js'

// The shortcuts behind the username chip: the desktop dropdown and the phone
// bottom sheet both render this. It mounts only while open, so the favorites
// and club counts are fetched (through their caches) when someone looks.

const ICONS = {
  user: <path d="M9 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm-6 7c0-3 2.7-5 6-5s6 2 6 5" fill="none" stroke="currentColor" strokeWidth="1.5" />,
  star: <path d="M9 2.5l1.9 4 4.3.5-3.2 3 .9 4.3L9 12.1l-3.9 2.2.9-4.3-3.2-3 4.3-.5z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />,
  club: <path d="M3 15V7l6-4 6 4v8H3Zm4 0v-4h4v4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />,
  starts: <path d="M3 4h12v11H3zM3 8h12M6 2v3M12 2v3M6.5 11.5h1.5M10 11.5h1.5" fill="none" stroke="currentColor" strokeWidth="1.5" />,
  plus: <path d="M9 3v12M3 9h12" stroke="currentColor" strokeWidth="1.5" />,
  out: <path d="M7 3H3v12h4M11 5l4 4-4 4M15 9H7" fill="none" stroke="currentColor" strokeWidth="1.5" />,
}

function Icon({ name, hover = 'group-hover:text-apex-yellow' }) {
  return (
    <svg viewBox="0 0 18 18" aria-hidden="true" className={`w-[18px] h-[18px] shrink-0 text-apex-muted ${hover} transition-colors`}>
      {ICONS[name]}
    </svg>
  )
}

function Count({ value, accent = false }) {
  if (value === null || value === undefined) return null
  return (
    <span className={`font-mono text-[11px] font-semibold px-1.5 border shrink-0 ${accent && value > 0 ? 'text-apex-yellow border-apex-yellow' : 'text-apex-muted border-apex-border-mid'}`}>
      {value}
    </span>
  )
}

function Item({ to, icon, label, sub, count, accent, highlight = false, onNavigate, large = false, testId }) {
  return (
    <Link
      to={to}
      onClick={onNavigate}
      data-testid={testId}
      className={`group flex items-center gap-3 px-4 ${large ? 'py-3.5 text-base' : 'py-2.5 text-sm'} font-sans text-apex-text hover:text-apex-yellow hover:bg-apex-surface transition-colors no-underline`}
    >
      <Icon name={icon} />
      <span className="flex-1 min-w-0 flex flex-col">
        <span className={highlight ? 'text-apex-yellow' : undefined}>{label}</span>
        {sub && <span className="font-mono text-[10px] text-apex-muted truncate">{sub}</span>}
      </span>
      <Count value={count} accent={accent} />
    </Link>
  )
}

export default function AccountMenu({ user, onNavigate, large = false }) {
  const { ready, starredEvents } = useFavorites()
  const club = clubLinks(user)
  const clubStarts = useClubStarts(club.hasClub ? user.club_id : null, true)

  // Local date, not UTC: between midnight and 02:00 in Poland UTC is still yesterday.
  const today = new Date().toLocaleDateString('en-CA')
  const { count: starredCount, next } = upcomingStarts(starredEvents, today)

  return (
    <nav aria-label="Menu konta">
      <Item to="/profil" icon="user" label="Mój profil" onNavigate={onNavigate} large={large} />
      <Item
        to="/profil/obserwowane"
        icon="star"
        label="Obserwowane starty"
        sub={next ? `najbliższy: ${shortDate(next.date)} ${next.name}` : null}
        count={ready ? starredCount : null}
        accent
        onNavigate={onNavigate}
        large={large}
        testId="menu-starred"
      />
      <div className="border-t border-apex-border" />
      {club.hasClub ? (
        <>
          <Item to={club.club} icon="club" label="Mój klub" sub={club.name} onNavigate={onNavigate} large={large} testId="menu-club" />
          <Item to={club.starts} icon="starts" label="Starty klubowiczów" count={clubStarts} onNavigate={onNavigate} large={large} testId="menu-club-starts" />
        </>
      ) : (
        <Item to="/profil/klub" icon="plus" label="Dołącz do klubu" sub="albo załóż własny" highlight onNavigate={onNavigate} large={large} testId="menu-join-club" />
      )}
      <div className="border-t border-apex-border" />
      <button
        onClick={async () => {
          onNavigate?.()
          try { await signOut() } finally { window.location.href = '/' }
        }}
        className={`group w-full flex items-center gap-3 text-left px-4 ${large ? 'py-3.5 text-base' : 'py-2.5 text-sm'} font-sans text-apex-muted hover:text-apex-red hover:bg-apex-surface transition-colors`}
      >
        <Icon name="out" hover="group-hover:text-apex-red" />
        Wyloguj się
      </button>
    </nav>
  )
}
