import { useState } from 'react'
import { anonymizedName } from '../lib/anonymizedName.js'
import { teamRunners } from '../lib/teamResults.js'

// Team result views. Every one takes the output of computeTeamResults() and renders it;
// none computes a time itself. Three layouts are here for comparison (EXPLORATION):
//   TeamStandings   — one row per team, the squad unfolds under it (relay legs or members)
//   RelayLegMatrix  — one row per team, one column per leg, like a ski-relay sheet
//   TeamTag         — the team badge an individual result row carries

const STATUS_LABEL = {
  racing: 'Na trasie',
  'not-started': 'Przed startem',
  dnf: 'DNF',
  dsq: 'DSQ',
  dns: 'DNS',
}
const STATUS_CLS = {
  racing: 'text-apex-cyan',
  'not-started': 'text-apex-muted',
  dnf: 'text-apex-red',
  dsq: 'text-apex-red',
  dns: 'text-apex-muted',
}

const memberName = (m) => anonymizedName(m.participant).displayName

function TeamStatus({ team }) {
  if (team.status === 'finished') return null
  const live = team.status === 'racing' && team.currentLeg
  const unit = team.runners ? 'Okrążenie' : 'Zmiana'
  const label = !live ? STATUS_LABEL[team.status]
    : team.size ? `${unit} ${team.currentLeg}/${team.size}` : `${unit} ${team.currentLeg}`
  return (
    <span className={`text-xs font-bold uppercase tracking-widest whitespace-nowrap ${STATUS_CLS[team.status]}`}>
      {label}
    </span>
  )
}

function LegRank({ rank }) {
  if (rank == null) return null
  return (
    <span className={`ml-1.5 font-mono text-[10px] px-1 border ${rank === 1 ? 'border-apex-yellow text-apex-yellow' : 'border-apex-border text-apex-muted'}`}>
      {rank}.
    </span>
  )
}

/**
 * @param {Array} teams          computeTeamResults() output
 * @param {'relay'|'relay_free'} mode
 * @param {Function} formatDuration
 * @param {boolean} [defaultOpen] unfold every squad at first render
 */
