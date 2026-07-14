import useSeo from '../../hooks/useSeo.js'
import useFavorites from '../../hooks/useFavorites.js'
import useNotifications from '../../hooks/useNotifications.js'
import StarButton from '../../components/StarButton.jsx'
import { slugify } from '../../lib/slugify.js'
import { sectionTitle } from './fields.jsx'

export default function Obserwowane() {
  useSeo({ title: 'Obserwowane biegi — Leszy.run', path: '/profil/obserwowane', noindex: true })

  const { starredEvents } = useFavorites()
  const { notifications } = useNotifications({ markSeen: true })

  return (
    <section>
      <div className={sectionTitle}>Obserwowane biegi</div>
      <p className="font-sans text-xs text-apex-muted -mt-2 mb-2">
        Powiadomimy Cię tutaj, gdy dla obserwowanego biegu pojawi się link do zapisów
        lub zostanie 7 dni do końca zapisów.
      </p>
      <details className="font-sans text-[11px] text-apex-muted mb-4 group">
        <summary className="cursor-pointer text-apex-muted hover:text-apex-yellow list-none inline-flex items-center gap-1">
          <span className="text-apex-yellow-dim group-open:rotate-90 transition-transform inline-block">›</span>
          Skąd biorą się powiadomienia?
        </summary>
        <p className="mt-1.5 pl-3 border-l border-apex-border leading-relaxed">
          Powiadomienia są tak dobre, jak dane, które mamy w Leszym. Opieramy je na tym,
          co udostępniają organizatorzy — jeśli organizator nie poda w systemie ostatecznej
          daty zapisów, nie damy rady ostrzec Cię, że zostało 7 dni do jej końca. Podobnie
          link do zapisów pojawi się dopiero, gdy trafi do naszej bazy.
        </p>
        <p className="mt-1.5 pl-3 border-l border-apex-border leading-relaxed">
          Widzisz brakującą datę, link albo błąd? Każdy członek społeczności leszy.run
          może pomóc — przyciskiem <span className="text-apex-yellow-dim">„Zgłoś poprawkę"</span>{' '}
          przy wydarzeniu w <a href="/kalendarz" className="text-apex-yellow underline">kalendarzu</a>{' '}
          zgłosisz poprawkę i uzupełnisz brakujące dane. Im więcej osób dba o dane, tym
          lepsze powiadomienia dla wszystkich.
        </p>
      </details>

      {notifications.length > 0 && (
        <div className="mb-5 space-y-0" data-testid="notifications-feed">
          {notifications.map((n) => (
            <div key={n.id} className="flex items-center gap-3 py-2 border-b border-apex-border/50 text-xs">
              <span className={`px-1.5 py-0.5 font-mono text-[9px] border flex-shrink-0 ${
                n.type === 'registration_opened' ? 'border-green-800 text-green-400'
                : 'border-apex-yellow-dim text-apex-yellow'
              }`}>
                {n.type === 'registration_opened' ? 'Zapisy ruszyły' : 'Koniec zapisów blisko'}
              </span>
              <a href={`/kalendarz/${slugify(n.event_name || '', n.event_date)}`} className="flex-1 text-apex-text truncate no-underline hover:text-apex-yellow">
                {n.event_name}
              </a>
              <span className="text-apex-muted flex-shrink-0">{new Date(n.created_at).toLocaleDateString('pl-PL')}</span>
            </div>
          ))}
        </div>
      )}

      {starredEvents.length === 0 ? (
        <p className="font-sans text-sm text-apex-muted py-4">
          Nie obserwujesz jeszcze żadnych biegów. Wejdź do{' '}
          <a href="/kalendarz" className="text-apex-yellow underline">kalendarza</a>{' '}
          i kliknij ★ przy biegu, który Cię interesuje.
        </p>
      ) : (
        <div className="space-y-0" data-testid="starred-list">
          {starredEvents.map((ev) => (
            <div key={ev.id} className="flex items-center gap-3 py-2.5 border-b border-apex-border/50 text-xs">
              <span className="font-mono text-[11px] font-semibold text-apex-yellow flex-shrink-0">
                {new Date(ev.date).toLocaleDateString('pl-PL', { day: '2-digit', month: '2-digit', year: 'numeric' })}
              </span>
              <a href={`/kalendarz/${slugify(ev.name, ev.date)}`} className={`flex-1 truncate no-underline hover:text-apex-yellow ${ev.status === 'cancelled' ? 'line-through text-apex-muted' : 'text-apex-text'}`}>
                {ev.name}
              </a>
              {ev.status === 'cancelled' && (
                <span className="px-1.5 py-0.5 text-[9px] font-mono border border-apex-red/40 text-apex-red flex-shrink-0">Odwołany</span>
              )}
              <StarButton eventId={ev.id} />
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
