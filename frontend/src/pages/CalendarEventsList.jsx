import { useState, useEffect, useCallback, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api.js'

const inputClass = 'w-full bg-apex-surface border border-apex-border text-apex-text-bright font-sans text-sm py-1.5 px-2 outline-none focus:border-apex-yellow-dim'

function InlineEdit({ event, field, onSave }) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(event[field] || '')

  const save = () => {
    if (value !== (event[field] || '')) {
      onSave(event.id, { [field]: value || null })
    }
    setEditing(false)
  }

  if (editing) {
    return (
      <input
        className={inputClass}
        value={value}
        onChange={e => setValue(e.target.value)}
        onBlur={save}
        onKeyDown={e => e.key === 'Enter' && save()}
        autoFocus
      />
    )
  }

  return (
    <span
      className={`cursor-pointer hover:text-apex-yellow-dim ${!event[field] ? 'text-apex-red italic' : ''}`}
      onClick={() => setEditing(true)}
      title="Kliknij aby edytować"
    >
      {event[field] || '—'}
    </span>
  )
}

function InlineArrayEdit({ event, field, onSave }) {
  const [editing, setEditing] = useState(false)
  const arr = event[field] || []
  const [value, setValue] = useState(arr.join(', '))

  const save = () => {
    const newArr = value.split(',').map(s => s.trim()).filter(Boolean)
    onSave(event.id, { [field]: newArr.length > 0 ? newArr : null })
    setEditing(false)
  }

  if (editing) {
    return (
      <input
        className={inputClass}
        value={value}
        onChange={e => setValue(e.target.value)}
        onBlur={save}
        onKeyDown={e => e.key === 'Enter' && save()}
        placeholder="trail, nocny, ..."
        autoFocus
      />
    )
  }

  return (
    <span
      className={`cursor-pointer hover:text-apex-yellow-dim ${arr.length === 0 ? 'text-apex-red italic' : ''}`}
      onClick={() => setEditing(true)}
      title="Kliknij aby edytować"
    >
      {arr.length > 0 ? arr.join(', ') : '—'}
    </span>
  )
}

