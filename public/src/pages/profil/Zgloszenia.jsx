import { useState } from 'react'
import useSeo from '../../hooks/useSeo.js'
import { sectionTitle } from './fields.jsx'
import { useProfil } from './context.js'

function StatusBadge({ status }) {
  if (status === 'accepted') {
    return <span className="px-1.5 py-0.5 text-[9px] font-mono border border-green-800 text-green-400 bg-green-950/30">OK</span>
  }
  if (status === 'rejected') {
    return <span className="px-1.5 py-0.5 text-[9px] font-mono border border-red-900 text-apex-red bg-red-950/30">odrzucone</span>
  }
  return <span className="px-1.5 py-0.5 text-[9px] font-mono border border-apex-yellow-dim text-apex-yellow">oczekuje</span>
}

export default function Zgloszenia() {
  useSeo({ title: 'Moje zgłoszenia — Leszy.run', path: '/profil/zgloszenia', noindex: true })

  const { reports, submissions } = useProfil()
  const [filter, setFilter] = useState('all')

  const allContribs = [
    ...reports.map(r => ({ ...r, contribType: 'raport', name: `Raport: ${r.field || 'ogólny'}` })),
    ...submissions.map(s => ({ ...s, contribType: 'nowe wydarzenie', status: s.status === 'active' ? 'accepted' : s.status })),
  ].sort((a, b) => new Date(b.created_at) - new Date(a.created_at))

  const filtered = filter === 'all' ? allContribs : allContribs.filter(c => c.status === filter)

  return (
    <section>
      <div className={sectionTitle}>Moje zgłoszenia</div>
      <p className="font-sans text-xs text-apex-muted -mt-2 mb-2">
        Twoje raporty o poprawkach do wydarzeń oraz propozycje nowych wydarzeń wysłane do kalendarza.
      </p>
      <details className="font-sans text-[11px] text-apex-muted mb-4 group">
        <summary className="cursor-pointer text-apex-muted hover:text-apex-yellow list-none inline-flex items-center gap-1">
          <span className="text-apex-yellow-dim group-open:rotate-90 transition-transform inline-block">›</span>
          Co to są zgłoszenia?
        </summary>
        <p className="mt-1.5 pl-3 border-l border-apex-border leading-relaxed">
          Zgłoszenia to Twój wkład w kalendarz biegów. Są dwa rodzaje:{' '}
          <span className="text-apex-yellow-dim">raport</span> — poprawka do istniejącego
          wydarzenia, którą wysyłasz przyciskiem <span className="text-apex-yellow-dim">„Zgłoś poprawkę"</span>{' '}
          na stronie biegu; oraz <span className="text-apex-yellow-dim">nowe wydarzenie</span> —
          propozycja biegu, którego jeszcze nie ma w{' '}
          <a href="/kalendarz" className="text-apex-yellow underline">kalendarzu</a>.
        </p>
        <p className="mt-1.5 pl-3 border-l border-apex-border leading-relaxed">
          Na liście poniżej rozpoznasz je po tagu z rodzajem (raport / nowe wydarzenie) po lewej
          i statusie po prawej: <span className="text-apex-yellow-dim">Oczekujące</span> (czeka
          na sprawdzenie), <span className="text-apex-yellow-dim">Zaakceptowane</span> (poprawka
          lub wydarzenie trafiło do publicznego kalendarza) albo{' '}
          <span className="text-apex-yellow-dim">Odrzucone</span>. Zakładkami powyżej
          przefiltrujesz listę po statusie. Dzięki zgłoszeniom kalendarz jest aktualny —
          a Ty zdobywasz odznaki za wkład.
        </p>
      </details>
      <div className="flex flex-wrap gap-2 mb-4">
        {[
          { key: 'all', label: 'Wszystkie' },
          { key: 'pending', label: 'Oczekujące' },
          { key: 'accepted', label: 'Zaakceptowane' },
          { key: 'rejected', label: 'Odrzucone' },
        ].map(f => (
          <button key={f.key} onClick={() => setFilter(f.key)}
            className={`font-mono text-[10px] px-2 py-1 border transition-all ${filter === f.key ? 'border-apex-yellow text-apex-yellow' : 'border-apex-border text-apex-muted hover:border-apex-yellow/40'}`}>
            {f.label}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <p className="font-sans text-sm text-apex-muted py-8">Brak zgłoszeń do wyświetlenia.</p>
      ) : (
        <div className="space-y-0">
          {filtered.map((c, i) => (
            <div key={c.id || i} className="flex items-center gap-3 py-2.5 border-b border-apex-border/50 text-xs">
              <span className="bg-apex-surface border border-apex-border px-1.5 py-0.5 font-mono text-[9px] text-apex-muted flex-shrink-0">{c.contribType}</span>
              <span className="flex-1 text-apex-text truncate">{c.name}</span>
              <span className="text-apex-muted flex-shrink-0">{new Date(c.created_at).toLocaleDateString('pl-PL')}</span>
              <StatusBadge status={c.status} />
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
