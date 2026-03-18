import { useState, useCallback } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useReactTable, getCoreRowModel, flexRender } from '@tanstack/react-table'
import { api } from '../../lib/api.js'
import { cn } from '../../lib/utils.js'
import { Button } from '../ui/button.jsx'
import { Input } from '../ui/input.jsx'
import { Badge } from '../ui/badge.jsx'
import { AlertDialog, AlertDialogContent, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogAction, AlertDialogCancel } from '../ui/alert-dialog.jsx'
import RfidAssignDialog from './RfidAssignDialog.jsx'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogBody, DialogFooter } from '../ui/dialog.jsx'
import { Trash2, Wifi, UserCheck, UserX, Plus, X, MessageSquare, Send, Check } from 'lucide-react'

export default function ParticipantsTable({ eventId, categories }) {
  const qc = useQueryClient()
  const [editingCell, setEditingCell] = useState(null) // { rowId, columnId }
  const [rfidTarget, setRfidTarget] = useState(null)
  const [deleteTarget, setDeleteTarget] = useState(null)
  const [addOpen, setAddOpen] = useState(false)
  const [addForm, setAddForm] = useState({ firstName: '', lastName: '', email: '', phone: '', club: '', gender: '', birthDate: '', categoryId: '' })
  const [emailError, setEmailError] = useState('')
  const [bulkSmsOpen, setBulkSmsOpen] = useState(false)
  const [sendingSmsFor, setSendingSmsFor] = useState(null) // participant id being sent
  const [minorCheckinTarget, setMinorCheckinTarget] = useState(null) // participant needing doc confirmation
  const [minorDocChecks, setMinorDocChecks] = useState({}) // { docId: true/false }

  const { data: participants = [] } = useQuery({
    queryKey: ['participants', eventId],
    queryFn: () => api.participants.list(eventId),
  })

  const { data: eventDocuments = [] } = useQuery({
    queryKey: ['documents', eventId],
    queryFn: () => api.documents.list(eventId),
  })

  const update = useMutation({
    mutationFn: ({ id, ...body }) => api.participants.update(id, body),
    onMutate: async ({ id, ...body }) => {
      await qc.cancelQueries({ queryKey: ['participants', eventId] })
      const prev = qc.getQueryData(['participants', eventId])
      qc.setQueryData(['participants', eventId], old =>
        old?.map(p => p.id === id ? { ...p, ...body } : p)
      )
      return { prev }
    },
    onError: (_, __, ctx) => qc.setQueryData(['participants', eventId], ctx.prev),
    onSettled: () => qc.invalidateQueries({ queryKey: ['participants', eventId] }),
  })

  const deletePart = useMutation({
    mutationFn: api.participants.delete,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['participants', eventId] }); setDeleteTarget(null) },
  })

  const addPart = useMutation({
    mutationFn: (body) => api.participants.create(eventId, body),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['participants', eventId] }); setAddOpen(false); setAddForm({ firstName: '', lastName: '', email: '', phone: '', club: '', gender: '', birthDate: '', categoryId: '' }); setEmailError('') },
  })

  const sendSms = useMutation({
    mutationFn: (participantIds) => api.sms.sendToParticipants(eventId, participantIds),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['participants', eventId] }); setSendingSmsFor(null) },
  })

  const sendAllSms = useMutation({
    mutationFn: () => api.sms.sendToAll(eventId),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['participants', eventId] }); setBulkSmsOpen(false) },
  })

  const checkinMutation = useMutation({
    mutationFn: ({ participantId, documents }) => api.participants.checkin(participantId, documents),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['participants', eventId] }); setMinorCheckinTarget(null); setMinorDocChecks({}) },
  })

  const catMap = Object.fromEntries((categories || []).map(c => [c.id, c.name]))

  const isMinor = (p) => {
    if (!p.birthDate) return false
    const birth = new Date(p.birthDate)
    const today = new Date()
    let age = today.getFullYear() - birth.getFullYear()
    const m = today.getMonth() - birth.getMonth()
    if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) age--
    return age < 18
  }

  const provideDocs = eventDocuments.filter(d => d.type === 'provide')
  const minorProvideDocs = provideDocs.filter(d => d.requiredFor === 'all' || d.requiredFor === 'minors')

  const handleCheckinClick = (p) => {
    if (isMinor(p) && minorProvideDocs.length > 0) {
      setMinorCheckinTarget(p)
      setMinorDocChecks({})
    } else {
      checkinMutation.mutate({ participantId: p.id })
    }
  }

  const handleSave = useCallback((participantId, field, value) => {
    update.mutate({ id: participantId, [field]: value === '' ? null : value })
    setEditingCell(null)
  }, [update])

  const EditableCell = ({ participant, field, type = 'text', display }) => {
    const isEditing = editingCell?.rowId === participant.id && editingCell?.columnId === field
    const value = participant[field]

    if (isEditing) {
      return (
        <Input
          className="h-7 text-xs w-full min-w-20 border-apex-yellow focus:ring-1"
          type={type}
          defaultValue={value ?? ''}
          autoFocus
          onBlur={e => handleSave(participant.id, field, e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') e.target.blur()
            if (e.key === 'Escape') setEditingCell(null)
          }}
        />
      )
    }

    return (
      <div
        className="cursor-text hover:bg-terrain-sand px-1 py-0.5 min-h-6 min-w-12 rounded-sm text-xs"
        onClick={() => setEditingCell({ rowId: participant.id, columnId: field })}
      >
        {display ?? (value || <span className="text-apex-text">—</span>)}
      </div>
    )
  }

  const CategoryCell = ({ participant }) => {
    const isEditing = editingCell?.rowId === participant.id && editingCell?.columnId === 'categoryId'
    const catName = participant.categoryId ? catMap[participant.categoryId] : null

    if (isEditing) {
      return (
        <select
          className="h-7 text-xs border border-apex-yellow bg-apex-surface px-1 focus:outline-none w-full"
          defaultValue={participant.categoryId ?? ''}
          autoFocus
          onChange={e => { handleSave(participant.id, 'categoryId', e.target.value || null) }}
          onBlur={e => { handleSave(participant.id, 'categoryId', e.target.value || null) }}
        >
          <option value="">— Brak —</option>
          {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      )
    }

    return (
      <div
        className="cursor-text hover:bg-terrain-sand px-1 py-0.5 min-h-6 text-xs rounded-sm"
        onClick={() => setEditingCell({ rowId: participant.id, columnId: 'categoryId' })}
      >
        {catName || <span className="text-apex-text">—</span>}
      </div>
    )
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <span className="text-sm text-apex-muted">{participants.length} uczestników</span>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => setBulkSmsOpen(true)}>
            <MessageSquare size={13} /> Wyślij SMS do wszystkich
          </Button>
          <Button size="sm" onClick={() => setAddOpen(true)}><Plus size={13} /> Dodaj uczestnika</Button>
        </div>
      </div>

      <div className="border border-apex-border bg-apex-surface overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-apex-border bg-apex-surface-2">
              {['Emoji', 'Nr', 'Imię', 'Nazwisko', 'Email', 'Tel', 'Klub', 'Płeć', 'Data ur.', 'Kategoria', 'RFID', 'SMS', 'Z', ''].map(h => (
                <th key={h} className="text-left px-3 py-2 text-xs font-bold uppercase tracking-wider text-apex-muted whitespace-nowrap">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-apex-border">
            {participants.map(p => (
              <tr key={p.id} className="hover:bg-apex-surface-2 group">
                <td className="px-2 py-1 w-10 text-center text-lg">{p.emoji || '🏃'}</td>
                <td className="px-2 py-1 w-14"><EditableCell participant={p} field="bibNumber" type="number" /></td>
                <td className="px-2 py-1"><EditableCell participant={p} field="firstName" /></td>
                <td className="px-2 py-1"><EditableCell participant={p} field="lastName" /></td>
                <td className="px-2 py-1 max-w-36"><EditableCell participant={p} field="email" type="email" /></td>
                <td className="px-2 py-1 max-w-28"><EditableCell participant={p} field="phone" type="tel" /></td>
                <td className="px-2 py-1"><EditableCell participant={p} field="club" /></td>
                <td className="px-2 py-1 w-16">
                  <select
                    className="text-xs bg-transparent border-0 cursor-pointer focus:outline-none hover:bg-terrain-sand"
                    value={p.gender ?? ''}
                    onChange={e => update.mutate({ id: p.id, gender: e.target.value || null })}
                  >
                    <option value="">—</option>
                    <option value="M">M</option>
                    <option value="K">K</option>
                  </select>
                </td>
                <td className="px-2 py-1 w-28">
                  <EditableCell
                    participant={p}
                    field="birthDate"
                    type="date"
                    display={p.birthDate ? p.birthDate.split('-').reverse().join('.') : null}
                  />
                </td>
                <td className="px-2 py-1 min-w-28"><CategoryCell participant={p} /></td>
                <td className="px-2 py-1 w-28">
                  {p.rfidEpc ? (
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => setRfidTarget(p)}
                        className="flex items-center gap-1 text-xs text-apex-yellow hover:text-apex-yellow-dark font-mono"
                        title={p.rfidEpc}
                      >
                        <Wifi size={11} />
                        <span>{p.rfidEpc}</span>
                      </button>
                      <button
                        onClick={() => update.mutate({ id: p.id, rfidEpc: null })}
                        className="text-apex-muted hover:text-apex-red opacity-0 group-hover:opacity-100 transition-opacity"
                        title="Odpisz RFID"
                      >
                        <X size={11} />
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setRfidTarget(p)}
                      className="text-xs text-apex-text hover:text-apex-yellow flex items-center gap-1"
                    >
                      <Wifi size={11} /> Przypisz
                    </button>
                  )}
                </td>
                <td className="px-2 py-1 w-16">
                  {p.smsSentAt ? (
                    <span className="text-apex-yellow" title={`Wysłano: ${new Date(p.smsSentAt).toLocaleString('pl-PL')}`}>
                      <Check size={14} />
                    </span>
                  ) : p.phone ? (
                    <button
                      onClick={() => { setSendingSmsFor(p.id); sendSms.mutate([p.id]) }}
                      disabled={sendingSmsFor === p.id}
                      className="text-xs text-apex-text hover:text-apex-yellow flex items-center gap-1"
                    >
                      <Send size={11} /> Wyślij
                    </button>
                  ) : (
                    <span className="text-apex-muted text-xs">—</span>
                  )}
                </td>
                <td className="px-2 py-1 w-8">
                  {(() => {
                    const isCheckedIn = !!p.checkin?.checkedInAt
                    return (
                      <button
                        onClick={() => !isCheckedIn && handleCheckinClick(p)}
                        className={cn('transition-colors', isCheckedIn ? 'text-apex-yellow' : 'text-apex-text hover:text-apex-muted')}
                        title={isCheckedIn ? 'Zameldowany' : 'Zamelduj'}
                        disabled={isCheckedIn}
                      >
                        {isCheckedIn ? <UserCheck size={14} /> : <UserX size={14} />}
                      </button>
                    )
                  })()}
                </td>
                <td className="px-2 py-1 w-8">
                  <button
                    onClick={() => setDeleteTarget(p)}
                    className="text-apex-muted hover:text-apex-red opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <Trash2 size={13} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {participants.length === 0 && (
          <div className="py-8 text-center text-apex-muted text-sm">Brak uczestników. Dodaj powyżej lub zaimportuj z CSV.</div>
        )}
      </div>

      {rfidTarget && (
        <RfidAssignDialog
          participant={rfidTarget}
          onAssign={async (epc) => { await update.mutateAsync({ id: rfidTarget.id, rfidEpc: epc }); setRfidTarget(null) }}
          onClose={() => setRfidTarget(null)}
        />
      )}

      <AlertDialog open={!!deleteTarget} onOpenChange={o => !o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogTitle>Usuń uczestnika</AlertDialogTitle>
          <AlertDialogDescription>
            Usunąć <strong>#{deleteTarget?.bibNumber} {deleteTarget?.firstName} {deleteTarget?.lastName}</strong>?
            Tej operacji nie można cofnąć.
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel asChild><Button variant="outline">Anuluj</Button></AlertDialogCancel>
            <AlertDialogAction asChild>
              <Button variant="destructive" onClick={() => deletePart.mutate(deleteTarget.id)}>Usuń</Button>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {addOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-apex-surface border border-apex-border-mid w-full max-w-md shadow-xl">
            <div className="border-b border-apex-border px-5 py-4">
              <h2 className="font-display text-2xl uppercase tracking-wider">Dodaj uczestnika</h2>
            </div>
            <div className="px-5 py-4 grid grid-cols-2 gap-3">
              {[['firstName','Imię *'],['lastName','Nazwisko *'],['phone','Telefon'],['club','Klub']].map(([k, l]) => (
                <label key={k} className="block">
                  <span className="text-xs font-bold uppercase tracking-widest text-apex-muted mb-1 block">{l}</span>
                  <Input value={addForm[k]} onChange={e => setAddForm(f => ({ ...f, [k]: e.target.value }))} />
                </label>
              ))}
              <label className="block">
                <span className="text-xs font-bold uppercase tracking-widest text-apex-muted mb-1 block">Email</span>
                <Input
                  type="email"
                  value={addForm.email}
                  onChange={e => {
                    setAddForm(f => ({ ...f, email: e.target.value }))
                    setEmailError(e.target.value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.target.value) ? 'Nieprawidłowy adres email' : '')
                  }}
                  className={emailError ? 'border-red-500 focus-visible:ring-red-500' : ''}
                />
                {emailError && <span className="text-xs text-red-500 mt-0.5 block">{emailError}</span>}
              </label>
              <label className="block">
                <span className="text-xs font-bold uppercase tracking-widest text-apex-muted mb-1 block">Data urodzenia</span>
                <Input
                  type="date"
                  value={addForm.birthDate}
                  min="1900-01-01"
                  max={new Date().toISOString().split('T')[0]}
                  onChange={e => setAddForm(f => ({ ...f, birthDate: e.target.value }))}
                />
              </label>
              <label className="block">
                <span className="text-xs font-bold uppercase tracking-widest text-apex-muted mb-1 block">Płeć</span>
                <select
                  className="h-9 w-full border border-apex-border-mid bg-apex-surface px-3 text-sm text-apex-text rounded-none"
                  value={addForm.gender}
                  onChange={e => setAddForm(f => ({ ...f, gender: e.target.value }))}
                >
                  <option value="">— Wybierz —</option>
                  <option value="M">M</option>
                  <option value="K">K</option>
                </select>
              </label>
              <label className="block col-span-2">
                <span className="text-xs font-bold uppercase tracking-widest text-apex-muted mb-1 block">Kategoria</span>
                <select
                  className="h-9 w-full border border-apex-border-mid bg-apex-surface px-3 text-sm text-apex-text rounded-none"
                  value={addForm.categoryId}
                  onChange={e => setAddForm(f => ({ ...f, categoryId: e.target.value }))}
                >
                  <option value="">— Brak —</option>
                  {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </label>
            </div>
            <div className="flex justify-end gap-2 border-t border-apex-border px-5 py-4">
              <Button variant="outline" onClick={() => { setAddOpen(false); setEmailError('') }}>Anuluj</Button>
              <Button
                onClick={() => addPart.mutate({ ...addForm, birthDate: addForm.birthDate || null, categoryId: addForm.categoryId || null, phone: addForm.phone || null })}
                disabled={!addForm.firstName || !addForm.lastName || !!emailError || addPart.isPending}
              >
                Dodaj
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Bulk SMS dialog */}
      <Dialog open={bulkSmsOpen} onOpenChange={setBulkSmsOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Wyślij SMS do wszystkich</DialogTitle>
          </DialogHeader>
          <DialogBody className="space-y-3">
            {(() => {
              const withPhone = participants.filter(p => p.phone)
              const withoutPhone = participants.filter(p => !p.phone)
              const alreadySent = participants.filter(p => p.smsSentAt)
              const toSend = withPhone.filter(p => !p.smsSentAt)
              return (
                <div className="space-y-2 text-sm">
                  <p className="text-apex-text-bright">Podsumowanie:</p>
                  <ul className="space-y-1 text-apex-muted">
                    <li>Do wysłania: <span className="text-apex-text-bright font-bold">{toSend.length}</span> (mają telefon, bez SMS)</li>
                    <li>Już wysłano: <span className="text-apex-text-bright">{alreadySent.length}</span></li>
                    <li>Bez numeru telefonu: <span className="text-apex-text-bright">{withoutPhone.length}</span></li>
                  </ul>
                  {toSend.length === 0 && (
                    <p className="text-xs text-apex-muted mt-2">Brak uczestników do wysłania SMS.</p>
                  )}
                </div>
              )
            })()}
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBulkSmsOpen(false)}>Anuluj</Button>
            <Button
              onClick={() => sendAllSms.mutate()}
              disabled={sendAllSms.isPending || participants.filter(p => p.phone && !p.smsSentAt).length === 0}
            >
              <Send size={13} /> {sendAllSms.isPending ? 'Wysyłanie...' : 'Wyślij'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Minor check-in dialog — provide-type documents */}
      <Dialog open={!!minorCheckinTarget} onOpenChange={o => { if (!o) { setMinorCheckinTarget(null); setMinorDocChecks({}) } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Zamelduj nieletniego</DialogTitle>
          </DialogHeader>
          <DialogBody className="space-y-3">
            <p className="text-sm text-apex-muted">
              <strong>{minorCheckinTarget?.firstName} {minorCheckinTarget?.lastName}</strong> — potwierdź odbiór dokumentów:
            </p>
            <div className="space-y-2">
              {minorProvideDocs.map(doc => (
                <label key={doc.id} className="flex items-center gap-2 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={!!minorDocChecks[doc.id]}
                    onChange={e => setMinorDocChecks(prev => ({ ...prev, [doc.id]: e.target.checked }))}
                    className="accent-apex-yellow w-4 h-4"
                  />
                  <span className="text-apex-text">{doc.name}</span>
                </label>
              ))}
            </div>
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setMinorCheckinTarget(null); setMinorDocChecks({}) }}>Anuluj</Button>
            <Button
              onClick={() => {
                const docs = minorProvideDocs.map(d => ({ documentId: d.id, completed: !!minorDocChecks[d.id] }))
                checkinMutation.mutate({ participantId: minorCheckinTarget.id, documents: docs })
              }}
              disabled={checkinMutation.isPending || minorProvideDocs.some(d => !minorDocChecks[d.id])}
            >
              Zamelduj
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
