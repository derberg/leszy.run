// EXPLORATION ONLY: team result layouts on made-up data. Routed on the dev server and in a
// build made with VITE_TEAM_PREVIEW=1 (a Vercel preview deployment), never in production.
import { useState } from 'react'
import { TeamStandings, RelayLegMatrix, TeamTag, computeTeamResults } from '../ui/index.js'
import { formatDuration } from '../lib/formatDuration.js'

const MIN = 60_000
const SURNAMES = ['Nowak', 'Kowalska', 'Wiśniewski', 'Wójcik', 'Kamińska', 'Lewandowski', 'Zielińska', 'Szymański',
  'Woźniak', 'Dąbrowska', 'Kozłowski', 'Jankowska', 'Mazur', 'Kwiatkowska', 'Krawczyk', 'Piotrowska', 'Grabowski',
  'Pawłowska', 'Michalski', 'Król', 'Wieczorek', 'Jabłońska', 'Wróbel', 'Nowakowska', 'Majewski', 'Olszewska']
const FIRST = ['Anna', 'Piotr', 'Kasia', 'Marek', 'Ola', 'Tomek', 'Ewa', 'Paweł', 'Magda', 'Kuba']

// legs: leg minutes per member; stopAt: members after this index have not finished (live / DNF)
function team(id, startBib, legs, { stopAt, dnfAt } = {}) {
  let cum = 0
  return legs.map((min, i) => {
    const bib = startBib + i
    const done = stopAt == null || i < stopAt
    if (done) cum += min * MIN
    const status = dnfAt === i ? 'dnf' : done ? 'finished' : (i === stopAt ? 'started' : 'registered')
    return {
      id: `${id}-${i}`, participantId: `${id}-${i}`,
      finishTime: done ? new Date(Date.UTC(2026, 11, 6, 10) + cum).toISOString() : null,
      startTime: status === 'started' ? 'x' : null,
      gunDurationMs: done ? cum : null,
      status,
      participant: { teamId: id, teamLeg: i + 1, bibNumber: bib, firstName: FIRST[bib % FIRST.length], lastName: SURNAMES[bib % SURNAMES.length], gender: bib % 2 ? 'M' : 'K' },
    }
  })
}

const RELAY_NAMES = { a: 'Zatyrani I', b: 'Wilcze Stado', c: 'Biegające Mamy', d: 'KB Szubin', e: 'Rodzina Mazurów', f: 'Lisy z Nakła' }
const relayRows = [
  ...team('a', 101, [11.2, 12.0, 11.6, 10.9]),
  ...team('b', 111, [10.8, 12.9, 11.1, 11.4]),
  ...team('c', 121, [13.5, 12.2, 13.0, 12.6]),
  ...team('d', 131, [11.0, 11.5, 12.4, 12.0], { stopAt: 2 }),
  ...team('e', 141, [12.1, 14.3, 12.8, 13.1], { stopAt: 3 }),
  ...team('f', 151, [12.5, 0, 0, 0], { stopAt: 1, dnfAt: 1 }),
]

const TOGETHER_NAMES = { p: 'Nordic Szubin', q: 'Kije w Ruch', r: 'Zielone Tygrysy', s: 'Sąsiedzi z bloku' }
function together(id, startBib, mins) {
  return mins.map((min, i) => ({
    id: `${id}-${i}`, participantId: `${id}-${i}`,
    finishTime: min ? 'x' : null, gunDurationMs: min ? min * MIN : null,
    status: min === 0 ? 'dnf' : min ? 'finished' : 'started',
    participant: { teamId: id, bibNumber: startBib + i, firstName: FIRST[(startBib + i) % 10], lastName: SURNAMES[(startBib + i) % SURNAMES.length] },
  }))
}
const togetherRows = [
  ...together('p', 201, [41.2, 41.3, 41.9, 42.0, 45.5]),
  ...together('q', 211, [39.0, 40.8, 43.1, 44.2, 0]),
  ...together('r', 221, [43.0, 43.0, 43.1, 43.2, 43.4]),
  ...together('s', 231, [44.0, 47.2, null, null, 0]),
]

const VIEWS = [
  { key: 'a', label: 'A · Drużyny', what: 'Sztafeta: jedna linia na drużynę',
    how: 'Miejsce, nazwa drużyny, czas drużyny i strata do lidera. Kliknij drużynę, żeby rozwinąć jej zmiany: kto biegł, czas tej zmiany, miejsce na tej zmianie (ramka) i czas narastająco. Drużyny jeszcze na trasie są pod skończonymi, z napisem „Zmiana 3/4”.' },
  { key: 'b', label: 'B · Arkusz zmian', what: 'Sztafeta: tabela z kolumną na każdą zmianę',
    how: 'Każdy wiersz to drużyna, każda kolumna to zmiana: nazwisko, czas zmiany z miejscem w ramce, pod spodem czas narastająco. Podświetlona komórka „biegnie” to zmiana, która jest teraz na trasie. Na telefonie tabela przewija się w bok.' },
  { key: 'c', label: 'C · Najszybsze zmiany', what: 'Sztafeta: ranking indywidualny per zmiana',
    how: 'Trzech najszybszych na każdej zmianie, niezależnie od wyniku drużyny. Tak zawodnik widzi swój indywidualny wynik w sztafecie.' },
  { key: 'd', label: 'D · Lista zawodników', what: 'Sztafeta: zwykła lista wyników z odznaką drużyny',
    how: 'Taka sama lista jak przy biegu indywidualnym, posortowana po czasie własnej zmiany. Odznaka mówi, w której drużynie i na której zmianie ktoś biegł.' },
  { key: 'e', label: 'E · Bieg drużynowy', what: 'Drużyny biegnące razem (np. NW, liczy się 4 z 5)',
    how: 'Wszyscy startują ze strzałem i biegną razem. Czas drużyny = czas 4. osoby z drużyny na mecie; piąta jest wyszarzona („Poza”). „Rozrzut” to odstęp między pierwszą a ostatnią liczoną osobą. Jedno DNF nie odbiera drużynie wyniku, dwa już tak.' },
]