function EventRow({ event, onSave, onDelete, showReviewActions, onApprove, onReject }) {
  const [confirmDelete, setConfirmDelete] = useState(false)
  const confirmRef = useRef(null)

  useEffect(() => {
    if (confirmDelete && confirmRef.current) confirmRef.current.focus()
  }, [confirmDelete])

  return (
    <tr className="border-b border-apex-border hover:bg-apex-surface-2">
      <td className="py-2 px-2 text-xs"><InlineEdit event={event} field="date" onSave={onSave} /></td>
      <td className="py-2 px-2 text-apex-text-bright font-semibold">
        <div className="flex items-center gap-2 flex-wrap">
          <InlineEdit event={event} field="name" onSave={onSave} />
          {(event.event_type || []).filter(t => t !== 'bieg').map(t => (
            <span key={t} className="font-mono text-[9px] tracking-wide uppercase px-1.5 py-0.5 border border-apex-border text-apex-muted shrink-0">
              {t}
            </span>
          ))}
        </div>
      </td>
      <td className="py-2 px-2 text-xs"><InlineEdit event={event} field="location" onSave={onSave} /></td>
      <td className="py-2 px-2 text-xs"><InlineEdit event={event} field="voivodeship" onSave={onSave} /></td>
      <td className="py-2 px-2 text-xs"><InlineArrayEdit event={event} field="event_type" onSave={onSave} /></td>
      <td className="py-2 px-2 text-xs"><InlineArrayEdit event={event} field="distances" onSave={onSave} /></td>
      <td className="py-2 px-2 text-xs">
        <InlineEdit event={event} field="registration_url" onSave={onSave} />
      </td>
      <td className="py-2 px-2 text-xs text-apex-muted">{event.source}</td>
      <td className="py-2 px-2 text-xs sticky right-0 bg-apex-bg">
        <div className="flex items-center gap-1">
          {showReviewActions && (
            <>
              <button
                onClick={() => onApprove(event.id)}
                className="font-mono text-[9px] font-semibold tracking-wide uppercase px-2 py-0.5 border border-green-700 text-green-400 hover:bg-green-700 hover:text-white transition-all"
                title="Zatwierdź"
              >
                OK
              </button>
              <button
                onClick={() => onReject(event.id)}
                className="font-mono text-[9px] font-semibold tracking-wide uppercase px-2 py-0.5 border border-apex-border text-apex-muted hover:border-red-600 hover:text-red-400 transition-all"
                title="Odrzuć (ukryj na stałe)"
              >
                NIE
              </button>
            </>
          )}
          {confirmDelete ? (
            <div
              ref={confirmRef}
              tabIndex={0}
              onKeyDown={e => {
                if (e.key === 'Enter' || e.key === 'y' || e.key === 'Y') {
                  e.preventDefault()
                  onDelete(event.id)
                  setConfirmDelete(false)
                } else if (e.key === 'Escape') {
                  setConfirmDelete(false)
                }
              }}
              onBlur={() => setConfirmDelete(false)}
              className="flex items-center gap-1"
            >
              <button
                onMouseDown={e => { e.preventDefault(); onDelete(event.id); setConfirmDelete(false) }}
                className="font-mono text-[9px] font-bold tracking-wide uppercase px-1.5 py-0.5 border border-red-600 text-red-400 hover:bg-red-600 hover:text-white transition-all"
              >
                Enter / Y
              </button>
              <button
                onMouseDown={e => { e.preventDefault(); setConfirmDelete(false) }}
                className="font-mono text-[9px] tracking-wide uppercase px-1.5 py-0.5 border border-apex-border text-apex-muted hover:text-apex-text-bright transition-all"
              >
                Esc
              </button>
            </div>
          ) : (
            <button
              onClick={() => setConfirmDelete(true)}
              className="font-mono text-[9px] font-semibold tracking-wide uppercase px-2 py-0.5 border border-apex-border text-apex-muted hover:border-red-600 hover:text-red-400 transition-all"
              title="Usuń"
            >
              X
            </button>
          )}
        </div>
      </td>
    </tr>
  )
}

