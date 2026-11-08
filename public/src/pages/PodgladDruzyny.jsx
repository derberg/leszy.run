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

// Relay in any order (Szubin): 4 laps per team, team of 3-4, someone runs twice, order mixed.
const FREE_NAMES = { a: 'Zatyrani I', b: 'Wilcze Stado', c: 'Biegające Mamy', d: 'KB Szubin', e: 'Rodzina Mazurów', f: 'Lisy z Nakła' }
const FREE_SQUADS = {
  a: { bib: 301, size: 3, laps: [[0, 9.8], [1, 10.4], [0, 10.1], [2, 11.0]] },
  b: { bib: 311, size: 4, laps: [[2, 10.2], [0, 10.9], [3, 11.3], [1, 10.6]] },
  c: { bib: 321, size: 4, laps: [[0, 12.4], [1, 11.9], [2, 12.8], [3, 12.1]] },
  d: { bib: 331, size: 3, laps: [[1, 10.0], [1, 10.7], [0, 11.5]] },
  e: { bib: 341, size: 4, laps: [[3, 12.0], [0, 13.1]] },
  f: { bib: 351, size: 3, laps: [[0, 11.8]], dnf: true },
}
const freeRows = []
const freeLaps = []
for (const [id, sq] of Object.entries(FREE_SQUADS)) {
  for (let i = 0; i < sq.size; i++) {
    const bib = sq.bib + i
    freeRows.push({
      id: `${id}-${i}`, participantId: `${id}-${i}`, status: sq.dnf && i === 1 ? 'dnf' : 'started',
      participant: { teamId: id, bibNumber: bib, firstName: FIRST[bib % FIRST.length], lastName: SURNAMES[bib % SURNAMES.length] },
    })
  }
  sq.laps.forEach(([who, min], k) => freeLaps.push({ id: `${id}L${k + 1}`, teamId: id, lapNumber: k + 1, participantId: `${id}-${who}`, lapMs: min * MIN }))
}

const FORMATS = [
  { key: 'free', label: 'Sztafeta · dowolna kolejność', note: 'Tak jak w Szubinie: drużyna ma przebiec 4 okrążenia, kto i ile razy biegnie, decyduje drużyna w trakcie. Dane w podglądzie: środek biegu, 3 drużyny na mecie, 2 na trasie, 1 wycofana.' },
  { key: 'fixed', label: 'Sztafeta · stała kolejność', note: 'Kolejność zmian ustalona przy zapisach: zmiana 1, potem 2, 3, 4, każdy biegnie raz.' },
  { key: 'together', label: 'Bieg drużynowy', note: 'Cała drużyna biegnie razem od strzału, np. drużyny NW. Liczy się 4 z 5 osób.' },
]

const VIEWS = {
  free: [
    { key: 'teams', label: 'Drużyny', how: 'Każda drużyna w jednej linijce: miejsce, nazwa, czas drużyny, strata do pierwszej. Kliknij drużynę, a zobaczysz jej okrążenia po kolei: kto biegł, w jakim czasie, i czas narastająco. Liczba w ramce to miejsce tego okrążenia wśród wszystkich okrążeń w biegu.' },
    { key: 'laps', label: 'Najszybsze okrążenia', how: 'Wszystkie okrążenia całego biegu od najszybszego. Tak zawodnik widzi, jak wypadł sam, niezależnie od drużyny.' },
    { key: 'runners', label: 'Zawodnicy', how: 'Lista ludzi: ile okrążeń kto przebiegł dla drużyny i jakie było jego najszybsze.' },
  ],
  fixed: [
    { key: 'teams', label: 'Drużyny', how: 'Jak w dowolnej kolejności, tylko zamiast okrążeń są zmiany 1–4.' },
    { key: 'sheet', label: 'Arkusz zmian', how: 'Tabela: wiersz to drużyna, kolumna to zmiana. W komórce nazwisko, czas zmiany i miejsce na tej zmianie. Działa tylko przy stałej kolejności.' },
    { key: 'legs', label: 'Najszybsze zmiany', how: 'Trzech najszybszych na każdej zmianie.' },
  ],
  together: [
    { key: 'teams', label: 'Drużyny', how: 'Czas drużyny to czas 4. osoby z drużyny na mecie. Piąta osoba jest wyszarzona („Poza”). „Rozrzut” to odstęp między pierwszą a ostatnią liczoną osobą.' },
  ],
}

const fromHash = () => {
  const [f, v] = (typeof window !== 'undefined' ? window.location.hash.slice(1) : '').split('-')
  const format = FORMATS.some(x => x.key === f) ? f : 'free'
  const view = VIEWS[format].some(x => x.key === v) ? v : VIEWS[format][0].key
  return { format, view }
}

const tabCls = (on) => `px-3 py-2 text-xs font-bold tracking-widest uppercase border whitespace-nowrap ${on ? 'bg-apex-yellow text-black border-apex-yellow' : 'text-apex-muted border-apex-border hover:text-apex-text'}`

