// EXPLORATION ONLY: team result layouts on made-up data. Routed on the dev server and in a
// build made with VITE_TEAM_PREVIEW=1 (a Vercel preview deployment), never in production.
import { useState } from 'react'
import { TeamStandings, RelayLegMatrix, TeamTag, computeTeamResults, freeRelayRunners } from '../ui/index.js'
import { formatDuration } from '../lib/formatDuration.js'

const MIN = 60_000
const SURNAMES = ['Nowak', 'Kowalska', 'Wiśniewski', 'Wójcik', 'Kamińska', 'Lewandowski', 'Zielińska', 'Szymański',
  'Woźniak', 'Dąbrowska', 'Kozłowski', 'Jankowska', 'Mazur', 'Kwiatkowska', 'Krawczyk', 'Piotrowska', 'Grabowski',
  'Pawłowska', 'Michalski', 'Król', 'Wieczorek', 'Jabłońska', 'Wróbel', 'Nowakowska', 'Majewski', 'Olszewska']
const FIRST = ['Anna', 'Piotr', 'Kasia', 'Marek', 'Ola', 'Tomek', 'Ewa', 'Paweł', 'Magda', 'Kuba']
const person = (teamId, bib, extra = {}) => ({ teamId, bibNumber: bib, firstName: FIRST[bib % FIRST.length], lastName: SURNAMES[bib % SURNAMES.length], ...extra })

// --- Szubin: any order, as many laps as possible. Teams of 4-5, mid-race (about 45 min in).
const FREE_NAMES = { a: 'Zatyrani I', b: 'Wilcze Stado', c: 'Biegające Mamy', d: 'KB Szubin', e: 'Rodzina Mazurów', f: 'Lisy z Nakła' }
// laps: [who (index in squad), minutes]
const FREE_SQUADS = {
  a: { bib: 301, size: 5, laps: [[0, 9.8], [1, 10.4], [0, 10.1], [2, 11.0]] },
  b: { bib: 311, size: 4, laps: [[2, 10.2], [0, 10.9], [3, 11.3], [1, 10.6]] },
  c: { bib: 321, size: 5, laps: [[0, 12.4], [1, 11.9], [4, 12.8]] },
  d: { bib: 331, size: 4, laps: [[1, 10.0], [1, 10.7], [0, 11.5]] },
  e: { bib: 341, size: 5, laps: [[3, 12.0], [0, 13.1], [2, 12.6]] },
  f: { bib: 351, size: 4, laps: [[0, 11.8]], gaveUp: true },
}
const freeRows = []
const freeLaps = []
for (const [id, sq] of Object.entries(FREE_SQUADS)) {
  for (let i = 0; i < sq.size; i++) {
    freeRows.push({ id: `${id}-${i}`, participantId: `${id}-${i}`, status: sq.gaveUp ? 'dnf' : 'started', participant: person(id, sq.bib + i) })
  }
  sq.laps.forEach(([who, min], k) => freeLaps.push({ id: `${id}L${k + 1}`, teamId: id, lapNumber: k + 1, participantId: `${id}-${who}`, lapMs: min * MIN }))
}

// --- Fixed order: 4 legs, each runs once.
const FIXED_NAMES = { a: 'Zatyrani I', b: 'Wilcze Stado', c: 'Biegające Mamy', d: 'KB Szubin', e: 'Rodzina Mazurów' }
function fixedTeam(id, startBib, legs, { stopAt } = {}) {
  let cum = 0
  return legs.map((min, i) => {
    const done = stopAt == null || i < stopAt
    if (done) cum += min * MIN
    return {
      id: `${id}-${i}`, participantId: `${id}-${i}`,
      finishTime: done ? 'x' : null, gunDurationMs: done ? cum : null,
      status: done ? 'finished' : (i === stopAt ? 'started' : 'registered'),
      startTime: i === stopAt ? 'x' : null,
      participant: person(id, startBib + i, { teamLeg: i + 1 }),
    }
  })
}
const fixedRows = [
  ...fixedTeam('a', 101, [11.2, 12.0, 11.6, 10.9]),
  ...fixedTeam('b', 111, [10.8, 12.9, 11.1, 11.4]),
  ...fixedTeam('c', 121, [13.5, 12.2, 13.0, 12.6]),
  ...fixedTeam('d', 131, [11.0, 11.5, 12.4, 12.0], { stopAt: 2 }),
  ...fixedTeam('e', 141, [12.1, 14.3, 12.8, 13.1], { stopAt: 3 }),
]

