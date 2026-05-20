import { useState, useEffect, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api.js'
import { ReportsTab, FeedbackTab, useReportsQuery, useFeedbackQuery } from './Moderation.jsx'

const inputClass = 'w-full bg-apex-surface border border-apex-border text-apex-text-bright font-sans text-sm py-1.5 px-2 outline-none focus:border-apex-yellow-dim'

const NUMERIC_FIELDS = new Set(['price_from', 'price_to'])

const hasValue = (v) => v !== null && v !== undefined && v !== ''

function InlineEdit({ event, field, onSave }) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('')

  const current = event[field]
  const filled = hasValue(current)
  const isLocked = (event.locked_fields || []).includes(field)

  const startEdit = () => {
    setValue(filled ? String(current) : '')
    setEditing(true)
  }

  const save = () => {
    const trimmed = value.trim()
    const currentStr = filled ? String(current) : ''
    if (trimmed !== currentStr) {
      let payload
      if (trimmed === '') payload = null
      else if (NUMERIC_FIELDS.has(field)) {
        const n = Number(trimmed)
        payload = Number.isFinite(n) ? n : null
      } else payload = trimmed
      onSave(event.id, { [field]: payload })
    }
    setEditing(false)
  }

  const markEmpty = (e) => {
    e.stopPropagation()
    onSave(event.id, { [field]: null })
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

  if (filled) {
    return (
      <span
        className="cursor-pointer hover:text-apex-yellow-dim"
        onClick={startEdit}
        title="Kliknij aby edytować"
      >
        {String(current)}
      </span>
    )
  }

  if (isLocked) {
    return (
      <span
        className="cursor-pointer hover:text-apex-yellow-dim text-apex-muted italic"
        onClick={startEdit}
        title="Oznaczone jako brak (zatwierdzone)"
      >
        brak
      </span>
    )
  }

  return (
    <span className="inline-flex items-center gap-2">
      <span
        className="cursor-pointer hover:text-apex-yellow-dim text-apex-red italic"
        onClick={startEdit}
        title="Kliknij aby edytować"
      >
        —
      </span>
      <button
        onClick={markEmpty}
        className="font-mono text-[9px] tracking-wide uppercase text-apex-muted hover:text-apex-text-bright underline decoration-dotted underline-offset-2"
        title="Zatwierdź jako brak (event nie ma tej wartości)"
      >
        brak
      </button>
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

function DuplicateUrlField({ event, field, onSave }) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('')
  const current = event[field]
  const isLocked = (event.locked_fields || []).includes(field)

  const startEdit = () => { setValue(current || ''); setEditing(true) }

  const save = () => {
    const trimmed = value.trim()
    if (trimmed !== (current || '')) {
      onSave(event.id, { [field]: trimmed || null })
    }
    setEditing(false)
  }

  const markEmpty = (e) => {
    e.stopPropagation()
    onSave(event.id, { [field]: null })
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

  if (current) {
    return (
      <span className="inline-flex items-center gap-1.5 min-w-0 max-w-full">
        <a
          href={current}
          target="_blank"
          rel="noopener"
          className="text-apex-yellow-dim hover:text-apex-yellow underline decoration-apex-border-mid hover:decoration-apex-yellow truncate"
          onClick={e => e.stopPropagation()}
        >
          {current}
        </a>
        <button
          onClick={startEdit}
          className="text-apex-muted hover:text-apex-text-bright shrink-0 text-[10px]"
          title="Edytuj"
        >
          ✎
        </button>
      </span>
    )
  }

  if (isLocked) {
    return (
      <span
        className="cursor-pointer hover:text-apex-yellow-dim text-apex-muted italic"
        onClick={startEdit}
        title="Oznaczone jako brak (zatwierdzone)"
      >
        brak
      </span>
    )
  }

  return (
    <span className="inline-flex items-center gap-2">
      <span
        className="cursor-pointer hover:text-apex-yellow-dim text-apex-red italic"
        onClick={startEdit}
        title="Kliknij aby edytować"
      >
        —
      </span>
      <button
        onClick={markEmpty}
        className="font-mono text-[9px] tracking-wide uppercase text-apex-muted hover:text-apex-text-bright underline decoration-dotted underline-offset-2"
        title="Zatwierdź jako brak"
      >
        brak
      </button>
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
      <td className="py-2 px-2 text-xs">
        <InlineEdit event={event} field="regulamin_url" onSave={onSave} />
      </td>
      <td className="py-2 px-2 text-xs">
        <InlineEdit event={event} field="website" onSave={onSave} />
      </td>
      <td className="py-2 px-2 text-xs">
        <InlineEdit event={event} field="registration_deadline" onSave={onSave} />
      </td>
      <td className="py-2 px-2 text-xs whitespace-nowrap">
        <InlineEdit event={event} field="price_from" onSave={onSave} />
        <span className="text-apex-muted mx-1">–</span>
        <InlineEdit event={event} field="price_to" onSave={onSave} />
      </td>
      <td className="py-2 px-2 text-xs text-apex-muted">
        <div>{event.source}</div>
        {event.profiles && (
          <a
            href={`https://www.leszy.run/u/${event.profiles.username}`}
            target="_blank"
            rel="noopener"
            className="text-[10px] text-apex-cyan hover:underline"
            title={event.profiles.email}
          >
            @{event.profiles.username}
          </a>
        )}
      </td>
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

function DuplicateEventCard({ event, onSave, onDelete }) {
  const [confirmDelete, setConfirmDelete] = useState(false)
  const confirmRef = useRef(null)

  useEffect(() => {
    if (confirmDelete && confirmRef.current) confirmRef.current.focus()
  }, [confirmDelete])

  return (
    <div className="border-b border-apex-border last:border-b-0 px-3 py-3">
      {/* Header: name + source + delete */}
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex-1 min-w-0 text-sm text-apex-text-bright font-semibold">
          <InlineEdit event={event} field="name" onSave={onSave} />
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="font-mono text-[10px] text-apex-muted px-1.5 py-0.5 border border-apex-border">
            {event.source}
          </span>
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
              <span className="text-xs text-apex-red font-semibold">Usunąć?</span>
              <button
                onClick={() => { onDelete(event.id); setConfirmDelete(false) }}
                className="font-mono text-[10px] font-bold tracking-wide uppercase px-2.5 py-1 border border-red-600 text-red-400 hover:bg-red-600 hover:text-white transition-all"
              >
                Enter / Y
              </button>
              <button
                onClick={() => setConfirmDelete(false)}
                className="font-mono text-[10px] tracking-wide uppercase px-2 py-1 border border-apex-border text-apex-muted hover:text-apex-text-bright transition-all"
              >
                Esc
              </button>
            </div>
          ) : (
            <button
              onClick={() => setConfirmDelete(true)}
              className="font-mono text-[10px] font-semibold tracking-wide uppercase px-3 py-1 border border-apex-border text-apex-muted hover:border-red-600 hover:text-red-400 transition-all"
            >
              Usuń
            </button>
          )}
        </div>
      </div>

      {/* Property grid — 2-column for short fields, full-width for URLs */}
      <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-xs">
        <div className="flex gap-2 items-baseline">
          <span className="text-apex-muted w-24 shrink-0">Data</span>
          <span className="flex-1 min-w-0"><InlineEdit event={event} field="date" onSave={onSave} /></span>
        </div>
        <div className="flex gap-2 items-baseline">
          <span className="text-apex-muted w-24 shrink-0">Miejscowość</span>
          <span className="flex-1 min-w-0"><InlineEdit event={event} field="location" onSave={onSave} /></span>
        </div>
        <div className="flex gap-2 items-baseline">
          <span className="text-apex-muted w-24 shrink-0">Województwo</span>
          <span className="flex-1 min-w-0"><InlineEdit event={event} field="voivodeship" onSave={onSave} /></span>
        </div>
        <div className="flex gap-2 items-baseline">
          <span className="text-apex-muted w-24 shrink-0">Typ</span>
          <span className="flex-1 min-w-0"><InlineArrayEdit event={event} field="event_type" onSave={onSave} /></span>
        </div>
        <div className="flex gap-2 items-baseline">
          <span className="text-apex-muted w-24 shrink-0">Dystanse</span>
          <span className="flex-1 min-w-0"><InlineArrayEdit event={event} field="distances" onSave={onSave} /></span>
        </div>
        <div className="flex gap-2 items-baseline">
          <span className="text-apex-muted w-24 shrink-0">Deadline</span>
          <span className="flex-1 min-w-0"><InlineEdit event={event} field="registration_deadline" onSave={onSave} /></span>
        </div>
        <div className="flex gap-2 items-baseline">
          <span className="text-apex-muted w-24 shrink-0">Cena od</span>
          <span className="flex-1 min-w-0"><InlineEdit event={event} field="price_from" onSave={onSave} /></span>
        </div>
        <div className="flex gap-2 items-baseline">
          <span className="text-apex-muted w-24 shrink-0">Cena do</span>
          <span className="flex-1 min-w-0"><InlineEdit event={event} field="price_to" onSave={onSave} /></span>
        </div>
        <div className="col-span-2 flex gap-2 items-baseline">
          <span className="text-apex-muted w-24 shrink-0">URL zapisy</span>
          <span className="flex-1 min-w-0"><DuplicateUrlField event={event} field="registration_url" onSave={onSave} /></span>
        </div>
        <div className="col-span-2 flex gap-2 items-baseline">
          <span className="text-apex-muted w-24 shrink-0">Regulamin</span>
          <span className="flex-1 min-w-0"><DuplicateUrlField event={event} field="regulamin_url" onSave={onSave} /></span>
        </div>
        <div className="col-span-2 flex gap-2 items-baseline">
          <span className="text-apex-muted w-24 shrink-0">Strona</span>
          <span className="flex-1 min-w-0"><DuplicateUrlField event={event} field="website" onSave={onSave} /></span>
        </div>
      </div>

      {/* Footer: geo status + locked fields */}
      <div className="flex gap-1.5 mt-2.5 flex-wrap">
        {event.lat != null ? (
          <span className="font-mono text-[9px] tracking-wide uppercase px-1.5 py-0.5 border border-green-800 text-green-500 bg-green-950/30">geo</span>
        ) : (
          <span className="font-mono text-[9px] tracking-wide uppercase px-1.5 py-0.5 border border-red-900 text-red-500">brak geo</span>
        )}
        {(event.locked_fields || []).length > 0 && (
          <span className="font-mono text-[9px] tracking-wide uppercase px-1.5 py-0.5 border border-apex-border text-apex-muted">
            locked: {(event.locked_fields || []).join(', ')}
          </span>
        )}
      </div>
    </div>
  )
}

function DuplicateGroup({ group, onDelete, onDismiss, onSave }) {
  return (
    <div className="border border-apex-border mb-4 bg-apex-surface">
      <div className="flex items-center justify-between font-mono text-[10px] tracking-widest uppercase text-apex-yellow-dim px-3 py-2 border-b border-apex-border bg-apex-bg">
        <span>{group[0].date} &middot; {group.length} wpisy</span>
        <button
          onClick={() => onDismiss(group.map(e => e.id))}
          className="font-mono text-[10px] font-semibold tracking-wide uppercase px-2.5 py-0.5 border border-apex-border text-apex-muted hover:border-apex-cyan hover:text-apex-cyan transition-all"
        >
          Nie duplikat
        </button>
      </div>
      {group.map(ev => (
        <DuplicateEventCard key={ev.id} event={ev} onSave={onSave} onDelete={onDelete} />
      ))}
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

  const saveMutation = useMutation({
    mutationFn: ({ id, updates }) => api.patch(`/calendar-events/${id}`, updates),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['calendar-events-duplicates'] })
    },
  })

  const handleSave = (id, updates) => saveMutation.mutate({ id, updates })

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
        <DuplicateGroup
          key={i}
          group={group}
          onDelete={(id) => deleteMutation.mutate(id)}
          onDismiss={(ids) => dismissMutation.mutate(ids)}
          onSave={handleSave}
        />
      ))}
    </div>
  )
}