export function TeamStandings({ teams, mode, formatDuration, defaultOpen = false }) {
  const [open, setOpen] = useState(() => new Set(defaultOpen ? teams.map(t => t.teamId) : []))
  const toggle = (id) => setOpen(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })

  return (
    <div className="border border-apex-border bg-apex-surface divide-y divide-apex-border">
      {teams.map(t => {
        const isOpen = open.has(t.teamId)
        return (
          <div key={t.teamId}>
            <button
              type="button"
              onClick={() => toggle(t.teamId)}
              aria-expanded={isOpen}
              className="w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-apex-surface-2 transition-colors"
            >
              <span className="font-display text-2xl text-apex-yellow w-8 shrink-0 leading-none">{t.position ?? <span className="text-apex-dim">—</span>}</span>
              <span className="flex-1 min-w-0">
                <span className="block font-semibold text-apex-text-bright truncate">{t.name}</span>
                <span className="block text-xs text-apex-muted truncate">
                  {(t.runners ?? t.members).map(m => m.participant?.lastName).filter(Boolean).join(' · ')}
                </span>
                <span className="block sm:hidden mt-0.5"><TeamStatus team={t} /></span>
              </span>
              <span className="hidden sm:inline"><TeamStatus team={t} /></span>
              {mode === 'relay_free' ? (
                <span className="text-right shrink-0">
                  <span className="block font-mono font-bold text-apex-yellow-bright">{t.completed} okr.</span>
                  {t.totalMs != null && <span className="block font-mono text-[11px] text-apex-muted">{formatDuration(t.totalMs)}</span>}
                  {t.gapLaps > 0 && <span className="block font-mono text-[11px] text-apex-muted">−{t.gapLaps} okr.</span>}
                  {!t.gapLaps && t.gapMs > 0 && <span className="block font-mono text-[11px] text-apex-muted">+{formatDuration(t.gapMs)}</span>}
                </span>
              ) : (
                <span className="text-right shrink-0">
                  {t.totalMs != null && <span className="block font-mono font-bold text-apex-yellow-bright">{formatDuration(t.totalMs)}</span>}
                  {t.gapMs > 0 && <span className="block font-mono text-[11px] text-apex-muted">+{formatDuration(t.gapMs)}</span>}
                </span>
              )}
              <span className="font-mono text-apex-yellow w-3 shrink-0">{isOpen ? '−' : '+'}</span>
            </button>
            {isOpen && (
              <div className="bg-apex-surface-2 px-3 py-2">
                <table className="w-full text-xs">
                  <tbody className="divide-y divide-apex-border">
                    {t.members.map(m => (
                      <tr key={m.id}>
                        <td className="py-1.5 pr-2 w-16 text-apex-muted uppercase tracking-wider font-bold whitespace-nowrap">
                          {mode === 'relay' ? `Zm. ${m.leg}` : `Okr. ${m.leg}`}
                        </td>
                        <td className="py-1.5 pr-2 w-12 font-mono">#{m.participant?.bibNumber}</td>
                        <td className="py-1.5 pr-2 truncate">{memberName(m)}</td>
                        <td className="py-1.5 pr-2 text-right font-mono whitespace-nowrap">
                          {m.legMs != null ? formatDuration(m.legMs) : '—'}<LegRank rank={m.legRank} />
                        </td>
                        <td className="py-1.5 text-right font-mono text-apex-muted w-20">
                          {m.cumulativeMs != null ? formatDuration(m.cumulativeMs) : (STATUS_LABEL[m.status] ?? '—')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

/**
 * Relay only. A column per leg: the leg's own time and its rank among that leg's runners,
 * and under it the team's running total at the handover. Wide; on a phone it scrolls.
 */
export function RelayLegMatrix({ teams, formatDuration }) {
  const legs = Math.max(0, ...teams.map(t => t.size))
  return (
    <div className="border border-apex-border bg-apex-surface overflow-x-auto">
      <table className="w-full text-xs min-w-[640px]">
        <thead>
          <tr className="border-b border-apex-border bg-apex-surface-2">
            <th className="text-left px-2 py-2 font-bold uppercase tracking-wider text-apex-muted w-10">Poz.</th>
            <th className="text-left px-2 py-2 font-bold uppercase tracking-wider text-apex-muted">Drużyna</th>
            {Array.from({ length: legs }, (_, i) => (
              <th key={i} className="text-center px-2 py-2 font-bold uppercase tracking-wider text-apex-cyan font-mono">Zm. {i + 1}</th>
            ))}
            <th className="text-right px-2 py-2 font-bold uppercase tracking-wider text-apex-yellow font-mono">Czas</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-apex-border">
          {teams.map(t => (
            <tr key={t.teamId} className="hover:bg-apex-surface-2 transition-colors align-top">
              <td className="px-2 py-2 font-display text-lg text-apex-yellow">{t.position ?? <span className="text-apex-dim">—</span>}</td>
              <td className="px-2 py-2">
                <div className="font-semibold text-apex-text-bright">{t.name}</div>
                <TeamStatus team={t} />
              </td>
              {Array.from({ length: legs }, (_, i) => {
                const m = t.members[i]
                const onCourse = t.status === 'racing' && t.currentLeg === i + 1
                return (
                  <td key={i} className={`px-2 py-2 text-center ${onCourse ? 'bg-apex-surface-2' : ''}`}>
                    {m ? (
                      <>
                        <div className="text-apex-text truncate max-w-[9rem] mx-auto">{m.participant?.lastName}</div>
                        <div className="font-mono">
                          {m.legMs != null ? formatDuration(m.legMs) : onCourse ? <span className="text-apex-cyan">biegnie</span> : '—'}
                          <LegRank rank={m.legRank} />
                        </div>
                        {m.cumulativeMs != null && <div className="font-mono text-[10px] text-apex-dim">{formatDuration(m.cumulativeMs)}</div>}
                      </>
                    ) : <span className="text-apex-dim">—</span>}
                  </td>
                )
              })}
              <td className="px-2 py-2 text-right whitespace-nowrap">
                <div className="font-mono text-sm font-bold text-apex-yellow-bright">{t.totalMs != null ? formatDuration(t.totalMs) : '—'}</div>
                {t.gapMs > 0 && <div className="font-mono text-[11px] text-apex-muted">+{formatDuration(t.gapMs)}</div>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** The badge an individual result row carries: which team, which leg. */
export function TeamTag({ name, leg }) {
  return (
    <span className="inline-flex items-center gap-1 border border-apex-border px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-apex-muted whitespace-nowrap">
      <span className="text-apex-yellow">◆</span>{name}{leg ? ` · zm. ${leg}` : ''}
    </span>
  )
}

/** Individual ranking of a relay: rows from teamRunners(), each with its team. */
export function TeamRunnersList({ rows, by = 'best', mode, formatDuration }) {
  return (
    <div className="border border-apex-border bg-apex-surface divide-y divide-apex-border">
      {rows.map(r => (
        <div key={r.id} className="flex items-center gap-3 px-3 py-2 text-sm">
          <span className="font-display text-xl text-apex-yellow w-6 shrink-0">{r.rank}</span>
          <span className="font-mono text-xs text-apex-muted w-10 shrink-0">#{r.participant?.bibNumber}</span>
          <span className="flex-1 min-w-0 flex flex-col md:flex-row md:items-center gap-1 md:gap-3">
            <span className="truncate md:flex-1">{memberName(r)}</span>
            <span><TeamTag name={r.teamName} /></span>
          </span>
          <span className="text-right w-24 shrink-0">
            {by === 'laps' ? (
              <>
                <span className="block font-mono font-bold text-apex-yellow-bright">{r.laps} okr.</span>
                {r.bestLapMs != null && <span className="block font-mono text-[11px] text-apex-muted">najl. {formatDuration(r.bestLapMs)}</span>}
              </>
            ) : (
              <>
                <span className="block font-mono font-bold text-apex-yellow-bright">{formatDuration(r.bestLapMs)}</span>
                {mode === 'relay' && <span className="block font-mono text-[11px] text-apex-muted">zmiana {r.leg}</span>}
              </>
            )}
          </span>
        </div>
      ))}
    </div>
  )
}

const TEAM_VIEWS = {
  relay_free: [
    { key: 'teams', label: 'Drużyny' },
    { key: 'best', label: 'Najszybsze okrążenie' },
    { key: 'laps', label: 'Najwięcej okrążeń' },
  ],
  relay: [
    { key: 'teams', label: 'Drużyny' },
    { key: 'sheet', label: 'Arkusz zmian' },
    { key: 'best', label: 'Najszybsi indywidualnie' },
  ],
}

/**
 * A relay's results with its views as tabs: the teams, and the individual rankings.
 * @param {'relay'|'relay_free'} mode
 * @param {Array} teams computeTeamResults() output
 */
export function TeamResultsTabs({ mode, teams, formatDuration }) {
  const views = TEAM_VIEWS[mode] ?? TEAM_VIEWS.relay_free
  const [view, setView] = useState(views[0].key)
  return (
    <div>
      <div className="flex flex-wrap justify-center gap-1 mb-6">
        {views.map(v => (
          <button key={v.key} type="button" onClick={() => setView(v.key)}
            className={`px-4 py-2 text-xs font-bold tracking-widest uppercase transition-colors border whitespace-nowrap ${
              view === v.key ? 'bg-apex-yellow text-black border-apex-yellow' : 'text-apex-muted border-apex-border hover:text-apex-text'}`}>
            {v.label}
          </button>
        ))}
      </div>
      {view === 'teams' && <TeamStandings teams={teams} mode={mode} formatDuration={formatDuration} />}
      {view === 'sheet' && <RelayLegMatrix teams={teams} formatDuration={formatDuration} />}
      {view === 'best' && <TeamRunnersList rows={teamRunners(teams, 'best')} by="best" mode={mode} formatDuration={formatDuration} />}
      {view === 'laps' && <TeamRunnersList rows={teamRunners(teams, 'laps')} by="laps" mode={mode} formatDuration={formatDuration} />}
    </div>
  )
}
