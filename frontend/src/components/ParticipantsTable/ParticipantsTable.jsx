import { useState, useCallback } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useReactTable, getCoreRowModel, flexRender } from '@tanstack/react-table'
import { api } from '../../lib/api.js'
import { cn } from '../../lib/utils.js'
import { sortParticipants } from '../../lib/participantOrder.js'
import { checkinCounts } from '../../lib/checkinCounts.js'
import { teamLabels, teamLabelText, teamMembersByTeam, teamOptions, newTeamId, legAfterMove, hostTeamNameToSave, HOST_TEAM_NAME_MAX } from '../../lib/teamGroups.js'
import { Button } from '../ui/button.jsx'
import { Input } from '../ui/input.jsx'
import { Badge } from '../ui/badge.jsx'
import { AlertDialog, AlertDialogContent, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogAction, AlertDialogCancel } from '../ui/alert-dialog.jsx'
import RfidAssignDialog from './RfidAssignDialog.jsx'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogBody, DialogFooter } from '../ui/dialog.jsx'
import { Trash2, Wifi, UserCheck, UserX, Plus, X, MessageSquare, Send, Check, RotateCcw, Ban, Users, Pencil } from 'lucide-react'
import { Tooltip } from '../ui/tooltip.jsx'

export default function ParticipantsTable({ eventId, categories }) {
  const qc = useQueryClient()
  const [editingCell, setEditingCell] = useState(null) // { rowId, columnId }
  const [rfidTarget, setRfidTarget] = useState(null)
  const [deleteTarget, setDeleteTarget] = useState(null)
  const [addOpen, setAddOpen] = useState(false)
  const [addForm, setAddForm] = useState({ firstName: '', lastName: '', email: '', phone: '', club: '', gender: '', birthDate: '', categoryId: '', tshirtSize: '' })
  const [emailError, setEmailError] = useState('')
  const [bulkSmsOpen, setBulkSmsOpen] = useState(false)
  const [sendingSmsFor, setSendingSmsFor] = useState(null) // participant id being sent
  const [minorCheckinTarget, setMinorCheckinTarget] = useState(null) // participant needing doc confirmation
  const [minorDocChecks, setMinorDocChecks] = useState({}) // { docId: true/false }
  const [tshirtConfirmed, setTshirtConfirmed] = useState(false)
  const [teamsOnly, setTeamsOnly] = useState(false)

  const { data: participants = [] } = useQuery({
    queryKey: ['participants', eventId],
    queryFn: () => api.participants.list(eventId),
  })

  // Only an event with team members asks for team names (a registration team's read from
  // Supabase and never stored; a host team's from host_teams).
  const teamCats = new Set((categories || []).filter(c => c.teamMode).map(c => c.id))
  const hasTeams = participants.some(p => p.teamId) || teamCats.size > 0
  const { data: teamNames = {} } = useQuery({
    queryKey: ['team-names', eventId],
    queryFn: () => api.participants.teamNames(eventId),
    enabled: hasTeams,
    staleTime: 60_000,
  })

  const renameTeam = useMutation({
    mutationFn: ({ teamId, name }) => api.participants.setHostTeamName(eventId, teamId, name),
    onMutate: async ({ teamId, name }) => {
      await qc.cancelQueries({ queryKey: ['team-names', eventId] })
      const prev = qc.getQueryData(['team-names', eventId])
      qc.setQueryData(['team-names', eventId], old => ({ ...(old || {}), [teamId]: name }))
      return { prev }
    },
    onError: (_, __, ctx) => qc.setQueryData(['team-names', eventId], ctx.prev),
    onSettled: () => qc.invalidateQueries({ queryKey: ['team-names', eventId] }),
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

  const regenEmoji = useMutation({
    mutationFn: (id) => api.participants.regenerateEmoji(id),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: ['participants', eventId] })
      const prev = qc.getQueryData(['participants', eventId])
      qc.setQueryData(['participants', eventId], old =>
        old?.map(p => p.id === id ? { ...p, emoji: '⏳' } : p)
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
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['participants', eventId] }); setAddOpen(false); setAddForm({ firstName: '', lastName: '', email: '', phone: '', club: '', gender: '', birthDate: '', categoryId: '', tshirtSize: '' }); setEmailError('') },
  })

  const sendSms = useMutation({
    mutationFn: (participantIds) => api.sms.sendToParticipants(eventId, participantIds),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['participants', eventId] }); setSendingSmsFor(null) },
  })

  const sendAllSms = useMutation({
    mutationFn: () => api.sms.sendToAll(eventId),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['participants', eventId] }); setBulkSmsOpen(false) },
  })

  const [checkinError, setCheckinError] = useState(null)
  const checkinMutation = useMutation({
    mutationFn: ({ participantId, documents }) => api.participants.checkin(participantId, documents),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['participants', eventId] }); setMinorCheckinTarget(null); setMinorDocChecks({}); setTshirtConfirmed(false); setCheckinError(null) },
    onError: (err) => setCheckinError(err.message),
  })

  const uncheckinMutation = useMutation({
    mutationFn: (participantId) => api.participants.uncheckin(participantId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['participants', eventId] }),
  })

  const [withdrawTarget, setWithdrawTarget] = useState(null)
  const withdraw = useMutation({
    mutationFn: (participantId) => api.participants.withdraw(participantId),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['participants', eventId] }); setWithdrawTarget(null) },
  })
  const unwithdraw = useMutation({
    mutationFn: (participantId) => api.participants.unwithdraw(participantId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['participants', eventId] }),
  })
  const openWithdraw = (p) => { withdraw.reset(); setWithdrawTarget(p) }

  const catMap = Object.fromEntries((categories || []).map(c => [c.id, c.name]))
  // A leg number means something only in a fixed-order relay; 'relay_free' runs in any order.
  const fixedLegCats = new Set((categories || []).filter(c => c.teamMode === 'relay').map(c => c.id))

  // Display order: category (event's category order), then last name, then
  // first name, see lib/participantOrder.js. The API returns rows in bib order;
  // the table body renders this array directly (no TanStack sort model).
  const labels = teamLabels(participants, teamNames)
  const teamCount = labels.size
  const showTeamsOnly = hasTeams && teamsOnly
  const sortedParticipants = showTeamsOnly
    ? teamMembersByTeam(participants, labels)
    : sortParticipants(participants, categories)

  const isMinor = (p) => {
    if (!p?.birthDate) return false
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
    const needsMinorDocs = isMinor(p) && minorProvideDocs.length > 0
    if (needsMinorDocs || p.tshirtSize) {
      setMinorCheckinTarget(p)
      setMinorDocChecks({})
      setTshirtConfirmed(false)
      setCheckinError(null)
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
        className="cursor-text hover:bg-terrain-sand px-1 py-0.5 min-h-6 min-w-12 rounded-sm text-xs truncate"
        onClick={() => setEditingCell({ rowId: participant.id, columnId: field })}
        title={value || ''}
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
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        {(() => {
          const counts = checkinCounts(participants)
          return (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-apex-muted whitespace-nowrap">
              <span>{counts.total} uczestników</span>
              <span className="flex items-center gap-1 text-apex-cyan" title="Samozameldowanie online (QR)">
                <UserCheck size={13} /> {counts.selfCheckins} QR
              </span>
              <span className="flex items-center gap-1 text-apex-yellow" title="Zameldowani przez organizatora">
                <UserCheck size={13} /> {counts.confirmed} potwierdzonych
              </span>
              {counts.withdrawn > 0 && (
                <span className="flex items-center gap-1" title="Zameldowani, ale nie startują">
                  <Ban size={13} /> {counts.withdrawn} nie startuje
                </span>
              )}
              {update.error && (
                <span className="text-apex-red">Nie zapisano zmiany: {update.error.message}</span>
              )}
              {renameTeam.error && (
                <span className="text-apex-red">Nie zapisano nazwy drużyny: {renameTeam.error.message}</span>
              )}
              {unwithdraw.error && (
                <span className="text-apex-red">Nie udało się cofnąć „nie startuje”: {unwithdraw.error.message}</span>
              )}
            </div>
          )
        })()}
        <div className="flex items-center gap-2">
          {hasTeams && (
            <Button size="sm" variant={showTeamsOnly ? 'default' : 'outline'} className="whitespace-nowrap" onClick={() => setTeamsOnly(v => !v)} aria-pressed={showTeamsOnly}>
              <Users size={13} /> Drużyny ({teamCount})
            </Button>
          )}
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
              {['', 'Nr', 'Zawodnik', 'Kontakt', 'Klub', 'Płeć / ur.', hasTeams ? 'Kategoria / drużyna' : 'Kategoria', 'Kosz.', 'RFID', 'SMS', 'Z', 'NS', ''].map((h, hi) => (
                <th key={hi} className="text-left px-2 py-2 text-xs font-bold uppercase tracking-wider text-apex-muted whitespace-nowrap">
                  {h === 'Z' ? (
                    <Tooltip content={
                      <div className="flex flex-col gap-1.5 font-normal normal-case tracking-normal whitespace-nowrap">
                        <span className="flex items-center gap-2"><span className="text-apex-yellow">●</span> Potwierdzone przez organizatora</span>
                        <span className="flex items-center gap-2"><span className="text-apex-cyan">●</span> Samozameldowanie online — czeka na odbiór pakietu</span>
                        <span className="flex items-center gap-2"><span className="text-apex-muted">●</span> Niezameldowany</span>
                      </div>
                    }>
                      <span className="cursor-default inline-flex items-center gap-1">
                        Z
                        <span className="text-apex-muted/50 text-[10px] border border-apex-border rounded-full w-3.5 h-3.5 inline-flex items-center justify-center leading-none">?</span>
                      </span>
                    </Tooltip>
                  ) : h === 'NS' ? (
                    <span className="cursor-default" title="Nie startuje: wynik DNS, odczyty chipa ignorowane">NS</span>
                  ) : h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-apex-border">
            {sortedParticipants.map((p, i) => (
              <tr key={p.id} className={cn(
                'hover:bg-apex-surface-2 group',
                p.withdrawnAt && '[&>td:not(.keep)]:opacity-45',
                showTeamsOnly && i > 0 && sortedParticipants[i - 1].teamId !== p.teamId && 'border-t-2 border-t-apex-border-bright',
              )}>
                <td className="px-2 py-1 w-10 text-center text-lg group/emoji relative">
                  <span>{p.emoji || '🏃'}</span>
                  <button
                    className="absolute inset-0 flex items-center justify-center opacity-0 group-hover/emoji:opacity-100 bg-apex-surface/80 transition-opacity cursor-pointer"
                    onClick={() => regenEmoji.mutate(p.id)}
                    title="Regenerate emoji"
                  >
                    <RotateCcw className="w-3.5 h-3.5 text-apex-yellow" />
                  </button>
                </td>
                <td className="px-2 py-1 w-14"><EditableCell participant={p} field="bibNumber" type="number" /></td>
                <td className="keep px-2 py-1 min-w-40 max-w-56">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <div className={cn('flex min-w-0 flex-1 [&>div]:min-w-0', p.withdrawnAt && 'line-through opacity-45')}>
                      <EditableCell participant={p} field="firstName" />
                      <EditableCell participant={p} field="lastName" />
                    </div>
                    {p.withdrawnAt && (
                      <span className="shrink-0 border border-apex-yellow text-apex-yellow font-mono text-[10px] font-bold px-1 leading-4">DNS</span>
                    )}
                  </div>
                </td>
                <td className="px-2 py-1 max-w-44">
                  <EditableCell participant={p} field="email" type="email" />
                  <EditableCell participant={p} field="phone" type="tel" />
                </td>
                <td className="px-2 py-1 max-w-40"><EditableCell participant={p} field="club" /></td>
                <td className="px-2 py-1 w-24">
                  <select
                    className="text-xs bg-transparent border-0 cursor-pointer focus:outline-none hover:bg-terrain-sand"
                    value={p.gender ?? ''}
                    onChange={e => update.mutate({ id: p.id, gender: e.target.value || null })}
                  >
                    <option value="">—</option>
                    <option value="M">M</option>
                    <option value="K">K</option>
                  </select>
                  <EditableCell
                    participant={p}
                    field="birthDate"
                    type="date"
                    display={p.birthDate ? p.birthDate.split('-').reverse().join('.') : null}
                  />
                </td>
                <td className="px-2 py-1 min-w-28 max-w-48">
                  <CategoryCell participant={p} />
                  {hasTeams && (p.teamId || teamCats.has(p.categoryId)) && (
                    <TeamCell
                      participant={p} participants={participants} labels={labels}
                      fixedLeg={fixedLegCats.has(p.categoryId)}
                      editingCell={editingCell} setEditingCell={setEditingCell}
                      onUpdate={update.mutate} onRename={renameTeam.mutate}
                    />
                  )}
                </td>
                <td className="px-2 py-1 w-14"><EditableCell participant={p} field="tshirtSize" /></td>
                <td className="px-2 py-1 w-24">
                  {p.rfidEpc ? (
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => setRfidTarget(p)}
                        className="flex items-center gap-1 whitespace-nowrap text-xs text-apex-yellow hover:text-apex-yellow-dark font-mono"
                        title={p.rfidEpc}
                      >
                        <Wifi size={11} />
                        <span>{p.rfidEpc.length > 8 ? `…${p.rfidEpc.slice(-6)}` : p.rfidEpc}</span>
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
                <td className="px-2 py-1 w-12">
                  {p.smsSentAt ? (
                    <div className="flex items-center gap-1">
                      <span className="text-apex-yellow" title={`Wysłano: ${new Date(p.smsSentAt).toLocaleString('pl-PL')}`}>
                        <Check size={14} />
                      </span>
                      {!p.checkin && p.phone && (
                        <button
                          onClick={() => { setSendingSmsFor(p.id); sendSms.mutate([p.id]) }}
                          disabled={sendingSmsFor === p.id}
                          className="text-xs text-apex-muted hover:text-apex-yellow"
                          title="Wyślij ponownie"
                        >
                          <RotateCcw size={11} />
                        </button>
                      )}
                    </div>
                  ) : p.phone ? (
                    <button
                      onClick={() => { setSendingSmsFor(p.id); sendSms.mutate([p.id]) }}
                      disabled={sendingSmsFor === p.id}
                      className="text-xs text-apex-text hover:text-apex-yellow flex items-center gap-1"
                      title="Wyślij SMS z linkiem do zameldowania"
                    >
                      <Send size={13} />
                    </button>
                  ) : (
                    <span className="text-apex-muted text-xs">—</span>
                  )}
                </td>
                <td className="px-2 py-1 w-8">
                  {(() => {
                    const confirmedAt = p.checkin?.checkedInAt
                    const selfCheckedIn = p.checkin && !confirmedAt
                    const isCheckedIn = !!confirmedAt
                    const tshirtNote = p.tshirtSize ? ` | 👕 Koszulka: ${p.tshirtSize}` : ''
                    const title = confirmedAt
                      ? `Zameldowany przez organizatora: ${new Date(confirmedAt).toLocaleString('pl-PL')} — kliknij aby cofnąć`
                      : selfCheckedIn
                      ? `Samozameldowanie online${p.checkin.createdAt ? ': ' + new Date(p.checkin.createdAt).toLocaleString('pl-PL') : ''} — potwierdź odbiór pakietu${tshirtNote}`
                      : `Zamelduj${tshirtNote}`
                    return (
                      <button
                        onClick={() => {
                          if (isCheckedIn) uncheckinMutation.mutate(p.id)
                          else handleCheckinClick(p)
                        }}
                        className={cn('transition-colors',
                          isCheckedIn ? 'text-apex-yellow hover:text-apex-muted' :
                          selfCheckedIn ? 'text-apex-cyan' :
                          'text-apex-text hover:text-apex-muted'
                        )}
                        title={title}
                      >
                        {isCheckedIn ? <UserCheck size={14} /> : selfCheckedIn ? <UserCheck size={14} /> : <UserX size={14} />}
                      </button>
                    )
                  })()}
                </td>
                <td className="keep px-2 py-1 w-8">
                  {p.withdrawnAt ? (
                    <button
                      onClick={() => unwithdraw.mutate(p.id)}
                      className="text-apex-yellow hover:text-apex-muted transition-colors"
                      title={`Nie startuje od ${new Date(p.withdrawnAt).toLocaleString('pl-PL')} — kliknij aby cofnąć`}
                    >
                      <Ban size={14} />
                    </button>
                  ) : (
                    <button
                      onClick={() => openWithdraw(p)}
                      className="text-apex-muted hover:text-apex-yellow transition-colors"
                      title="Nie startuje"
                    >
                      <Ban size={14} />
                    </button>
                  )}
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

      <Dialog open={!!withdrawTarget} onOpenChange={o => { if (!o) setWithdrawTarget(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Nie startuje</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <p className="text-sm">
              <strong className="text-apex-text-bright">#{withdrawTarget?.bibNumber} {withdrawTarget?.firstName} {withdrawTarget?.lastName}</strong>
              {withdrawTarget?.categoryId && catMap[withdrawTarget.categoryId] ? ` (${catMap[withdrawTarget.categoryId]})` : ''} nie wystartuje.
            </p>
            {withdraw.error ? (
              <p className="text-sm text-apex-red mt-2">{withdraw.error.message}</p>
            ) : (
              <p className="text-sm text-apex-muted mt-2">Po starcie biegu dostanie status DNS, a odczyty chipa będą ignorowane.</p>
            )}
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => setWithdrawTarget(null)}>{withdraw.error ? 'Zamknij' : 'Anuluj'}</Button>
            {!withdraw.error && (
              <Button onClick={() => withdraw.mutate(withdrawTarget.id)} disabled={withdraw.isPending}>Nie startuje</Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
              {[['firstName','Imię *'],['lastName','Nazwisko *'],['phone','Telefon'],['club','Klub'],['tshirtSize','Koszulka']].map(([k, l]) => (
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
                onClick={() => addPart.mutate({ ...addForm, birthDate: addForm.birthDate || null, categoryId: addForm.categoryId || null, phone: addForm.phone || null, tshirtSize: addForm.tshirtSize || null })}
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

      {/* Check-in confirmation dialog — minor docs and/or t-shirt */}
      <Dialog open={!!minorCheckinTarget} onOpenChange={o => { if (!o) { setMinorCheckinTarget(null); setMinorDocChecks({}); setTshirtConfirmed(false) } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{isMinor(minorCheckinTarget) && minorProvideDocs.length > 0 ? 'Zamelduj nieletniego' : 'Zamelduj uczestnika'}</DialogTitle>
          </DialogHeader>
          <DialogBody className="space-y-3">
            <p className="text-sm text-apex-muted">
              <strong>{minorCheckinTarget?.firstName} {minorCheckinTarget?.lastName}</strong>{isMinor(minorCheckinTarget) && minorProvideDocs.length > 0 ? ' — potwierdź odbiór dokumentów:' : ''}
            </p>
            {minorCheckinTarget?.tshirtSize && (
              <label className="flex items-center gap-2 border border-apex-yellow/40 bg-apex-yellow/10 p-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={tshirtConfirmed}
                  onChange={e => setTshirtConfirmed(e.target.checked)}
                  className="accent-apex-yellow w-4 h-4"
                />
                <span className="text-sm text-apex-yellow font-bold">Potwierdzam wydanie koszulki: rozmiar {minorCheckinTarget.tshirtSize}</span>
              </label>
            )}
            {isMinor(minorCheckinTarget) && minorProvideDocs.length > 0 && (
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
            )}
          </DialogBody>
          {checkinError && (
            <p className="text-sm text-apex-red px-6 pb-2">Błąd: {checkinError}</p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => { setMinorCheckinTarget(null); setMinorDocChecks({}); setTshirtConfirmed(false); setCheckinError(null) }}>Anuluj</Button>
            <Button
              onClick={() => {
                setCheckinError(null)
                const docs = minorProvideDocs.map(d => ({ documentId: d.id, completed: !!minorDocChecks[d.id] }))
                checkinMutation.mutate({ participantId: minorCheckinTarget.id, documents: docs })
              }}
              disabled={checkinMutation.isPending || (isMinor(minorCheckinTarget) && minorProvideDocs.length > 0 && minorProvideDocs.some(d => !minorDocChecks[d.id])) || (minorCheckinTarget?.tshirtSize && !tshirtConfirmed)}
            >
              {checkinMutation.isPending ? 'Zameldowywanie...' : 'Zamelduj'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// The runner's team: a pick of the teams in the same category, a new team, or none; and the
// leg in a fixed-order relay. Saved on the host only (backend lib/teamEdit.js), before the gun.
// Module level, not inside ParticipantsTable: a component defined in a render is a new type on
// every render, so a background refetch remounted the cell and lost a name or leg being typed.
function TeamCell({ participant: p, participants, labels, fixedLeg, editingCell, setEditingCell, onUpdate, onRename }) {
  const team = labels.get(p.teamId)
  const label = teamLabelText(team)
  const isEditing = editingCell?.rowId === p.id && editingCell?.columnId === 'teamId'
  const isEditingLeg = editingCell?.rowId === p.id && editingCell?.columnId === 'teamLeg'
  const isEditingName = editingCell?.rowId === p.id && editingCell?.columnId === 'teamName'
  const save = (body) => { setEditingCell(null); onUpdate({ id: p.id, ...body }) }

  // A host team's name (host_teams): typed in place, saved on blur or Enter. A registration
  // team's name belongs to the registration and stays read-only here.
  const teamPart = isEditingName ? (
    <Input
      className="h-7 text-xs w-full min-w-0 border-apex-yellow"
      defaultValue={team?.name ?? ''}
      placeholder={team?.fallback}
      maxLength={HOST_TEAM_NAME_MAX}
      autoFocus
      aria-label="Nazwa drużyny"
      onBlur={e => {
        const name = hostTeamNameToSave(e.target.value, team?.name)
        setEditingCell(null)
        if (name) onRename({ teamId: p.teamId, name })
      }}
      onKeyDown={e => { if (e.key === 'Enter') e.target.blur(); if (e.key === 'Escape') setEditingCell(null) }}
    />
  ) : isEditing ? (
    <select
      className="h-7 text-xs border border-apex-yellow bg-apex-surface px-1 focus:outline-none w-full min-w-0"
      defaultValue={p.teamId ?? ''}
      autoFocus
      onChange={e => {
        const v = e.target.value
        if (v === (p.teamId ?? '')) return setEditingCell(null)
        const teamId = v === '__new' ? newTeamId() : (v || null)
        save({ teamId, teamLeg: legAfterMove(participants, teamId, p.id, fixedLeg) })
      }}
      onBlur={() => setEditingCell(null)}
      onKeyDown={e => { if (e.key === 'Escape') setEditingCell(null) }}
    >
      <option value="">— bez drużyny —</option>
      {teamOptions(participants, labels, p.categoryId).map(o => (
        <option key={o.teamId} value={o.teamId}>{o.label} ({o.size})</option>
      ))}
      <option value="__new">+ nowa drużyna</option>
    </select>
  ) : (
    <div
      className="cursor-text hover:bg-terrain-sand px-1 min-w-0 truncate rounded-sm"
      title={label || 'Przypisz do drużyny'}
      onClick={() => setEditingCell({ rowId: p.id, columnId: 'teamId' })}
    >
      <span className={cn(team?.name ? 'text-apex-text-bright' : 'text-apex-muted')}>{label || '— bez drużyny'}</span>
    </div>
  )

  const namePart = !p.teamId || !team?.host || isEditing || isEditingName ? null : (
    <button type="button" className="shrink-0 text-apex-muted hover:text-apex-yellow"
      title="Nazwa drużyny" aria-label="Nazwa drużyny"
      onClick={() => setEditingCell({ rowId: p.id, columnId: 'teamName' })}>
      <Pencil size={11} />
    </button>
  )

  const legPart = !fixedLeg || !p.teamId ? null : isEditingLeg ? (
    <Input
      className="h-6 w-12 text-xs border-apex-yellow"
      type="number" min={1}
      defaultValue={p.teamLeg ?? ''}
      autoFocus
      onBlur={e => {
        const n = e.target.value === '' ? null : Number(e.target.value)
        if (n === (p.teamLeg ?? null) || (n !== null && !(Number.isInteger(n) && n >= 1))) return setEditingCell(null)
        save({ teamLeg: n })
      }}
      onKeyDown={e => { if (e.key === 'Enter') e.target.blur(); if (e.key === 'Escape') setEditingCell(null) }}
    />
  ) : (
    <button type="button" className="shrink-0 font-mono text-[10px] text-apex-muted hover:text-apex-yellow"
      title="Zmiana w sztafecie" onClick={() => setEditingCell({ rowId: p.id, columnId: 'teamLeg' })}>
      zm. {p.teamLeg ?? '?'}
    </button>
  )

  return <div className="flex items-center gap-1.5 min-w-0 text-xs">{teamPart}{namePart}{legPart}</div>
}