const PAGE_SIZE = 50

export default function CalendarEventsList() {
  const queryClient = useQueryClient()
  const [filter, setFilter] = useState('review')
  // sub-filter applied inside the "Wszystkie" view: 'all' | 'incomplete'
  const [allSubFilter, setAllSubFilter] = useState('all')
  const [page, setPage] = useState(1)

  // Reset to first page when switching tabs or sub-filters
  useEffect(() => { setPage(1) }, [filter, allSubFilter])

  const { data: pendingEvents, isLoading: pendingLoading } = useQuery({
    queryKey: ['calendar-events-admin', 'pending'],
    queryFn: () => api.get('/calendar-events?limit=2000&status=pending'),
  })

  const { data: activeEvents, isLoading: activeLoading } = useQuery({
    queryKey: ['calendar-events-admin', 'active'],
    queryFn: () => api.get('/calendar-events?limit=2000&status=active'),
  })

  const { data: dupData } = useQuery({
    queryKey: ['calendar-events-duplicates'],
    queryFn: async () => {
      const res = await fetch(`${import.meta.env.VITE_API_URL || 'http://localhost:3001'}/api/calendar-events/duplicates`)
      const json = await res.json()
      return json.data
    },
  })

  // Pull moderation counts so the tab badges stay in sync with the moderation tabs
  const { data: reportsData } = useReportsQuery()
  const { data: feedbackData } = useFeedbackQuery()
  const reportsCount = reportsData?.length || 0
  const feedbackCount = feedbackData?.length || 0

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: ['calendar-events-admin'] })
    queryClient.invalidateQueries({ queryKey: ['calendar-events-duplicates'] })
  }

  const updateMutation = useMutation({
    mutationFn: ({ id, updates }) => api.patch(`/calendar-events/${id}`, updates),
    onSuccess: invalidateAll,
  })

  const deleteMutation = useMutation({
    mutationFn: (id) => api.del(`/calendar-events/${id}`),
    onSuccess: invalidateAll,
  })

  const approveMutation = useMutation({
    mutationFn: (id) => api.patch(`/calendar-events/${id}/approve`),
    onSuccess: invalidateAll,
  })

  const rejectMutation = useMutation({
    mutationFn: (id) => api.patch(`/calendar-events/${id}/reject`),
    onSuccess: invalidateAll,
  })

  const handleDelete = (id) => deleteMutation.mutate(id)

  const handleSave = (id, updates) => {
    if (updates.distances) {
      const arr = Array.isArray(updates.distances) ? updates.distances : updates.distances.split(',').map(s => s.trim())
      updates.distances = arr
    }
    updateMutation.mutate({ id, updates })
  }

  const pending = pendingEvents || []
  const active = activeEvents || []
  const dupGroups = dupData || []
  const isLoading = filter === 'review' ? pendingLoading : filter === 'all' ? activeLoading : false

  // Single source of truth for "what makes an event complete" — matches the enricher's
  // --incomplete criteria so the admin view reflects what the enricher will re-process.
  // A field counts as "decided" if it has a value OR if admin explicitly locked it as empty
  // (the backend auto-adds edited fields to locked_fields, and the "brak" button locks an empty value).
  const isIncomplete = (e) => {
    const locked = new Set(e.locked_fields || [])
    const missing = (field, val) => {
      if (locked.has(field)) return false
      if (Array.isArray(val)) return val.length === 0
      return val === null || val === undefined || val === ''
    }
    return (
      missing('location', e.location) ||
      missing('voivodeship', e.voivodeship) ||
      missing('event_type', e.event_type) ||
      missing('distances', e.distances) ||
      missing('registration_url', e.registration_url) ||
      missing('regulamin_url', e.regulamin_url) ||
      missing('website', e.website) ||
      missing('registration_deadline', e.registration_deadline) ||
      missing('price_from', e.price_from)
    )
  }
  const incomplete = active.filter(isIncomplete)
  const complete = active.filter(e => !isIncomplete(e))

  // In "Wszystkie" view, further narrow by sub-filter ('all' | 'incomplete')
  const allView = allSubFilter === 'incomplete' ? incomplete : active

  const fullList = filter === 'review' ? pending
    : filter === 'all' ? allView
    : []

  const totalPages = Math.max(1, Math.ceil(fullList.length / PAGE_SIZE))
  const clampedPage = Math.min(page, totalPages)
  const displayed = fullList.slice((clampedPage - 1) * PAGE_SIZE, clampedPage * PAGE_SIZE)

  const btnClass = (active) =>
    `font-sans text-xs font-semibold tracking-wide uppercase px-4 py-2 border transition-all ${active ? 'bg-apex-yellow text-apex-bg border-apex-yellow' : 'bg-apex-surface border-apex-border text-apex-muted hover:text-apex-text-bright'}`

  const chipClass = (active) =>
    `font-mono text-[11px] tracking-wider uppercase px-3 py-1 border transition-all ${active ? 'bg-apex-yellow text-apex-bg border-apex-yellow' : 'bg-apex-surface border-apex-border text-apex-muted hover:text-apex-text-bright'}`

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6 gap-4">
        <div>
          <h1 className="font-display text-3xl font-extrabold tracking-wider uppercase text-apex-text-bright mb-1">
            Wydarzenia w kalendarzu
          </h1>
          <p className="text-apex-muted text-sm">
            {filter === 'review' && `${pending.length} do przeglądu`}
            {filter === 'all' && `${incomplete.length} wymaga uzupełnienia · ${complete.length} kompletnych · ${active.length} łącznie`}
            {filter === 'duplicates' && `${dupGroups.length} grup duplikatów`}
            {filter === 'reports' && `${reportsCount} zgłoszeń od społeczności`}
            {filter === 'feedback' && `${feedbackCount} sugestii i uwag`}
          </p>
          <p className="font-mono text-[10px] tracking-widest uppercase text-apex-muted mt-1">
            Źródło danych: Supabase · tabela{' '}
            {filter === 'reports' && <span className="text-apex-text-bright">calendar_event_reports</span>}
            {filter === 'feedback' && <span className="text-apex-text-bright">website_feedback</span>}
            {(filter === 'review' || filter === 'all' || filter === 'duplicates') && <span className="text-apex-text-bright">calendar_events</span>}
            {filter === 'review' && <> · status=<span className="text-apex-text-bright">pending</span></>}
            {filter === 'all' && <> · status=<span className="text-apex-text-bright">active</span></>}
            {(filter === 'reports' || filter === 'feedback') && <> · status=<span className="text-apex-text-bright">pending</span></>}
          </p>
        </div>
        <div className="flex gap-2 flex-wrap justify-end">
          <button onClick={() => setFilter('review')} className={btnClass(filter === 'review')}>
            Do przeglądu{pending.length > 0 ? ` (${pending.length})` : ''}
          </button>
          <button onClick={() => setFilter('all')} className={btnClass(filter === 'all')}>
            Wszystkie ({active.length})
          </button>
          <button onClick={() => setFilter('duplicates')} className={btnClass(filter === 'duplicates')}>
            Duplikaty{dupGroups.length > 0 ? ` (${dupGroups.length})` : ''}
          </button>
          <button onClick={() => setFilter('reports')} className={btnClass(filter === 'reports')}>
            Zgłoszenia{reportsCount > 0 ? ` (${reportsCount})` : ''}
          </button>
          <button onClick={() => setFilter('feedback')} className={btnClass(filter === 'feedback')}>
            Sugestie{feedbackCount > 0 ? ` (${feedbackCount})` : ''}
          </button>
        </div>
      </div>

      {filter === 'all' && (
        <div className="flex gap-2 mb-4 items-center">
          <span className="font-mono text-[10px] tracking-widest uppercase text-apex-muted">Filtruj:</span>
          <button onClick={() => setAllSubFilter('all')} className={chipClass(allSubFilter === 'all')}>
            Wszystkie ({active.length})
          </button>
          <button onClick={() => setAllSubFilter('incomplete')} className={chipClass(allSubFilter === 'incomplete')}>
            Niekompletne ({incomplete.length})
          </button>
        </div>
      )}

      {filter === 'duplicates' ? (
        <DuplicatesView />
      ) : filter === 'reports' ? (
        <ReportsTab />
      ) : filter === 'feedback' ? (
        <FeedbackTab />
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
                  <th className="font-mono text-[10px] tracking-widest uppercase text-apex-muted py-3 px-2 w-[180px]">Regulamin</th>
                  <th className="font-mono text-[10px] tracking-widest uppercase text-apex-muted py-3 px-2 w-[180px]">Website</th>
                  <th className="font-mono text-[10px] tracking-widest uppercase text-apex-muted py-3 px-2 w-[110px]">Deadline</th>
                  <th className="font-mono text-[10px] tracking-widest uppercase text-apex-muted py-3 px-2 w-[120px]">Cena</th>
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

          {!isLoading && fullList.length === 0 && (
            <div className="text-apex-muted text-center py-12">
              {filter === 'review' ? 'Brak wydarzeń do przeglądu!'
                : filter === 'all' && allSubFilter === 'incomplete' ? 'Wszystkie wydarzenia są kompletne!'
                : 'Brak wydarzeń.'}
            </div>
          )}

          {!isLoading && fullList.length > PAGE_SIZE && (
            <div className="flex items-center justify-between mt-4 py-3 border-t border-apex-border">
              <div className="font-mono text-[11px] tracking-wider uppercase text-apex-muted">
                Strona {clampedPage} z {totalPages} · wyświetlono {((clampedPage - 1) * PAGE_SIZE) + 1}–{Math.min(clampedPage * PAGE_SIZE, fullList.length)} z {fullList.length}
              </div>
              <div className="flex gap-2">
                <button onClick={() => setPage(1)} disabled={clampedPage === 1} className={chipClass(false) + ' disabled:opacity-30 disabled:cursor-not-allowed'}>« Pierwsza</button>
                <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={clampedPage === 1} className={chipClass(false) + ' disabled:opacity-30 disabled:cursor-not-allowed'}>‹ Poprzednia</button>
                <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={clampedPage === totalPages} className={chipClass(false) + ' disabled:opacity-30 disabled:cursor-not-allowed'}>Następna ›</button>
                <button onClick={() => setPage(totalPages)} disabled={clampedPage === totalPages} className={chipClass(false) + ' disabled:opacity-30 disabled:cursor-not-allowed'}>Ostatnia »</button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