const FORMATS = [
  { key: 'free', label: 'Sztafeta · dowolna kolejność', note: 'Domyślny tryb, tak jak w Szubinie. Drużyna (4–5 osób) robi jak najwięcej okrążeń. Kto i ile razy biegnie, decyduje drużyna w trakcie. Wygrywa drużyna z największą liczbą okrążeń, a przy równej liczbie ta, która zamknęła ostatnie okrążenie wcześniej. Dane w podglądzie: mniej więcej 45. minuta biegu.' },
  { key: 'fixed', label: 'Sztafeta · stała kolejność', note: 'Kolejność zmian ustalona z góry: zmiana 1, potem 2, 3, 4, każdy biegnie raz. Wygrywa najkrótszy łączny czas.' },
]

const VIEWS = {
  free: [
    { key: 'teams', label: 'Drużyny', how: 'Drużyny od największej liczby okrążeń. Po prawej: ile okrążeń, czas ostatniego okrążenia od startu i strata do pierwszej drużyny (w okrążeniach albo w czasie). Kliknij drużynę, żeby zobaczyć jej okrążenia po kolei i kto je biegł. Liczba w ramce to miejsce tego okrążenia wśród wszystkich okrążeń w biegu.' },
    { key: 'best', label: 'Najszybsze okrążenie', how: 'Ranking indywidualny: każdy zawodnik ze swoim najszybszym okrążeniem, od najszybszego.' },
    { key: 'most', label: 'Najwięcej okrążeń', how: 'Ranking indywidualny: kto przebiegł dla drużyny najwięcej okrążeń. Przy remisie decyduje najszybsze okrążenie.' },
  ],
  fixed: [
    { key: 'teams', label: 'Drużyny', how: 'Drużyny od najkrótszego czasu. Kliknij drużynę, żeby zobaczyć zmiany: kto biegł, czas zmiany, miejsce na tej zmianie (w ramce) i czas narastająco.' },
    { key: 'sheet', label: 'Arkusz zmian', how: 'Tabela: wiersz to drużyna, kolumna to zmiana. W komórce nazwisko, czas zmiany z miejscem na tej zmianie i pod spodem czas narastająco.' },
  ],
}

const fromHash = () => {
  const [f, v] = (typeof window !== 'undefined' ? window.location.hash.slice(1) : '').split('-')
  const format = FORMATS.some(x => x.key === f) ? f : 'free'
  const view = VIEWS[format].some(x => x.key === v) ? v : VIEWS[format][0].key
  return { format, view }
}

const tabCls = (on) => `px-3 py-2 text-xs font-bold tracking-widest uppercase border whitespace-nowrap ${on ? 'bg-apex-yellow text-black border-apex-yellow' : 'text-apex-muted border-apex-border hover:text-apex-text'}`

function RunnerList({ rows, value }) {
  return (
    <div className="border border-apex-border bg-apex-surface divide-y divide-apex-border">
      {rows.map(r => (
        <div key={r.id} className="flex items-center gap-3 px-3 py-2 text-sm">
          <span className="font-display text-xl text-apex-yellow w-6">{r.rank}</span>
          <span className="font-mono text-xs text-apex-muted w-10">#{r.participant.bibNumber}</span>
          <span className="flex-1 min-w-0 flex flex-col md:flex-row md:items-center gap-1 md:gap-3">
            <span className="truncate md:flex-1">{r.participant.firstName} {r.participant.lastName}</span>
            <span><TeamTag name={r.teamName} /></span>
          </span>
          {value(r)}
        </div>
      ))}
    </div>
  )
}

