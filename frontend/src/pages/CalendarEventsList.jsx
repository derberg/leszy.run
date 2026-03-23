import { useState } from 'react'
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

export default function CalendarEventsList() {
  const queryClient = useQueryClient()
  const [filter, setFilter] = useState('incomplete')

  const { data, isLoading } = useQuery({
    queryKey: ['calendar-events-admin', filter],
    queryFn: () => api.get(`/calendar-events?limit=200&filter=${filter}`),
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, updates }) => api.patch(`/calendar-events/${id}`, updates),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['calendar-events-admin'] }),
  })

  const handleSave = (id, updates) => {
    // If distances text changes, also update distances_meters
    if (updates.distances) {
      const arr = Array.isArray(updates.distances) ? updates.distances : updates.distances.split(',').map(s => s.trim())
      updates.distances = arr
      updates.distances_meters = arr.map(d => {
        const num = parseFloat(d)
        return isNaN(num) ? 0 : Math.round(num * (d.toLowerCase().includes('km') ? 1000 : 1))
      }).filter(n => n > 0)
    }
    updateMutation.mutate({ id, updates })
  }

  const events = data?.data || data || []

  const incomplete = events.filter(e =>
    !e.location || !e.voivodeship || !e.event_type?.length || !e.distances?.length
  )
  const complete = events.filter(e =>
    e.location && e.voivodeship && e.event_type?.length && e.distances?.length
  )

  const displayed = filter === 'incomplete' ? incomplete : events

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="font-display text-3xl font-extrabold tracking-wider uppercase text-apex-text-bright mb-1">
            Wydarzenia w kalendarzu
          </h1>
          <p className="text-apex-muted text-sm">
            {incomplete.length} wydarzeń wymaga uzupełnienia &middot; {complete.length} kompletnych &middot; {events.length} łącznie
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setFilter('incomplete')}
            className={`font-sans text-xs font-semibold tracking-wide uppercase px-4 py-2 border transition-all ${filter === 'incomplete' ? 'bg-apex-yellow text-apex-bg border-apex-yellow' : 'bg-apex-surface border-apex-border text-apex-muted hover:text-apex-text-bright'}`}
          >
            Niekompletne ({incomplete.length})
          </button>
          <button
            onClick={() => setFilter('all')}
            className={`font-sans text-xs font-semibold tracking-wide uppercase px-4 py-2 border transition-all ${filter === 'all' ? 'bg-apex-yellow text-apex-bg border-apex-yellow' : 'bg-apex-surface border-apex-border text-apex-muted hover:text-apex-text-bright'}`}
          >
            Wszystkie
          </button>
        </div>
      </div>

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
              <th className="font-mono text-[10px] tracking-widest uppercase text-apex-muted py-3 px-2 w-[80px]">Źródło</th>
            </tr>
          </thead>
          <tbody>
            {displayed.map(event => (
              <tr key={event.id} className="border-b border-apex-border hover:bg-apex-surface-2">
                <td className="py-2 px-2 font-mono text-xs text-apex-yellow">{event.date}</td>
                <td className="py-2 px-2 text-apex-text-bright font-semibold">{event.name}</td>
                <td className="py-2 px-2 text-xs"><InlineEdit event={event} field="location" onSave={handleSave} /></td>
                <td className="py-2 px-2 text-xs"><InlineEdit event={event} field="voivodeship" onSave={handleSave} /></td>
                <td className="py-2 px-2 text-xs"><InlineArrayEdit event={event} field="event_type" onSave={handleSave} /></td>
                <td className="py-2 px-2 text-xs"><InlineArrayEdit event={event} field="distances" onSave={handleSave} /></td>
                <td className="py-2 px-2 text-xs text-apex-muted">{event.source}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {!isLoading && displayed.length === 0 && (
        <div className="text-apex-muted text-center py-12">
          {filter === 'incomplete' ? 'Wszystkie wydarzenia są kompletne!' : 'Brak wydarzeń.'}
        </div>
      )}
    </div>
  )
}
