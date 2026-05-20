import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api.js'

const btnBase = 'font-display font-bold text-[11px] tracking-widest uppercase px-3 py-1.5 transition-all'
const inputClass = 'w-full bg-apex-surface border border-apex-yellow-dim text-apex-text-bright text-sm py-1.5 px-2.5 outline-none'
const labelClass = 'text-[10px] text-apex-dim uppercase mb-0.5'

const VOIVODESHIPS = [
  'Dolnośląskie', 'Kujawsko-Pomorskie', 'Łódzkie', 'Lubelskie', 'Lubuskie',
  'Małopolskie', 'Mazowieckie', 'Opolskie', 'Podkarpackie', 'Podlaskie',
  'Pomorskie', 'Śląskie', 'Świętokrzyskie', 'Warmińsko-Mazurskie',
  'Wielkopolskie', 'Zachodniopomorskie',
]

const EVENT_TYPES = ['uliczny', 'trail', 'ultra', 'nordic', 'ocr', 'nocny', 'charytatywny', 'dzieci']

function EditableEvent({ event, onSave, onApprove, onDelete, showSaveOnly }) {
  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState({ ...event })
  const [confirmDelete, setConfirmDelete] = useState(false)

  const set = (key, val) => setForm(f => ({ ...f, [key]: val }))

  const handleSave = async () => {
    const updates = {}
    if (form.name !== event.name) updates.name = form.name
    if (form.date !== event.date) updates.date = form.date
    if (form.location !== event.location) updates.location = form.location || null
    if (form.voivodeship !== event.voivodeship) updates.voivodeship = form.voivodeship || null
    if (form.registration_url !== event.registration_url) updates.registration_url = form.registration_url || null
    if (JSON.stringify(form.distances) !== JSON.stringify(event.distances)) {
      updates.distances = form.distances
    }
    if (JSON.stringify(form.event_type) !== JSON.stringify(event.event_type)) updates.event_type = form.event_type

    if (Object.keys(updates).length > 0) {
      await onSave(event.id, updates)
    }
    setEditing(false)
  }

  const toggleType = (t) => {
    const current = form.event_type || []
    set('event_type', current.includes(t) ? current.filter(x => x !== t) : [...current, t])
  }

  if (!editing) {
    return (
      <div className="bg-apex-surface border border-apex-border p-4">
        <div className="flex justify-between items-start mb-3">
          <div>
            <div className="font-display font-bold text-base tracking-wide uppercase text-apex-text-bright">{event.name}</div>
            <div className="text-sm text-apex-muted mt-0.5">{event.date} &middot; {event.location || '—'} &middot; {event.voivodeship || '—'}</div>
          </div>
          <div className="flex gap-2">
            <button onClick={() => setEditing(true)} className={`${btnBase} border border-apex-border text-apex-muted hover:text-apex-text-bright`}>Edytuj</button>
            <button onClick={() => onApprove(event.id)} className={`${btnBase} bg-apex-yellow text-apex-ink hover:bg-apex-yellow-bright`}>Zatwierdź</button>
            {confirmDelete ? (
              <>
                <button onClick={() => { onDelete(event.id); setConfirmDelete(false) }} className={`${btnBase} bg-apex-red text-white`}>Potwierdź</button>
                <button onClick={() => setConfirmDelete(false)} className={`${btnBase} border border-apex-border text-apex-muted`}>Anuluj</button>
              </>
            ) : (
              <button onClick={() => setConfirmDelete(true)} className={`${btnBase} border border-apex-red text-apex-red hover:bg-apex-red hover:text-white`}>Usuń</button>
            )}
          </div>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
          {event.distances?.length > 0 && <div><span className="text-apex-dim">Dystanse:</span> <span className="text-apex-text">{event.distances.join(', ')}</span></div>}
          {event.event_type?.length > 0 && <div><span className="text-apex-dim">Typ:</span> <span className="text-apex-text">{event.event_type.join(', ')}</span></div>}
          {event.registration_url && <div className="col-span-2"><span className="text-apex-dim">URL:</span> <a href={event.registration_url} target="_blank" rel="noopener" className="text-apex-cyan hover:underline">{event.registration_url}</a></div>}
          <div>
            <span className="text-apex-dim">Geo:</span>{' '}
            {event.lat != null && event.lng != null ? (
              <a href={`https://www.google.com/maps?q=${event.lat},${event.lng}`} target="_blank" rel="noopener" className="text-apex-cyan hover:underline">
                {event.lat.toFixed(4)}, {event.lng.toFixed(4)}
              </a>
            ) : (
              <span className="text-apex-red">brak</span>
            )}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="bg-apex-surface border border-apex-yellow-dim p-4">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
        <div>
          <div className={labelClass}>Nazwa</div>
          <input value={form.name || ''} onChange={e => set('name', e.target.value)} className={inputClass} />
        </div>
        <div>
          <div className={labelClass}>Data</div>
          <input type="date" value={form.date || ''} onChange={e => set('date', e.target.value)} className={inputClass} />
        </div>
        <div>
          <div className={labelClass}>Miasto</div>
          <input value={form.location || ''} onChange={e => set('location', e.target.value)} className={inputClass} />
        </div>
        <div>
          <div className={labelClass}>Województwo</div>
          <select value={form.voivodeship || ''} onChange={e => set('voivodeship', e.target.value)} className={`${inputClass} appearance-none cursor-pointer`}>
            <option value="">—</option>
            {VOIVODESHIPS.map(v => <option key={v} value={v}>{v}</option>)}
          </select>
        </div>
        <div>
          <div className={labelClass}>Dystanse (oddzielone przecinkami, np. "5 km, 10 km")</div>
          <input value={(form.distances || []).join(', ')} onChange={e => set('distances', e.target.value.split(',').map(s => s.trim()).filter(Boolean))} className={inputClass} />
        </div>
        <div>
          <div className={labelClass}>Link do wydarzenia</div>
          <input type="url" value={form.registration_url || ''} onChange={e => set('registration_url', e.target.value)} className={inputClass} />
        </div>
        <div className="md:col-span-2">
          <div className={labelClass}>Typ wydarzenia</div>
          <div className="flex flex-wrap gap-1.5">
            {EVENT_TYPES.map(t => (
              <button key={t} type="button" onClick={() => toggleType(t)}
                className={`font-mono text-[10px] font-semibold px-2 py-1 border transition-all ${(form.event_type || []).includes(t) ? 'border-apex-cyan text-apex-cyan bg-apex-cyan/10' : 'border-apex-border text-apex-muted'}`}>
                {t}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="flex gap-2">
        {showSaveOnly ? (
          <button onClick={handleSave} className={`${btnBase} bg-apex-yellow text-apex-ink hover:bg-apex-yellow-bright`}>Zapisz</button>
        ) : (
          <>
            <button onClick={handleSave} className={`${btnBase} border border-apex-yellow text-apex-yellow hover:bg-apex-yellow/10`}>Zapisz</button>
            <button onClick={async () => { await handleSave(); onApprove(event.id) }} className={`${btnBase} bg-apex-yellow text-apex-ink hover:bg-apex-yellow-bright`}>Zapisz i zatwierdź</button>
          </>
        )}
        <button onClick={() => { setForm({ ...event }); setEditing(false) }} className={`${btnBase} border border-apex-border text-apex-muted`}>Anuluj</button>
      </div>
    </div>
  )
}

const CATEGORY_BADGES = {
  missing_feature: { label: 'Funkcja', cls: 'border-apex-cyan text-apex-cyan' },
  bug: { label: 'Błąd', cls: 'border-apex-red text-apex-red' },
  content: { label: 'Treść', cls: 'border-apex-yellow text-apex-yellow' },
  other: { label: 'Inne', cls: 'border-apex-border text-apex-muted' },
}

function getRelativeTime(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `${mins} min temu`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours} godz. temu`
  const days = Math.floor(hours / 24)
  return `${days} dni temu`
}

function FeedbackItem({ item, onReview, onDismiss }) {
  const [note, setNote] = useState('')
  const badge = CATEGORY_BADGES[item.category] || CATEGORY_BADGES.other
  const ago = getRelativeTime(item.created_at)

  return (
    <div className="bg-apex-surface border border-apex-border p-4">
      <div className="flex items-center gap-3 mb-2 flex-wrap">
        <span className={`font-mono text-[10px] font-semibold px-2 py-0.5 border ${badge.cls}`}>
          {badge.label}
        </span>
        <span className="font-mono text-[10px] text-apex-muted">{ago}</span>
        {item.profiles ? (
          <a
            href={`https://www.leszy.run/u/${item.profiles.username}`}
            target="_blank"
            rel="noopener"
            className="font-mono text-[10px] text-apex-cyan hover:underline ml-auto"
            title={item.profiles.email}
          >
            @{item.profiles.username}
            {item.profiles.display_name ? ` (${item.profiles.display_name})` : ''}
          </a>
        ) : item.email ? (
          <a href={`mailto:${item.email}`} className="font-mono text-[10px] text-apex-cyan hover:underline ml-auto">{item.email}</a>
        ) : (
          <span className="font-mono text-[10px] text-apex-muted ml-auto">anon</span>
        )}
      </div>
      <p className="text-sm text-apex-text mb-3 whitespace-pre-wrap">{item.message}</p>
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Notatka (opcjonalnie)"
          className="flex-1 bg-apex-bg border border-apex-border text-apex-text-bright text-xs py-1.5 px-2.5 outline-none focus:border-apex-yellow-dim"
        />
        <button onClick={() => onReview(item.id, note)} className={`${btnBase} bg-apex-yellow text-apex-ink hover:bg-apex-yellow-bright`}>
          Przeczytane
        </button>
        <button onClick={() => onDismiss(item.id, note)} className={`${btnBase} border border-apex-red/50 text-apex-red hover:bg-apex-red hover:text-white`}>
          Odrzuć
        </button>
      </div>
    </div>
  )
}