export default function PodgladDruzyny() {
  const [state, setState] = useState(fromHash)
  const go = (format, view = VIEWS[format][0].key) => {
    setState({ format, view })
    window.history.replaceState(null, '', `#${format}-${view}`)
  }
  const { format, view } = state
  const fmt = FORMATS.find(f => f.key === format)
  const current = VIEWS[format].find(v => v.key === view)

  const free = computeTeamResults({ mode: 'relay_free', results: freeRows, laps: freeLaps, teamNames: FREE_NAMES })
  const fixed = computeTeamResults({ mode: 'relay', results: fixedRows, teamNames: FIXED_NAMES })

  return (
    <div className="max-w-5xl mx-auto px-4 py-8" data-testid="team-preview">
      <div className="border border-apex-yellow/60 bg-apex-surface px-4 py-3 mb-6 text-sm text-apex-text">
        <strong className="text-apex-yellow">PODGLĄD, dane zmyślone.</strong> Tak mogą wyglądać wyniki sztafety na stronie wyników.
        Najpierw wybierz rodzaj sztafety, potem widok.
      </div>

      <div className="font-display text-4xl md:text-5xl tracking-widest uppercase text-apex-text-bright text-center mb-6">II Sztafeta Mikołajów</div>

      <div className="sticky top-0 z-10 bg-apex-bg/95 backdrop-blur py-2 mb-6 -mx-4 px-4 border-b border-apex-border space-y-2">
        <div className="flex gap-1 overflow-x-auto">
          <span className="text-[10px] uppercase tracking-widest text-apex-muted self-center w-14 shrink-0">Rodzaj</span>
          {FORMATS.map(f => <button key={f.key} type="button" onClick={() => go(f.key)} className={tabCls(format === f.key)}>{f.label}</button>)}
        </div>
        <div className="flex gap-1 overflow-x-auto">
          <span className="text-[10px] uppercase tracking-widest text-apex-muted self-center w-14 shrink-0">Widok</span>
          {VIEWS[format].map(v => <button key={v.key} type="button" onClick={() => go(format, v.key)} className={tabCls(view === v.key)}>{v.label}</button>)}
        </div>
      </div>

      <div className="mb-6 space-y-1 max-w-3xl">
        <p className="text-sm text-apex-text"><strong className="text-apex-text-bright">{fmt.label}.</strong> {fmt.note}</p>
        <p className="text-sm text-apex-muted"><strong className="text-apex-text">{current.label}:</strong> {current.how}</p>
      </div>

      {format === 'free' && view === 'teams' && <TeamStandings teams={free} mode="relay_free" formatDuration={formatDuration} />}
      {format === 'free' && view === 'best' && (
        <RunnerList rows={freeRelayRunners(free, 'best')} value={r => (
          <span className="font-mono font-bold text-apex-yellow-bright w-20 text-right">{formatDuration(r.bestLapMs)}</span>
        )} />
      )}
      {format === 'free' && view === 'most' && (
        <RunnerList rows={freeRelayRunners(free, 'laps')} value={r => (
          <span className="text-right w-24 shrink-0">
            <span className="block font-mono font-bold text-apex-yellow-bright">{r.laps} okr.</span>
            <span className="block font-mono text-[11px] text-apex-muted">najl. {formatDuration(r.bestLapMs)}</span>
          </span>
        )} />
      )}

      {format === 'fixed' && view === 'teams' && <TeamStandings teams={fixed} mode="relay" formatDuration={formatDuration} />}
      {format === 'fixed' && view === 'sheet' && <RelayLegMatrix teams={fixed} formatDuration={formatDuration} />}
    </div>
  )
}
