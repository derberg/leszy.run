import { useState, useEffect, useCallback } from 'react'

const API = import.meta.env.VITE_API_URL || 'http://localhost:3001'
const tabClass = 'font-display font-bold text-sm tracking-widest uppercase px-4 py-2 transition-all'
const activeTab = 'text-apex-yellow border-b-2 border-apex-yellow'
const inactiveTab = 'text-apex-muted hover:text-apex-text-bright'
const btnBase = 'font-display font-bold text-[11px] tracking-widest uppercase px-3 py-1.5 transition-all'

export default function Moderation() {
  const [tab, setTab] = useState('pending')
  const [pendingEvents, setPendingEvents] = useState([])
  const [reports, setReports] = useState([])
  const [loading, setLoading] = useState(true)
  const [editingReport, setEditingReport] = useState(null)
  const [editValue, setEditValue] = useState('')

  const fetchPending = useCallback(async () => {
    const res = await fetch(`${API}/api/calendar-events?status=pending&limit=500`)
    const json = await res.json()
    setPendingEvents(json.data || [])
  }, [])

  const fetchReports = useCallback(async () => {
    const res = await fetch(`${API}/api/calendar-event-reports?status=pending`)
    const json = await res.json()
    setReports(json.data || [])
  }, [])

  useEffect(() => {
    setLoading(true)
    Promise.all([fetchPending(), fetchReports()]).finally(() => setLoading(false))
  }, [fetchPending, fetchReports])

  const approveEvent = async (id) => {
    await fetch(`${API}/api/calendar-events/${id}/approve`, { method: 'PATCH' })
    setPendingEvents(prev => prev.filter(e => e.id !== id))
  }

  const deleteEvent = async (id) => {
    await fetch(`${API}/api/calendar-events/${id}`, { method: 'DELETE' })
    setPendingEvents(prev => prev.filter(e => e.id !== id))
  }

  const acceptReport = async (id, overrideValue) => {
    const body = overrideValue !== undefined ? { suggested_value: overrideValue } : undefined
    await fetch(`${API}/api/calendar-event-reports/${id}/accept`, {
      method: 'PATCH',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    })
    setReports(prev => prev.filter(r => r.id !== id))
    setEditingReport(null)
  }

  const rejectReport = async (id) => {
    await fetch(`${API}/api/calendar-event-reports/${id}/reject`, { method: 'PATCH' })
    setReports(prev => prev.filter(r => r.id !== id))
  }

  const reportsByEvent = reports.reduce((acc, r) => {
    const eventId = r.calendar_event_id
    if (!acc[eventId]) acc[eventId] = { event: r.calendar_events, reports: [] }
    acc[eventId].reports.push(r)
    return acc
  }, {})

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display font-extrabold text-2xl tracking-wider uppercase text-apex-text-bright">Moderacja</h1>
        <p className="text-sm text-apex-muted mt-1">Zgłoszenia społeczności i oczekujące wydarzenia</p>
      </div>

      <div className="flex gap-4 border-b border-apex-border">
        <button onClick={() => setTab('pending')} className={`${tabClass} ${tab === 'pending' ? activeTab : inactiveTab}`}>
          Oczekujące ({pendingEvents.length})
        </button>
        <button onClick={() => setTab('reports')} className={`${tabClass} ${tab === 'reports' ? activeTab : inactiveTab}`}>
          Zgłoszenia ({reports.length})
        </button>
      </div>

      {loading && <div className="text-apex-muted py-8">Ładowanie...</div>}

      {!loading && tab === 'pending' && (
        <div className="space-y-3">
          {pendingEvents.length === 0 && <div className="text-apex-muted py-8 text-center">Brak oczekujących wydarzeń.</div>}
          {pendingEvents.map(ev => (
            <div key={ev.id} className="bg-apex-surface border border-apex-border p-4">
              <div className="flex justify-between items-start mb-3">
                <div>
                  <div className="font-display font-bold text-base tracking-wide uppercase text-apex-text-bright">{ev.name}</div>
                  <div className="text-sm text-apex-muted mt-0.5">{ev.date} &middot; {ev.location || '—'} &middot; {ev.voivodeship || '—'}</div>
                </div>
                <div className="flex gap-2">
                  <button onClick={() => approveEvent(ev.id)} className={`${btnBase} bg-apex-yellow text-apex-ink hover:bg-apex-yellow-bright`}>Zatwierdź</button>
                  <button onClick={() => deleteEvent(ev.id)} className={`${btnBase} border border-apex-red text-apex-red hover:bg-apex-red hover:text-white`}>Usuń</button>
                </div>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
                {ev.distances && <div><span className="text-apex-dim">Dystanse:</span> <span className="text-apex-text">{ev.distances.join(', ')}</span></div>}
                {ev.event_type && <div><span className="text-apex-dim">Typ:</span> <span className="text-apex-text">{ev.event_type.join(', ')}</span></div>}
                {ev.organizer && <div><span className="text-apex-dim">Organizator:</span> <span className="text-apex-text">{ev.organizer}</span></div>}
                {ev.registration_url && <div><span className="text-apex-dim">URL:</span> <a href={ev.registration_url} target="_blank" rel="noopener" className="text-apex-cyan hover:underline truncate">{ev.registration_url}</a></div>}
              </div>
              {ev.description && <div className="text-xs text-apex-muted mt-2 line-clamp-2">{ev.description}</div>}
            </div>
          ))}
        </div>
      )}

      {!loading && tab === 'reports' && (
        <div className="space-y-4">
          {Object.keys(reportsByEvent).length === 0 && <div className="text-apex-muted py-8 text-center">Brak zgłoszeń do przejrzenia.</div>}
          {Object.entries(reportsByEvent).map(([eventId, { event, reports: evReports }]) => (
            <div key={eventId} className="bg-apex-surface border border-apex-border p-4">
              <div className="font-display font-bold text-sm tracking-wide uppercase text-apex-text-bright mb-3">
                {event?.name || 'Nieznane wydarzenie'} <span className="text-apex-muted font-mono text-[10px] font-normal ml-2">{event?.date}</span>
              </div>
              <div className="space-y-2">
                {evReports.map(r => (
                  <div key={r.id} className="border border-apex-border bg-apex-bg p-3">
                    <div className="font-mono text-[10px] font-semibold tracking-widest uppercase text-apex-yellow-dim mb-2">{r.field}</div>
                    <div className="grid grid-cols-[1fr_auto_1fr] gap-3 items-start mb-2">
                      <div>
                        <div className="text-[10px] text-apex-dim uppercase mb-0.5">Obecna</div>
                        <div className="text-sm text-apex-muted">{r.old_value || '—'}</div>
                      </div>
                      <div className="text-apex-dim self-center">&rarr;</div>
                      <div>
                        <div className="text-[10px] text-apex-dim uppercase mb-0.5">Sugerowana</div>
                        {editingReport === r.id ? (
                          <input type="text" value={editValue} onChange={(e) => setEditValue(e.target.value)}
                            className="w-full bg-apex-surface border border-apex-yellow-dim text-apex-text-bright text-sm py-1 px-2 outline-none"
                            autoFocus onKeyDown={(e) => e.key === 'Enter' && acceptReport(r.id, editValue)} />
                        ) : (
                          <div className="text-sm text-apex-text-bright">{r.suggested_value || '—'}</div>
                        )}
                      </div>
                    </div>
                    {r.source_url && (
                      <div className="text-[10px] mb-2">
                        <span className="text-apex-dim">Źródło: </span>
                        <a href={r.source_url} target="_blank" rel="noopener" className="text-apex-cyan hover:underline">{r.source_url}</a>
                      </div>
                    )}
                    {r.note && <div className="text-[10px] text-apex-muted mb-2">Notatka: {r.note}</div>}
                    <div className="flex gap-2">
                      {editingReport === r.id ? (
                        <>
                          <button onClick={() => acceptReport(r.id, editValue)} className={`${btnBase} bg-apex-yellow text-apex-ink hover:bg-apex-yellow-bright`}>Zapisz</button>
                          <button onClick={() => setEditingReport(null)} className={`${btnBase} border border-apex-border text-apex-muted`}>Anuluj</button>
                        </>
                      ) : (
                        <>
                          <button onClick={() => acceptReport(r.id)} className={`${btnBase} bg-apex-yellow text-apex-ink hover:bg-apex-yellow-bright`}>Akceptuj</button>
                          <button onClick={() => { setEditingReport(r.id); setEditValue(r.suggested_value || '') }} className={`${btnBase} border border-apex-border text-apex-muted hover:text-apex-text-bright`}>Edytuj</button>
                          <button onClick={() => rejectReport(r.id)} className={`${btnBase} border border-apex-red/50 text-apex-red hover:bg-apex-red hover:text-white`}>Odrzuć</button>
                        </>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