export const reportsQueryKey = ['calendar-event-reports', 'pending']
export const feedbackQueryKey = ['website-feedback', 'pending']

export function useReportsQuery() {
  return useQuery({
    queryKey: reportsQueryKey,
    queryFn: () => api.get('/calendar-event-reports?status=pending'),
  })
}

export function useFeedbackQuery() {
  return useQuery({
    queryKey: feedbackQueryKey,
    queryFn: () => api.get('/website-feedback?status=pending'),
  })
}

export function ReportsTab() {
  const queryClient = useQueryClient()
  const { data, isLoading, error } = useReportsQuery()
  const reports = data || []
  const [editingEventId, setEditingEventId] = useState(null)

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: reportsQueryKey })
    queryClient.invalidateQueries({ queryKey: ['calendar-events-admin'] })
  }

  const updateEvent = useMutation({
    mutationFn: ({ id, updates }) => api.patch(`/calendar-events/${id}`, updates),
  })

  const acceptReport = useMutation({
    mutationFn: (id) => api.patch(`/calendar-event-reports/${id}/accept`),
  })

  const rejectReport = useMutation({
    mutationFn: (id) => api.patch(`/calendar-event-reports/${id}/reject`),
  })

  const saveReportEvent = async (eventId, updates) => {
    if (Object.keys(updates).length > 0) {
      await updateEvent.mutateAsync({ id: eventId, updates })
    }
    const eventReports = reports.filter(r => r.calendar_event_id === eventId)
    await Promise.all(eventReports.map(r => acceptReport.mutateAsync(r.id)))
    invalidate()
    setEditingEventId(null)
  }

  const rejectReportGroup = async (eventId) => {
    const eventReports = reports.filter(r => r.calendar_event_id === eventId)
    await Promise.all(eventReports.map(r => rejectReport.mutateAsync(r.id)))
    invalidate()
  }

  const reportsByEvent = reports.reduce((acc, r) => {
    const eventId = r.calendar_event_id
    if (!acc[eventId]) acc[eventId] = { event: r.calendar_events, reports: [] }
    acc[eventId].reports.push(r)
    return acc
  }, {})

  if (isLoading) return <div className="text-apex-muted py-8">Ładowanie...</div>
  if (error) return <div className="border border-apex-red bg-apex-red/10 text-apex-red text-sm px-4 py-2">{error.message}</div>

  return (
    <div className="space-y-4">
      {Object.keys(reportsByEvent).length === 0 && <div className="text-apex-muted py-8 text-center">Brak zgłoszeń do przejrzenia.</div>}
      {Object.entries(reportsByEvent).map(([eventId, { event, reports: evReports }]) => (
        <div key={eventId} className="bg-apex-surface border border-apex-border p-4">
          <div className="font-display font-bold text-sm tracking-wide uppercase mb-3">
            {event?.registration_url ? (
              <a href={event.registration_url} target="_blank" rel="noopener" className="text-apex-cyan hover:underline">{event?.name || 'Nieznane wydarzenie'}</a>
            ) : (
              <span className="text-apex-text-bright">{event?.name || 'Nieznane wydarzenie'}</span>
            )}
            <span className="text-apex-muted font-mono text-[10px] font-normal ml-2">{event?.date}</span>
          </div>
          <div className="space-y-2 mb-4">
            {evReports.map(r => (
              <div key={r.id} className="border border-apex-border bg-apex-bg p-3">
                <div className="flex items-center gap-3 mb-1 flex-wrap">
                  <span className="font-mono text-[10px] font-semibold tracking-widest uppercase text-apex-yellow-dim">{r.field}</span>
                  <span className="text-sm text-apex-muted">{r.old_value || '—'}</span>
                  <span className="text-apex-dim">&rarr;</span>
                  <span className="text-sm text-apex-text-bright">{r.suggested_value || '—'}</span>
                  {r.profiles ? (
                    <a
                      href={`https://www.leszy.run/u/${r.profiles.username}`}
                      target="_blank"
                      rel="noopener"
                      className="font-mono text-[10px] text-apex-cyan hover:underline ml-auto"
                      title={r.profiles.email}
                    >
                      @{r.profiles.username}
                    </a>
                  ) : (
                    <span className="font-mono text-[10px] text-apex-muted ml-auto">anon</span>
                  )}
                </div>
                {r.source_url && (
                  <div className="text-[10px]">
                    <span className="text-apex-dim">Źródło: </span>
                    <a href={r.source_url} target="_blank" rel="noopener" className="text-apex-cyan hover:underline">{r.source_url}</a>
                  </div>
                )}
                {r.note && <div className="text-[10px] text-apex-muted">Notatka: {r.note}</div>}
              </div>
            ))}
          </div>

          {editingEventId === eventId && event ? (
            <EditableEvent
              event={event}
              onSave={(id, updates) => saveReportEvent(id, updates)}
              onApprove={(id) => saveReportEvent(id, {})}
              onDelete={() => { setEditingEventId(null); rejectReportGroup(eventId) }}
              showSaveOnly
            />
          ) : (
            <div className="flex gap-2">
              <button onClick={() => setEditingEventId(eventId)} className={`${btnBase} border border-apex-border text-apex-muted hover:text-apex-text-bright`}>Edytuj wydarzenie</button>
              <button onClick={() => rejectReportGroup(eventId)} className={`${btnBase} border border-apex-red/50 text-apex-red hover:bg-apex-red hover:text-white`}>Odrzuć</button>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

export function FeedbackTab() {
  const queryClient = useQueryClient()
  const { data, isLoading, error } = useFeedbackQuery()
  const feedback = data || []

  const reviewMutation = useMutation({
    mutationFn: ({ id, adminNote }) => api.patch(`/website-feedback/${id}/review`, { admin_note: adminNote || null }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: feedbackQueryKey }),
  })

  const dismissMutation = useMutation({
    mutationFn: ({ id, adminNote }) => api.patch(`/website-feedback/${id}/dismiss`, { admin_note: adminNote || null }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: feedbackQueryKey }),
  })

  if (isLoading) return <div className="text-apex-muted py-8">Ładowanie...</div>
  if (error) return <div className="border border-apex-red bg-apex-red/10 text-apex-red text-sm px-4 py-2">{error.message}</div>

  return (
    <div className="space-y-3">
      {feedback.length === 0 && <div className="text-apex-muted py-8 text-center">Brak sugestii do przejrzenia.</div>}
      {feedback.map(f => (
        <FeedbackItem
          key={f.id}
          item={f}
          onReview={(id, adminNote) => reviewMutation.mutate({ id, adminNote })}
          onDismiss={(id, adminNote) => dismissMutation.mutate({ id, adminNote })}
        />
      ))}
    </div>
  )
}