export default function PodgladDruzyny() {
  const [state, setState] = useState(fromHash)
  const go = (format, view = VIEWS[format][0].key) => {
    setState({ format, view })
    window.history.replaceState(null, '', `#${format}-${view}`)
  }
  const { format, view } = state
  const fmt = FORMATS.find(f => f.key === format)
  const current = VIEWS[format].find(v => v.key === view)

  const free = computeTeamResults({ mode: 'relay_free', results: freeRows, laps: freeLaps, lapCount: 4, teamNames: FREE_NAMES })
  const relay = computeTeamResults({ mode: 'relay', results: relayRows, teamNames: RELAY_NAMES })
  const groups = computeTeamResults({ mode: 'together', results: togetherRows, teamNames: TOGETHER_NAMES, countMembers: 4 })

  const allLaps = free.flatMap(t => t.members.map(m => ({ ...m, teamName: t.name }))).sort((a, b) => a.legMs - b.legMs)
  const freeRunners = free.flatMap(t => t.runners.map(r => ({ ...r, teamName: t.name })))
    .sort((a, b) => b.laps - a.laps || (a.bestLapMs ?? Infinity) - (b.bestLapMs ?? Infinity))
  const legs = [1, 2, 3, 4].map(leg => ({
    leg,
    rows: relay.flatMap(t => t.members.filter(m => m.leg === leg && m.legMs != null).map(m => ({ ...m, teamName: t.name })))
      .sort((a, b) => a.legMs - b.legMs).slice(0, 3),
  }))

  return (
    <div className="max-w-5xl mx-auto px-4 py-8" data-testid="team-preview">
      <div className="border border-apex-yellow/60 bg-apex-surface px-4 py-3 mb-6 text-sm text-apex-text">
        <strong className="text-apex-yellow">PODGLĄD, dane zmyślone.</strong> Tak mogą wyglądać wyniki drużyn na stronie wyników.
        Najpierw wybierz rodzaj biegu, potem widok.
      </div>

      <div className="font-display text-4xl md:text-5xl tracking-widest uppercase text-apex-text-bright text-center mb-6">II Sztafeta Mikołajów</div>

      <div className="sticky top-0 z-10 bg-apex-bg/95 backdrop-blur py-2 mb-6 -mx-4 px-4 border-b border-apex-border space-y-2">
        <div className="flex gap-1 overflow-x-auto">
          <span className="text-[10px] uppercase tracking-widest text-apex-muted self-center w-14 shrink-0">Rodzaj</span>
          {FORMATS.map(f => <button key={f.key} type="button" onClick={() => go(f.key)} className={tabCls(format === f.key)}>{f.label}</button>)}
        </div>
        {VIEWS[format].length > 1 && (
          <div className="flex gap-1 overflow-x-auto">
            <span className="text-[10px] uppercase tracking-widest text-apex-muted self-center w-14 shrink-0">Widok</span>
            {VIEWS[format].map(v => <button key={v.key} type="button" onClick={() => go(format, v.key)} className={tabCls(view === v.key)}>{v.label}</button>)}
          </div>
        )}
      </div>

      <div className="mb-6 space-y-1 max-w-3xl">
        <p className="text-sm text-apex-text"><strong className="text-apex-text-bright">{fmt.label}.</strong> {fmt.note}</p>
        <p className="text-sm text-apex-muted"><strong className="text-apex-text">{current.label}:</strong> {current.how}</p>
      </div>

      {format === 'free' && view === 'teams' && <TeamStandings teams={free} mode="relay_free" formatDuration={formatDuration} />}

      {format === 'free' && view === 'laps' && (
        <div className="border border-apex-border bg-apex-surface divide-y divide-apex-border">
          {allLaps.map((m, i) => (
            <div key={m.id} className="flex items-center gap-3 px-3 py-2 text-sm">
              <span className="font-display text-xl text-apex-yellow w-6">{i + 1}</span>
              <span className="font-mono text-xs text-apex-muted w-10">#{m.participant.bibNumber}</span>
              <span className="flex-1 min-w-0 flex flex-col md:flex-row md:items-center gap-1 md:gap-3">
                <span className="truncate md:flex-1">{m.participant.firstName} {m.participant.lastName}</span>
                <span><TeamTag name={m.teamName} /> <span className="text-[10px] uppercase tracking-wider text-apex-muted">okr. {m.leg}</span></span>
              </span>
              <span className="font-mono font-bold text-apex-yellow-bright w-20 text-right">{formatDuration(m.legMs)}</span>
            </div>
          ))}
        </div>
      )}

      {format === 'free' && view === 'runners' && (
        <div className="border border-apex-border bg-apex-surface divide-y divide-apex-border">
          {freeRunners.map(r => (
            <div key={r.id} className="flex items-center gap-3 px-3 py-2 text-sm">
              <span className="font-mono text-xs text-apex-muted w-10">#{r.participant.bibNumber}</span>
              <span className="flex-1 min-w-0 flex flex-col md:flex-row md:items-center gap-1 md:gap-3">
                <span className="truncate md:flex-1">{r.participant.firstName} {r.participant.lastName}</span>
                <span><TeamTag name={r.teamName} /></span>
              </span>
              <span className="text-xs text-apex-muted w-24 text-right whitespace-nowrap">{r.laps ? `${r.laps} okr.` : 'nie biegł'}</span>
              <span className="font-mono font-bold text-apex-yellow-bright w-20 text-right">{r.bestLapMs != null ? formatDuration(r.bestLapMs) : '—'}</span>
            </div>
          ))}
        </div>
      )}

      {format === 'fixed' && view === 'teams' && <TeamStandings teams={relay} mode="relay" formatDuration={formatDuration} />}
      {format === 'fixed' && view === 'sheet' && <RelayLegMatrix teams={relay} formatDuration={formatDuration} />}
      {format === 'fixed' && view === 'legs' && (
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

      {format === 'together' && <TeamStandings teams={groups} mode="together" formatDuration={formatDuration} defaultOpen />}
    </div>
  )
}