const hashView = () => {
  const h = typeof window !== 'undefined' ? window.location.hash.slice(1) : ''
  return VIEWS.some(v => v.key === h) ? h : 'a'
}

export default function PodgladDruzyny() {
  const [view, setView] = useState(hashView)
  const pick = (k) => { setView(k); window.history.replaceState(null, '', `#${k}`) }
  const current = VIEWS.find(v => v.key === view)

  const relay = computeTeamResults({ mode: 'relay', results: relayRows, teamNames: RELAY_NAMES })
  const groups = computeTeamResults({ mode: 'together', results: togetherRows, teamNames: TOGETHER_NAMES, countMembers: 4 })

  const legs = [1, 2, 3, 4].map(leg => ({
    leg,
    rows: relay.flatMap(t => t.members.filter(m => m.leg === leg && m.legMs != null).map(m => ({ ...m, teamName: t.name })))
      .sort((a, b) => a.legMs - b.legMs).slice(0, 3),
  }))
  const teamOf = Object.fromEntries(relay.flatMap(t => t.members.map(m => [m.participantId, t.name])))
  const individual = relayRows.filter(r => r.status === 'finished')
    .map(r => ({ ...r, legMs: relay.flatMap(t => t.members).find(m => m.participantId === r.participantId)?.legMs }))
    .sort((a, b) => a.legMs - b.legMs)

  return (
    <div className="max-w-5xl mx-auto px-4 py-8" data-testid="team-preview">
      <div className="border border-apex-yellow/60 bg-apex-surface px-4 py-3 mb-8 text-sm text-apex-text">
        <strong className="text-apex-yellow">PODGLĄD, dane zmyślone.</strong> Tak mogą wyglądać wyniki drużyn na stronie wyników.
        Sztafeta 4 × 2,5 km, środek biegu: 3 drużyny na mecie, 2 na trasie, 1 DNF. Wybierz wariant poniżej (A–D to sztafeta, E to bieg drużynowy).
      </div>

      <div className="font-display text-4xl md:text-5xl tracking-widest uppercase text-apex-text-bright text-center mb-6">II Sztafeta Mikołajów</div>

      <nav className="sticky top-0 z-10 bg-apex-bg/95 backdrop-blur py-2 mb-6 -mx-4 px-4 border-b border-apex-border">
        <div className="flex gap-1 overflow-x-auto">
          {VIEWS.map(v => (
            <button key={v.key} type="button" onClick={() => pick(v.key)}
              className={`px-3 py-2 text-xs font-bold tracking-widest uppercase border whitespace-nowrap ${view === v.key ? 'bg-apex-yellow text-black border-apex-yellow' : 'text-apex-muted border-apex-border hover:text-apex-text'}`}>
              {v.label}
            </button>
          ))}
        </div>
      </nav>

      <div className="mb-6">
        <div className="font-display text-2xl tracking-widest uppercase text-apex-text-bright">{current.what}</div>
        <p className="text-sm text-apex-muted mt-1 max-w-3xl">{current.how}</p>
      </div>

      {view === 'a' && <TeamStandings teams={relay} mode="relay" formatDuration={formatDuration} />}

      {view === 'b' && <RelayLegMatrix teams={relay} formatDuration={formatDuration} />}

      {view === 'c' && (
        <div className="grid md:grid-cols-4 gap-2">
          {legs.map(({ leg, rows }) => (
            <div key={leg} className="border border-apex-border bg-apex-surface p-3">
              <div className="text-xs font-bold uppercase tracking-widest text-apex-cyan mb-2">Zmiana {leg}</div>
              {rows.map((m, i) => (
                <div key={m.id} className="flex items-baseline gap-2 text-sm py-0.5">
                  <span className="font-display text-apex-yellow w-4">{i + 1}</span>
                  <span className="flex-1 truncate">{m.participant.firstName} {m.participant.lastName}<span className="block text-[11px] text-apex-muted truncate">{m.teamName}</span></span>
                  <span className="font-mono">{formatDuration(m.legMs)}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {view === 'd' && (
        <div className="border border-apex-border bg-apex-surface divide-y divide-apex-border">
          {individual.map((r, i) => (
            <div key={r.id} className="flex items-center gap-3 px-3 py-2 text-sm">
              <span className="font-display text-xl text-apex-yellow w-6">{i + 1}</span>
              <span className="font-mono text-xs text-apex-muted w-10">#{r.participant.bibNumber}</span>
              <span className="flex-1 min-w-0 flex flex-col md:flex-row md:items-center gap-1 md:gap-3">
                <span className="truncate md:flex-1">{r.participant.firstName} {r.participant.lastName}</span>
                <span><TeamTag name={teamOf[r.participantId]} leg={r.participant.teamLeg} /></span>
              </span>
              <span className="font-mono font-bold text-apex-yellow-bright w-20 text-right">{formatDuration(r.legMs)}</span>
            </div>
          ))}
        </div>
      )}

      {view === 'e' && <TeamStandings teams={groups} mode="together" formatDuration={formatDuration} defaultOpen />}
    </div>
  )
}
