import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { api } from '../lib/api.js'
import { formatDate } from '../lib/utils.js'
import { Card, CardContent } from '../components/ui/card.jsx'
import { Button } from '../components/ui/button.jsx'
import { Input } from '../components/ui/input.jsx'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogBody, DialogFooter } from '../components/ui/dialog.jsx'
import { CalendarDays, MapPin, Users, Tag, Plus, ArrowRight, Pencil, Trash2 } from 'lucide-react'

const EMPTY_FORM = { name: '', description: '', date: '', location: '', eventUrl: '' }

export default function Events() {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState(EMPTY_FORM)
  const [editEvent, setEditEvent] = useState(null)
  const [editForm, setEditForm] = useState(EMPTY_FORM)
  const [deleteEvent, setDeleteEvent] = useState(null) // event pending deletion
  const [deleteConfirm, setDeleteConfirm] = useState('')
  const [showPast, setShowPast] = useState(false)

  const { data: rows = [], isLoading } = useQuery({
    queryKey: ['events'],
    queryFn: api.events.list,
  })

  // date is a YYYY-MM-DD text column, so string comparison is safe;
  // undated events count as upcoming so they never disappear from the default view
  const today = new Date().toISOString().slice(0, 10)
  const isPast = ({ event }) => !!event.date && event.date < today
  const pastCount = rows.filter(isPast).length
  const visibleRows = rows.filter(r => (showPast ? isPast(r) : !isPast(r)))

  const create = useMutation({
    mutationFn: api.events.create,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['events'] }); setOpen(false); setForm(EMPTY_FORM) },
  })

  const update = useMutation({
    mutationFn: ({ id, body }) => api.events.update(id, body),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['events'] }); setEditEvent(null) },
  })

  const remove = useMutation({
    mutationFn: (id) => api.events.delete(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['events'] }); setDeleteEvent(null); setDeleteConfirm('') },
  })

  const openEdit = (e, event) => {
    e.preventDefault()
    setEditEvent(event)
    setEditForm({ name: event.name, description: event.description || '', date: event.date || '', location: event.location || '', eventUrl: event.eventUrl || '' })
  }

  const openDelete = () => {
    setDeleteEvent(editEvent)
    setDeleteConfirm('')
    setEditEvent(null)
  }

  const confirmMatch = deleteEvent && deleteConfirm === deleteEvent.name

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="font-display text-4xl tracking-widest uppercase text-apex-text-bright">Zawody</h1>
        <div className="flex items-center gap-2">
          <Button variant={showPast ? 'default' : 'outline'} onClick={() => setShowPast(p => !p)}>
            {showPast ? 'Nadchodzące' : `Przeszłe (${pastCount})`}
          </Button>
          <Button onClick={() => setOpen(true)}>
            <Plus size={16} /> Nowe zawody
          </Button>
        </div>
      </div>

      {showPast && (
        <div className="mb-4 text-xs uppercase tracking-wider text-apex-yellow border border-apex-border bg-apex-surface px-3 py-2">
          Przeglądasz zakończone zawody — edytuj ostrożnie, dane wyników są już finalne
        </div>
      )}

      {isLoading && <div className="text-apex-muted text-sm">Ładowanie...</div>}

      <div className="grid gap-3">
        {visibleRows.map(({ event, categoryCount, participantCount }) => (
          <Link key={event.id} to={`/events/${event.id}`} className="block">
            <Card className="hover:border-apex-border-bright transition-colors cursor-pointer">
              <CardContent className="flex items-center justify-between py-3">
                <div className="flex-1 min-w-0">
                  <div className="font-display text-xl uppercase tracking-wider text-apex-text mb-1">{event.name}</div>
                  <div className="flex items-center gap-4 text-xs text-apex-muted">
                    {event.date && <span className="flex items-center gap-1"><CalendarDays size={11} />{formatDate(event.date)}</span>}
                    {event.location && <span className="flex items-center gap-1"><MapPin size={11} />{event.location}</span>}
                    <span className="flex items-center gap-1"><Tag size={11} />{Number(categoryCount)} kategorii</span>
                    <span className="flex items-center gap-1"><Users size={11} />{Number(participantCount)} uczestników</span>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0 ml-4">
                  <button
                    onClick={(e) => openEdit(e, event)}
                    className="p-1.5 text-apex-muted hover:text-apex-text transition-colors"
                  >
                    <Pencil size={14} />
                  </button>
                  <ArrowRight size={16} className="text-apex-muted" />
                </div>
              </CardContent>
            </Card>
          </Link>
        ))}

        {!isLoading && visibleRows.length === 0 && (
          <div className="py-12 text-center text-apex-muted">
            {showPast ? (
              <div className="font-display text-3xl uppercase tracking-wider mb-2">Brak przeszłych zawodów</div>
            ) : (
              <>
                <div className="font-display text-3xl uppercase tracking-wider mb-2">Brak nadchodzących zawodów</div>
                <div className="text-sm">Utwórz nowe zawody, aby rozpocząć</div>
              </>
            )}
          </div>
        )}
      </div>

      {/* Create dialog */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Nowe zawody</DialogTitle>
          </DialogHeader>
          <DialogBody className="space-y-3">
            <label className="block">
              <span className="text-xs font-semibold uppercase tracking-wider text-apex-muted mb-1 block">Nazwa zawodów *</span>
              <Input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="np. Bieg Górski Kraków 2026" />
            </label>
            <label className="block">
              <span className="text-xs font-semibold uppercase tracking-wider text-apex-muted mb-1 block">Data</span>
              <Input type="date" value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))} />
            </label>
            <label className="block">
              <span className="text-xs font-semibold uppercase tracking-wider text-apex-muted mb-1 block">Miejsce</span>
              <Input value={form.location} onChange={e => setForm(f => ({ ...f, location: e.target.value }))} placeholder="Miasto, Obiekt" />
            </label>
            <label className="block">
              <span className="text-xs font-semibold uppercase tracking-wider text-apex-muted mb-1 block">Opis</span>
              <Input value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} placeholder="Opcjonalnie" />
            </label>
            <label className="block">
              <span className="text-xs font-semibold uppercase tracking-wider text-apex-muted mb-1 block">Link do wydarzenia</span>
              <Input type="url" value={form.eventUrl} onChange={e => setForm(f => ({ ...f, eventUrl: e.target.value }))} placeholder="https://..." />
            </label>
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Anuluj</Button>
            <Button onClick={() => create.mutate(form)} disabled={!form.name || create.isPending}>
              {create.isPending ? 'Tworzenie...' : 'Utwórz zawody'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit dialog */}
      <Dialog open={!!editEvent} onOpenChange={(o) => { if (!o) setEditEvent(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edytuj zawody</DialogTitle>
          </DialogHeader>
          <DialogBody className="space-y-3">
            <label className="block">
              <span className="text-xs font-semibold uppercase tracking-wider text-apex-muted mb-1 block">Nazwa zawodów *</span>
              <Input value={editForm.name} onChange={e => setEditForm(f => ({ ...f, name: e.target.value }))} />
            </label>
            <label className="block">
              <span className="text-xs font-semibold uppercase tracking-wider text-apex-muted mb-1 block">Data</span>
              <Input type="date" value={editForm.date} onChange={e => setEditForm(f => ({ ...f, date: e.target.value }))} />
            </label>
            <label className="block">
              <span className="text-xs font-semibold uppercase tracking-wider text-apex-muted mb-1 block">Miejsce</span>
              <Input value={editForm.location} onChange={e => setEditForm(f => ({ ...f, location: e.target.value }))} />
            </label>
            <label className="block">
              <span className="text-xs font-semibold uppercase tracking-wider text-apex-muted mb-1 block">Opis</span>
              <Input value={editForm.description} onChange={e => setEditForm(f => ({ ...f, description: e.target.value }))} />
            </label>
            <label className="block">
              <span className="text-xs font-semibold uppercase tracking-wider text-apex-muted mb-1 block">Link do wydarzenia</span>
              <Input type="url" value={editForm.eventUrl} onChange={e => setEditForm(f => ({ ...f, eventUrl: e.target.value }))} placeholder="https://..." />
            </label>
          </DialogBody>
          <DialogFooter>
            <button onClick={openDelete} className="mr-auto text-red-500 hover:text-red-400 transition-colors p-1.5">
              <Trash2 size={16} />
            </button>
            <Button variant="outline" onClick={() => setEditEvent(null)}>Anuluj</Button>
            <Button onClick={() => update.mutate({ id: editEvent.id, body: editForm })} disabled={!editForm.name || update.isPending}>
              {update.isPending ? 'Zapisywanie...' : 'Zapisz'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation dialog */}
      <Dialog open={!!deleteEvent} onOpenChange={(o) => { if (!o) { setDeleteEvent(null); setDeleteConfirm('') } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Usuń zawody</DialogTitle>
          </DialogHeader>
          <DialogBody className="space-y-4">
            <p className="text-sm text-apex-muted">
              Spowoduje to trwałe usunięcie zawodów wraz ze wszystkimi kategoriami, uczestnikami i wynikami. Tej operacji nie można cofnąć.
            </p>
            <label className="block">
              <span className="text-xs font-semibold uppercase tracking-wider text-apex-muted mb-1 block">
                Wpisz nazwę zawodów, aby potwierdzić:
              </span>
              <span className="text-xs text-apex-text font-mono mb-2 block">{deleteEvent?.name}</span>
              <Input
                value={deleteConfirm}
                onChange={e => setDeleteConfirm(e.target.value)}
                placeholder={deleteEvent?.name}
                autoFocus
              />
            </label>
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setDeleteEvent(null); setDeleteConfirm('') }}>Anuluj</Button>
            <Button
              onClick={() => remove.mutate(deleteEvent.id)}
              disabled={!confirmMatch || remove.isPending}
              className="bg-red-700 hover:bg-red-600 text-white disabled:bg-apex-surface disabled:text-apex-muted"
            >
              {remove.isPending ? 'Usuwanie...' : 'Usuń zawody'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
