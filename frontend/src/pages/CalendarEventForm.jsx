import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { api } from '../lib/api.js'

const EMPTY_EVENT = {
  name: '', date: '', location: '', voivodeship: '',
  event_type: [], distances: '',
  registration_url: '', website: '',
  is_night: false, is_charity: false,
}

export default function CalendarEventForm() {
  const [form, setForm] = useState(EMPTY_EVENT)
  const [success, setSuccess] = useState(null)

  const mutation = useMutation({
    mutationFn: (data) => api.post('/calendar-events', data),
    onSuccess: () => {
      setSuccess('Wydarzenie dodane!')
      setForm(EMPTY_EVENT)
      setTimeout(() => setSuccess(null), 3000)
    },
  })

  const update = (key, value) => setForm(prev => ({ ...prev, [key]: value }))

  const handleSubmit = (e) => {
    e.preventDefault()
    const data = {
      ...form,
      distances: form.distances ? form.distances.split(',').map(d => d.trim()) : [],
      distances_meters: form.distances
        ? form.distances.split(',').map(d => Math.round(parseFloat(d.trim()) * 1000))
        : [],
    }
    mutation.mutate(data)
  }

  const inputClass = "w-full bg-apex-surface border border-apex-border text-apex-text-bright font-sans text-sm py-2.5 px-3 outline-none focus:border-apex-yellow-dim"

  return (
    <div className="p-6 max-w-2xl">
      <h1 className="font-display text-3xl font-extrabold tracking-wider uppercase text-apex-text-bright mb-2">
        Dodaj wydarzenie
      </h1>
      <p className="text-apex-muted text-sm mb-8">
        Recznie dodaj wydarzenie do kalendarza (np. znalezione na Facebook).
      </p>

      {success && <div className="bg-apex-yellow/10 border border-apex-yellow/20 text-apex-yellow px-4 py-3 mb-6 text-sm">{success}</div>}

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div>
          <label className="font-mono text-[10px] tracking-widest uppercase text-apex-muted block mb-1">Nazwa *</label>
          <input required value={form.name} onChange={e => update('name', e.target.value)} className={inputClass} />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="font-mono text-[10px] tracking-widest uppercase text-apex-muted block mb-1">Data *</label>
            <input required type="date" value={form.date} onChange={e => update('date', e.target.value)} className={inputClass} />
          </div>
          <div>
            <label className="font-mono text-[10px] tracking-widest uppercase text-apex-muted block mb-1">Miejscowosc</label>
            <input value={form.location} onChange={e => update('location', e.target.value)} className={inputClass} />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="font-mono text-[10px] tracking-widest uppercase text-apex-muted block mb-1">Wojewodztwo</label>
            <input value={form.voivodeship} onChange={e => update('voivodeship', e.target.value)} className={inputClass} />
          </div>
          <div>
            <label className="font-mono text-[10px] tracking-widest uppercase text-apex-muted block mb-1">Dystanse (km, po przecinku)</label>
            <input value={form.distances} onChange={e => update('distances', e.target.value)} placeholder="5, 10, 21.1" className={inputClass} />
          </div>
        </div>
        <div>
          <label className="font-mono text-[10px] tracking-widest uppercase text-apex-muted block mb-1">URL zapisow</label>
          <input type="url" value={form.registration_url} onChange={e => update('registration_url', e.target.value)} className={inputClass} />
        </div>
        <div className="flex gap-6">
          <label className="flex items-center gap-2 text-sm text-apex-text cursor-pointer">
            <input type="checkbox" checked={form.is_night} onChange={e => update('is_night', e.target.checked)} />
            Bieg nocny
          </label>
          <label className="flex items-center gap-2 text-sm text-apex-text cursor-pointer">
            <input type="checkbox" checked={form.is_charity} onChange={e => update('is_charity', e.target.checked)} />
            Charytatywny
          </label>
        </div>

        <button type="submit" disabled={mutation.isPending}
          className="font-display font-bold text-sm tracking-widest uppercase py-3 px-8 bg-apex-yellow text-apex-bg hover:shadow-[0_0_20px_rgba(187,221,0,0.3)] transition-all disabled:opacity-50 self-start">
          {mutation.isPending ? 'Dodawanie...' : 'Dodaj wydarzenie'}
        </button>
      </form>
    </div>
  )
}