function DuplicateGroup({ group, onDelete, onDismiss }) {
  const [confirmId, setConfirmId] = useState(null)
  const confirmRef = useRef(null)

  useEffect(() => {
    if (confirmId && confirmRef.current) confirmRef.current.focus()
  }, [confirmId])

  const handleKeyDown = useCallback((e) => {
    if (confirmId && (e.key === 'Enter' || e.key === 'y' || e.key === 'Y')) {
      e.preventDefault()
      onDelete(confirmId)
      setConfirmId(null)
    } else if (e.key === 'Escape') {
      setConfirmId(null)
    }
  }, [confirmId, onDelete])

  return (
    <div className="border border-apex-border mb-3 bg-apex-surface">
      <div className="flex items-center justify-between font-mono text-[10px] tracking-widest uppercase text-apex-yellow-dim px-3 py-2 border-b border-apex-border bg-apex-bg">
        <span>{group[0].date} &middot; {group.length} wpisy</span>
        <button
          onClick={() => onDismiss(group.map(e => e.id))}
          className="font-mono text-[10px] font-semibold tracking-wide uppercase px-2.5 py-0.5 border border-apex-border text-apex-muted hover:border-apex-cyan hover:text-apex-cyan transition-all"
        >
          Nie duplikat
        </button>
      </div>
      {group.map(ev => {
        const meta = []
        if (ev.distances?.length) meta.push(ev.distances.join(', '))
        if (ev.event_type?.length) meta.push(ev.event_type.join(', '))
        if (ev.price_from != null || ev.price_to != null) {
          const p = ev.price_from != null && ev.price_to != null
            ? `${ev.price_from}–${ev.price_to} zł`
            : `${ev.price_from ?? ev.price_to} zł`
          meta.push(p)
        }

        const flags = []
        if (ev.registration_url) flags.push('URL zapisy')
        if (ev.lat != null) flags.push('geo')
        if (ev.is_night) flags.push('nocny')
        if (ev.is_charity) flags.push('charytatywny')

        return (
        <div key={ev.id} className="flex items-start gap-3 px-3 py-2.5 border-b border-apex-border last:border-b-0 hover:bg-apex-surface-2">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm text-apex-text-bright font-semibold">
                {ev.registration_url || ev.source_url ? (
                  <a href={ev.registration_url || ev.source_url} target="_blank" rel="noopener"
                    className="hover:text-apex-yellow underline decoration-apex-border-mid hover:decoration-apex-yellow transition-colors">
                    {ev.name}
                  </a>
                ) : ev.name}
              </span>
              <span className="font-mono text-[10px] text-apex-muted px-1.5 py-0.5 border border-apex-border shrink-0">
                {ev.source}
              </span>
            </div>
            <div className="text-xs text-apex-muted mt-1">
              {ev.location || <span className="italic text-apex-red">brak lokalizacji</span>}
              {ev.voivodeship && <span> &middot; {ev.voivodeship}</span>}
            </div>
            {meta.length > 0 && (
              <div className="text-xs text-apex-text mt-1">
                {meta.join(' · ')}
              </div>
            )}
            <div className="flex gap-1.5 mt-1.5 flex-wrap">
              {flags.map(f => (
                <span key={f} className="font-mono text-[9px] tracking-wide uppercase px-1.5 py-0.5 border border-green-800 text-green-500 bg-green-950/30">
                  {f}
                </span>
              ))}
              {!ev.registration_url && (
                <span className="font-mono text-[9px] tracking-wide uppercase px-1.5 py-0.5 border border-apex-border text-apex-muted">
                  brak URL
                </span>
              )}
              {ev.lat == null && (
                <span className="font-mono text-[9px] tracking-wide uppercase px-1.5 py-0.5 border border-red-900 text-red-500">
                  brak geo
                </span>
              )}
              {(!ev.distances || ev.distances.length === 0) && (
                <span className="font-mono text-[9px] tracking-wide uppercase px-1.5 py-0.5 border border-red-900 text-red-500">
                  brak dystansów
                </span>
              )}
            </div>
          </div>
          <div className="shrink-0">
            {confirmId === ev.id ? (
              <div
                ref={confirmRef}
                tabIndex={0}
                onKeyDown={handleKeyDown}
                onBlur={() => setConfirmId(null)}
                className="flex items-center gap-2"
              >
                <span className="text-xs text-apex-red font-semibold">Usunąć?</span>
                <button
                  onClick={() => { onDelete(ev.id); setConfirmId(null) }}
                  className="font-mono text-[10px] font-bold tracking-wide uppercase px-2.5 py-1 border border-red-600 text-red-400 hover:bg-red-600 hover:text-white transition-all"
                >
                  Enter / Y
                </button>
                <button
                  onClick={() => setConfirmId(null)}
                  className="font-mono text-[10px] tracking-wide uppercase px-2 py-1 border border-apex-border text-apex-muted hover:text-apex-text-bright transition-all"
                >
                  Esc
                </button>
              </div>
            ) : (
              <button
                onClick={() => setConfirmId(ev.id)}
                className="font-mono text-[10px] font-semibold tracking-wide uppercase px-3 py-1 border border-apex-border text-apex-muted hover:border-red-600 hover:text-red-400 transition-all"
                title="Usuń ten wpis"
              >
                Usuń
              </button>
            )}
          </div>
        </div>
        )
      })}
    </div>
  )
}

function DuplicatesView() {
  const queryClient = useQueryClient()

  const { data, isLoading } = useQuery({
    queryKey: ['calendar-events-duplicates'],
    queryFn: async () => {
      const res = await fetch(`${import.meta.env.VITE_API_URL || 'http://localhost:3001'}/api/calendar-events/duplicates`)
      const json = await res.json()
      return json.data
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (id) => api.del(`/calendar-events/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['calendar-events-duplicates'] })
      queryClient.invalidateQueries({ queryKey: ['calendar-events-admin'] })
    },
  })

  const dismissMutation = useMutation({
    mutationFn: (eventIds) => api.post('/calendar-events/dismiss-duplicates', { eventIds }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['calendar-events-duplicates'] })
    },
  })

  const groups = data || []
  const totalDupes = groups.reduce((sum, g) => sum + g.length - 1, 0)

  return (
    <div>
      {isLoading && <div className="text-apex-muted py-8">Szukanie duplikatów...</div>}

      {!isLoading && groups.length === 0 && (
        <div className="text-apex-muted text-center py-12">Brak duplikatów!</div>
      )}

      {!isLoading && groups.length > 0 && (
        <div className="mb-4 text-sm text-apex-muted">
          {groups.length} grup &middot; ~{totalDupes} nadmiarowych wpisów
        </div>
      )}

      {groups.map((group, i) => (
        <DuplicateGroup key={i} group={group} onDelete={(id) => deleteMutation.mutate(id)} onDismiss={(ids) => dismissMutation.mutate(ids)} />
      ))}
    </div>
  )
}

export default function CalendarEventsList() {
  const queryClient = useQueryClient()
  const [filter, setFilter] = useState('review')

  const { data, isLoading } = useQuery({
    queryKey: ['calendar-events-admin', filter],
    queryFn: () => api.get(`/calendar-events?limit=2000&status=${filter === 'review' ? 'pending' : 'active'}&filter=${filter}`),
  })

  const { data: pendingCountData } = useQuery({
    queryKey: ['calendar-events-pending-count'],
    queryFn: () => api.get('/calendar-events?limit=1&status=pending'),
  })

  const { data: dupData } = useQuery({
    queryKey: ['calendar-events-duplicates'],
    queryFn: async () => {
      const res = await fetch(`${import.meta.env.VITE_API_URL || 'http://localhost:3001'}/api/calendar-events/duplicates`)
      const json = await res.json()
      return json.data
    },
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, updates }) => api.patch(`/calendar-events/${id}`, updates),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['calendar-events-admin'] })
      queryClient.invalidateQueries({ queryKey: ['calendar-events-pending-count'] })
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (id) => api.del(`/calendar-events/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['calendar-events-admin'] })
      queryClient.invalidateQueries({ queryKey: ['calendar-events-duplicates'] })
      queryClient.invalidateQueries({ queryKey: ['calendar-events-pending-count'] })
    },
  })

  const approveMutation = useMutation({
    mutationFn: (id) => api.patch(`/calendar-events/${id}/approve`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['calendar-events-admin'] })
      queryClient.invalidateQueries({ queryKey: ['calendar-events-pending-count'] })
    },
  })

  const rejectMutation = useMutation({
    mutationFn: (id) => api.patch(`/calendar-events/${id}/reject`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['calendar-events-admin'] })
      queryClient.invalidateQueries({ queryKey: ['calendar-events-pending-count'] })
    },
  })

  const handleDelete = (id) => deleteMutation.mutate(id)

  const handleSave = (id, updates) => {
    if (updates.distances) {
      const arr = Array.isArray(updates.distances) ? updates.distances : updates.distances.split(',').map(s => s.trim())
      updates.distances = arr
    }
    updateMutation.mutate({ id, updates })
  }

  const events = data?.data || data || []
  const dupGroups = dupData || []
  const pendingCount = pendingCountData?.total ?? 0

  const incomplete = events.filter(e =>
    !e.location || !e.voivodeship || !e.event_type?.length || !e.distances?.length
  )
  const noUrl = events.filter(e => !e.registration_url)
  const complete = events.filter(e =>
    e.location && e.voivodeship && e.event_type?.length && e.distances?.length
  )

  const displayed = filter === 'review' ? events
    : filter === 'incomplete' ? incomplete
    : filter === 'no-url' ? noUrl
    : filter === 'duplicates' ? []
    : events

  const btnClass = (active) =>
    `font-sans text-xs font-semibold tracking-wide uppercase px-4 py-2 border transition-all ${active ? 'bg-apex-yellow text-apex-bg border-apex-yellow' : 'bg-apex-surface border-apex-border text-apex-muted hover:text-apex-text-bright'}`

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="font-display text-3xl font-extrabold tracking-wider uppercase text-apex-text-bright mb-1">
            Wydarzenia w kalendarzu
          </h1>
          <p className="text-apex-muted text-sm">
            {filter === 'review'
              ? `${events.length} do przeglądu`
              : `${incomplete.length} wymaga uzupełnienia · ${complete.length} kompletnych · ${events.length} łącznie`
            }
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => setFilter('review')} className={btnClass(filter === 'review')}>
            Do przeglądu{pendingCount > 0 ? ` (${pendingCount})` : ''}
          </button>
          <button onClick={() => setFilter('incomplete')} className={btnClass(filter === 'incomplete')}>
            Niekompletne ({incomplete.length})
          </button>
          <button onClick={() => setFilter('no-url')} className={btnClass(filter === 'no-url')}>
            Brak URL ({noUrl.length})
          </button>
          <button onClick={() => setFilter('all')} className={btnClass(filter === 'all')}>
            Wszystkie
          </button>
          <button onClick={() => setFilter('duplicates')} className={btnClass(filter === 'duplicates')}>
            Duplikaty{dupGroups.length > 0 ? ` (${dupGroups.length})` : ''}
          </button>
        </div>
      </div>

      {filter === 'duplicates' ? (
        <DuplicatesView />
      ) : (
        <>
          {isLoading && <div className="text-apex-muted">Ładowanie...</div>}

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-apex-border text-left">
                  <th className="font-mono text-[10px] tracking-widest uppercase text-apex-muted py-3 px-2 w-[80px]">Data</th>
                  <th className="font-mono text-[10px] tracking-widest uppercase text-apex-muted py-3 px-2">Nazwa</th>
                  <th className="font-mono text-[10px] tracking-widest uppercase text-apex-muted py-3 px-2 w-[140px]">Miasto</th>
                  <th className="font-mono text-[10px] tracking-widest uppercase text-apex-muted py-3 px-2 w-[140px]">Województwo</th>
                  <th className="font-mono text-[10px] tracking-widest uppercase text-apex-muted py-3 px-2 w-[120px]">Typ</th>
                  <th className="font-mono text-[10px] tracking-widest uppercase text-apex-muted py-3 px-2 w-[120px]">Dystanse</th>
                  <th className="font-mono text-[10px] tracking-widest uppercase text-apex-muted py-3 px-2 w-[180px]">URL zapisy</th>
                  <th className="font-mono text-[10px] tracking-widest uppercase text-apex-muted py-3 px-2 w-[80px]">Źródło</th>
                  <th className="font-mono text-[10px] tracking-widest uppercase text-apex-muted py-3 px-2 w-[120px] sticky right-0 bg-apex-bg">Akcje</th>
                </tr>
              </thead>
              <tbody>
                {displayed.map(event => (
                  <EventRow
                    key={event.id}
                    event={event}
                    onSave={handleSave}
                    onDelete={handleDelete}
                    showReviewActions={filter === 'review'}
                    onApprove={(id) => approveMutation.mutate(id)}
                    onReject={(id) => rejectMutation.mutate(id)}
                  />
                ))}
              </tbody>
            </table>
          </div>

          {!isLoading && displayed.length === 0 && (
            <div className="text-apex-muted text-center py-12">
              {filter === 'review' ? 'Brak wydarzeń do przeglądu!' : filter === 'incomplete' ? 'Wszystkie wydarzenia są kompletne!' : 'Brak wydarzeń.'}
            </div>
          )}
        </>
      )}
    </div>
  )
}
