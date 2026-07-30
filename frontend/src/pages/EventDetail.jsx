import { useParams, Link, useSearchParams } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState, useEffect, useRef } from 'react'
import { api } from '../lib/api.js'
import { useWsEvent } from '../lib/ws.js'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../components/ui/tabs.jsx'
import { Button } from '../components/ui/button.jsx'
import { Badge } from '../components/ui/badge.jsx'
import { Input } from '../components/ui/input.jsx'
import { Card, CardHeader, CardTitle, CardContent } from '../components/ui/card.jsx'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogBody, DialogFooter } from '../components/ui/dialog.jsx'
import { AlertDialog, AlertDialogTrigger, AlertDialogContent, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogAction, AlertDialogCancel } from '../components/ui/alert-dialog.jsx'
import ParticipantsTable from '../components/ParticipantsTable/ParticipantsTable.jsx'
import ImportSection from '../components/ImportWizard/ImportSection.jsx'
import { Flag, Users, Tag, Settings, Plus, Trash2, Pencil, ExternalLink, Copy, FileText, RefreshCw, ClipboardCopy, Eye, EyeOff, Handshake, Upload, X } from 'lucide-react'

const VALID_TABS = ['categories', 'participants', 'rfid', 'checkpoints', 'settings', 'documents', 'partners']

export default function EventDetail() {
  const { id } = useParams()
  const [searchParams, setSearchParams] = useSearchParams()
  const qc = useQueryClient()

  const activeTab = VALID_TABS.includes(searchParams.get('tab')) ? searchParams.get('tab') : 'categories'
  const setTab = (tab) => setSearchParams({ tab }, { replace: true })

  const { data: event } = useQuery({ queryKey: ['events', id], queryFn: () => api.events.get(id) })
  const { data: categories = [] } = useQuery({
    queryKey: ['categories', id],
    queryFn: () => api.categories.list(id).then(rows => rows.map(r => r.category || r)),
  })

  const { data: checkpoints = [] } = useQuery({
    queryKey: ['checkpoints', id],
    queryFn: () => api.checkpoints.list(id),
  })

  const createCheckpoint = useMutation({
    mutationFn: (body) => api.checkpoints.create(id, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['checkpoints', id] }),
  })

  const updateCheckpoint = useMutation({
    mutationFn: ({ id: cpId, ...body }) => api.checkpoints.update(cpId, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['checkpoints', id] }),
  })

  const deleteCheckpoint = useMutation({
    mutationFn: api.checkpoints.delete,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['checkpoints', id] }),
  })

  const [cpDialog, setCpDialog] = useState(false)
  const [cpForm, setCpForm] = useState({ name: '', kmMarker: '', categoryIds: [], private: false })
  const [editingCp, setEditingCp] = useState(null)

  const [catDialog, setCatDialog] = useState(false)
  const [catForm, setCatForm] = useState({ name: '', slug: '', untimed: false })
  const [slugManuallyEdited, setSlugManuallyEdited] = useState(false)
  const [editingCat, setEditingCat] = useState(null)
  const [slugError, setSlugError] = useState('')

  const toSlug = (str) => str
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // strip diacritics (ą→a, ę→e, etc.)
    .replace(/ł/g, 'l')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

  const isSlugTaken = (slug, excludeId = null) =>
    categories.some(c => c.slug === slug && c.id !== excludeId)

  const toUniqueSlug = (str, excludeId = null) => {
    const base = toSlug(str)
    if (!isSlugTaken(base, excludeId)) return base
    let n = 2
    while (isSlugTaken(`${base}-${n}`, excludeId)) n++
    return `${base}-${n}`
  }
  const [rfidOpen, setRfidOpen] = useState(false)
  const [rfidForm, setRfidForm] = useState({})

  const closeCatDialog = () => {
    setCatDialog(false)
    setCatForm({ name: '', slug: '', untimed: false })
    setSlugManuallyEdited(false)
    setEditingCat(null)
    setSlugError('')
  }

  const createCat = useMutation({
    mutationFn: (body) => api.categories.create(id, body),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['categories', id] }); closeCatDialog() },
    onError: (err) => { if (err.message?.includes('unique') || err.message?.includes('duplicate')) setSlugError('Kategoria z tym ID już istnieje') },
  })

  const updateCat = useMutation({
    mutationFn: ({ id: catId, ...body }) => api.categories.update(catId, body),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['categories', id] }); closeCatDialog() },
    onError: (err) => { if (err.message?.includes('unique') || err.message?.includes('duplicate')) setSlugError('Kategoria z tym ID już istnieje') },
  })

  const deleteCat = useMutation({
    mutationFn: api.categories.delete,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['categories', id] }),
  })

  const updateEvent = useMutation({
    mutationFn: (body) => api.events.update(id, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['events', id] }),
  })

  if (!event) return <div className="text-apex-muted text-sm py-8">Ładowanie...</div>

  return (
    <div>
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="font-display text-4xl uppercase tracking-widest text-apex-text-bright">{event.name}</h1>
          {event.location && <p className="text-apex-muted text-sm mt-1">{event.location} · {event.date}</p>}
        </div>
        <div className="flex gap-2">
          <Link to={`/events/${id}/race`}><Button variant="secondary"><Flag size={14} /> Sterowanie</Button></Link>
          <Link to={`/events/${id}/results`}><Button variant="outline"><ExternalLink size={14} /> Wyniki</Button></Link>
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="categories"><Tag size={13} className="mr-1.5" />Kategorie</TabsTrigger>
          <TabsTrigger value="participants"><Users size={13} className="mr-1.5" />Uczestnicy</TabsTrigger>
          <TabsTrigger value="checkpoints"><Flag size={13} className="mr-1.5" />Punkty kontrolne</TabsTrigger>
          <TabsTrigger value="rfid"><Settings size={13} className="mr-1.5" />Ustawienia RFID</TabsTrigger>
          <TabsTrigger value="documents"><FileText size={13} className="mr-1.5" />Dokumenty</TabsTrigger>
          <TabsTrigger value="partners"><Handshake size={13} className="mr-1.5" />Partnerzy</TabsTrigger>
          <TabsTrigger value="settings"><Settings size={13} className="mr-1.5" />Ustawienia</TabsTrigger>
        </TabsList>

        {/* Kategorie */}
        <TabsContent value="categories">
          <div className="flex justify-end mb-3">
            <Button size="sm" onClick={() => setCatDialog(true)}><Plus size={13} /> Dodaj kategorię</Button>
          </div>
          <div className="grid gap-2">
            {categories.map(cat => (
              <Card key={cat.id}>
                <CardContent className="flex items-center justify-between py-2.5">
                  <div>
                    <span className="font-semibold text-sm text-apex-text">{cat.name}</span>
                    <span className="ml-3 text-xs text-apex-muted font-mono">{cat.slug}</span>
                    {cat.untimed && (
                      <span className="ml-3 text-[10px] font-bold uppercase tracking-widest px-1.5 py-0.5 border border-apex-border text-apex-muted">bez pomiaru</span>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                  <Button variant="ghost" size="icon" className="text-apex-text hover:text-apex-text-bright" onClick={() => {
                    setEditingCat(cat)
                    setCatForm({ name: cat.name, slug: cat.slug, untimed: !!cat.untimed })
                    setSlugManuallyEdited(true)
                    setCatDialog(true)
                  }}>
                    <Pencil size={14} />
                  </Button>
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button variant="ghost" size="icon" className="text-apex-text hover:text-apex-red">
                        <Trash2 size={14} />
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogTitle>Usuń kategorię</AlertDialogTitle>
                      <AlertDialogDescription>
                        Usunąć <strong>{cat.name}</strong>? Wszyscy przypisani uczestnicy zostaną usunięci.
                      </AlertDialogDescription>
                      <AlertDialogFooter>
                        <AlertDialogCancel asChild><Button variant="outline">Anuluj</Button></AlertDialogCancel>
                        <AlertDialogAction asChild>
                          <Button variant="destructive" onClick={() => deleteCat.mutate(cat.id)}>Usuń</Button>
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                  </div>
                </CardContent>
              </Card>
            ))}
            {categories.length === 0 && (
              <div className="py-8 text-center text-apex-muted text-sm">Brak kategorii. Dodaj powyżej lub zaimportuj z CSV.</div>
            )}
          </div>
          <div className="mt-4">
            <ImportSection
              title="Importuj kategorie z CSV"
              description="CSV z kolumnami: id, name"
              example={"id,name\nbieg-5km,Bieg 5km\nnordic-walking,Nordic Walking"}
              onImport={(fd) => api.categories.importCsv(id, fd)}
              invalidateKey={['categories', id]}
            />
          </div>
        </TabsContent>

        {/* Uczestnicy */}
        <TabsContent value="participants">
          <ParticipantsTable eventId={id} categories={categories} />
          <div className="mt-4">
            <ImportSection
              title="Importuj uczestników z CSV"
              description="CSV z kolumnami: first_name, last_name, email, gender, birth_year, club, category_id"
              example={"first_name,last_name,email,gender,birth_year,club,category_id\nJan,Kowalski,jan@example.com,M,1990,KS Biega,bieg-5km"}
              onImport={(fd) => api.participants.importCsv(id, fd)}
              invalidateKey={['participants', id]}
            />
          </div>
        </TabsContent>

        {/* Ustawienia RFID */}
        <TabsContent value="rfid">
          <div className="max-w-lg space-y-4">
            <MqttStatus />
            <RfidSettings event={event} onSave={(vals) => updateEvent.mutate(vals)} saving={updateEvent.isPending} />
          </div>
        </TabsContent>
        {/* Punkty kontrolne */}
        <TabsContent value="checkpoints">
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="font-display text-2xl uppercase tracking-wider text-apex-text-bright">
                Punkty kontrolne
              </h2>
              <div className="flex items-center gap-2">
                {checkpoints.length > 0 && (
                  <Button size="sm" variant="outline" onClick={() => {
                    const text = checkpoints.map(cp =>
                      `${cp.name}${cp.kmMarker ? ` (km ${cp.kmMarker})` : ''}: https://leszy.run/events/${event?.slug || ''}/volunteer?checkpoint=${cp.id}`
                    ).join('\n')
                    navigator.clipboard.writeText(text)
                  }}>
                    <Copy size={14} /> Kopiuj wszystkie linki
                  </Button>
                )}
                <Button size="sm" onClick={() => { setEditingCp(null); setCpForm({ name: '', kmMarker: '', categoryIds: [], private: false, isNearFinish: false }); setCpDialog(true) }}>
                  <Plus size={14} /> Dodaj punkt
                </Button>
              </div>
            </div>

            {checkpoints.length === 0 && (
              <p className="text-sm text-apex-muted py-4">Brak punktów kontrolnych. Dodaj punkt, aby wolontariusze mogli rejestrować przejścia.</p>
            )}

            <div className="space-y-2">
              {checkpoints.map(cp => {
                const volunteerUrl = `https://leszy.run/events/${event?.slug || ''}/volunteer?checkpoint=${cp.id}`
                return (
                  <div key={cp.id} className="border border-apex-border bg-apex-surface px-4 py-3 flex items-center justify-between gap-4">
                    <div>
                      <div className="font-semibold text-apex-text-bright">
                        {cp.name}
                        {cp.private && <span className="ml-2 text-xs font-bold px-1.5 py-0.5 bg-apex-surface-2 text-apex-muted border border-apex-border">PRYWATNY</span>}
                        {cp.isNearFinish && <span className="ml-2 text-xs font-bold px-1.5 py-0.5 bg-apex-yellow/10 text-apex-yellow border border-apex-yellow/30">BLISKO METY</span>}
                      </div>
                      <div className="text-xs text-apex-muted mt-0.5">
                        {cp.kmMarker ? `Km ${cp.kmMarker} · ` : ''}
                        {cp.categoryIds?.length
                          ? `Kategorie: ${cp.categoryIds.map(cid => categories.find(c => c.id === cid)?.name || cid).join(', ')}`
                          : 'Wszystkie kategorie'
                        }
                      </div>
                      <div className="text-xs text-apex-cyan font-mono mt-1 break-all">{volunteerUrl}</div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <a href={volunteerUrl} target="_blank" rel="noopener noreferrer">
                        <Button size="sm" variant="outline" title="Otwórz">
                          <ExternalLink size={12} />
                        </Button>
                      </a>
                      <Button size="sm" variant="outline" onClick={() => navigator.clipboard.writeText(volunteerUrl)} title="Kopiuj link">
                        <Copy size={12} />
                      </Button>
                      <Button size="sm" variant="outline" title="Edytuj" onClick={() => {
                        setEditingCp(cp)
                        setCpForm({ name: cp.name, kmMarker: cp.kmMarker ?? '', categoryIds: cp.categoryIds || [], private: cp.private ?? false, isNearFinish: cp.isNearFinish ?? false })
                        setCpDialog(true)
                      }}>
                        <Pencil size={12} />
                      </Button>
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button size="sm" variant="destructive"><Trash2 size={12} /></Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogTitle>Usuń punkt?</AlertDialogTitle>
                          <AlertDialogDescription>Usunięcie punktu usunie też wszystkie zarejestrowane przejścia wolontariuszy.</AlertDialogDescription>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Anuluj</AlertDialogCancel>
                            <AlertDialogAction onClick={() => deleteCheckpoint.mutate(cp.id)}>Usuń</AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>

          {/* Add/Edit checkpoint dialog */}
          <Dialog open={cpDialog} onOpenChange={setCpDialog}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{editingCp ? 'Edytuj punkt' : 'Nowy punkt kontrolny'}</DialogTitle>
              </DialogHeader>
              <DialogBody className="space-y-3">
                <label className="block">
                  <span className="text-xs font-bold uppercase tracking-widest text-apex-muted mb-1 block">Nazwa *</span>
                  <Input value={cpForm.name} onChange={e => setCpForm(f => ({ ...f, name: e.target.value }))} placeholder="np. Km 5 – Górka" />
                </label>
                <label className="block">
                  <span className="text-xs font-bold uppercase tracking-widest text-apex-muted mb-1 block">Km marker</span>
                  <Input type="number" step="0.1" value={cpForm.kmMarker} onChange={e => setCpForm(f => ({ ...f, kmMarker: e.target.value }))} placeholder="1.5" />
                </label>
                <div>
                  <span className="text-xs font-bold uppercase tracking-widest text-apex-muted mb-2 block">Kategorie (puste = wszystkie)</span>
                  <div className="space-y-1">
                    {categories.map(cat => (
                      <label key={cat.id} className="flex items-center gap-2 text-sm cursor-pointer">
                        <input
                          type="checkbox"
                          checked={cpForm.categoryIds.includes(cat.id)}
                          onChange={e => setCpForm(f => ({
                            ...f,
                            categoryIds: e.target.checked
                              ? [...f.categoryIds, cat.id]
                              : f.categoryIds.filter(x => x !== cat.id),
                          }))}
                        />
                        {cat.name}
                      </label>
                    ))}
                  </div>
                </div>
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={cpForm.private}
                    onChange={e => setCpForm(f => ({ ...f, private: e.target.checked }))}
                  />
                  <span>Prywatny <span className="text-apex-muted text-xs">(widoczny tylko w panelu admina)</span></span>
                </label>
                {(() => {
                  const otherNearFinish = checkpoints.find(cp => cp.isNearFinish && (!editingCp || cp.id !== editingCp.id))
                  return (
                    <>
                      <label className={`flex items-center gap-2 text-sm ${otherNearFinish ? 'opacity-50' : 'cursor-pointer'}`}>
                        <input
                          type="checkbox"
                          checked={cpForm.isNearFinish}
                          disabled={!!otherNearFinish}
                          onChange={e => setCpForm(f => ({ ...f, isNearFinish: e.target.checked }))}
                        />
                        <span>
                          Blisko mety <span className="text-apex-muted text-xs">(wyświetla zakładkę 'Blisko Mety' na stronie publicznej)</span>
                        </span>
                      </label>
                      {otherNearFinish && (
                        <p className="text-xs text-apex-muted ml-6">Punkt "{otherNearFinish.name}" jest już oznaczony jako blisko mety</p>
                      )}
                    </>
                  )
                })()}
              </DialogBody>
              <DialogFooter>
                <Button variant="outline" onClick={() => setCpDialog(false)}>Anuluj</Button>
                <Button
                  disabled={!cpForm.name}
                  onClick={() => {
                    const body = {
                      name: cpForm.name,
                      kmMarker: cpForm.kmMarker ? parseFloat(cpForm.kmMarker) : null,
                      categoryIds: cpForm.categoryIds,
                      private: cpForm.private,
                      isNearFinish: cpForm.isNearFinish,
                    }
                    if (editingCp) {
                      updateCheckpoint.mutate({ id: editingCp.id, ...body }, { onSuccess: () => setCpDialog(false) })
                    } else {
                      createCheckpoint.mutate(body, { onSuccess: () => setCpDialog(false) })
                    }
                  }}
                >
                  {editingCp ? 'Zapisz' : 'Utwórz'}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </TabsContent>
        {/* Dokumenty */}
        <TabsContent value="documents">
          <DocumentsManager eventId={id} />
        </TabsContent>
        {/* Partnerzy */}
        <TabsContent value="partners">
          <PartnersManager eventId={id} />
        </TabsContent>
        {/* Ustawienia */}
        <TabsContent value="settings">
          <EventSettings eventId={id} event={event} updateEvent={updateEvent} />
        </TabsContent>
      </Tabs>

      {/* Dialog dodawania/edycji kategorii */}
      <Dialog open={catDialog} onOpenChange={o => { if (!o) closeCatDialog(); else setCatDialog(true) }}>
        <DialogContent>
          <DialogHeader><DialogTitle>{editingCat ? 'Edytuj kategorię' : 'Dodaj kategorię'}</DialogTitle></DialogHeader>
          <DialogBody className="space-y-3">
            <label className="block">
              <span className="text-xs font-bold uppercase tracking-widest text-apex-muted mb-1 block">Nazwa *</span>
              <Input
                value={catForm.name}
                onChange={e => {
                  const name = e.target.value
                  setCatForm(f => {
                    const newSlug = (slugManuallyEdited || editingCat) ? f.slug : toUniqueSlug(name, editingCat?.id)
                    if (!slugManuallyEdited && !editingCat) setSlugError('')
                    return { ...f, name, slug: newSlug }
                  })
                }}
                placeholder="Bieg 5km"
              />
            </label>
            <label className="block">
              <span className="text-xs font-bold uppercase tracking-widest text-apex-muted mb-1 block">ID (slug) *</span>
              <Input
                value={catForm.slug}
                onChange={e => {
                  const slug = e.target.value
                  setSlugManuallyEdited(true)
                  setCatForm(f => ({ ...f, slug }))
                  setSlugError(isSlugTaken(slug, editingCat?.id) ? 'Kategoria z tym ID już istnieje' : '')
                }}
                placeholder="bieg-5km"
                className={slugError ? 'border-apex-red focus-visible:ring-apex-red' : ''}
              />
              {slugError
                ? <p className="text-xs text-apex-red mt-1">{slugError}</p>
                : <p className="text-xs text-apex-muted mt-1">Używane w imporcie CSV. Małe litery, bez spacji.</p>
              }
            </label>
            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={!!catForm.untimed}
                onChange={e => setCatForm(f => ({ ...f, untimed: e.target.checked }))}
                className="mt-0.5"
              />
              <span>
                <span className="text-xs font-bold uppercase tracking-widest text-apex-muted block">Bez pomiaru czasu</span>
                <span className="text-xs text-apex-muted">Kategoria nie będzie pokazywana w publicznych wynikach (np. bieg dzieci).</span>
              </span>
            </label>
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCatDialog(false)}>Anuluj</Button>
            <Button
              disabled={!catForm.name || !catForm.slug || !!slugError || createCat.isPending || updateCat.isPending}
              onClick={() => {
                const body = { ...catForm }
                if (editingCat) {
                  updateCat.mutate({ id: editingCat.id, ...body })
                } else {
                  createCat.mutate(body)
                }
              }}
            >
              {editingCat ? 'Zapisz' : 'Dodaj kategorię'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function ReaderStatusRow({ role, label }) {
  const { data, error } = useQuery({
    queryKey: ['reader-status', role],
    queryFn: () => api.reader.status(role),
    refetchInterval: 10000,
    retry: false,
  })
  if (error?.message?.includes('not configured')) return null

  const reachable = !error && !!data
  const mqttConn = data?.mqttBrokerConnectionStatus
  const scanning = data?.status === 'running' || data?.status === 'starting'

  return (
    <div className="flex items-start gap-3">
      <span className={`w-2 h-2 rounded-full shrink-0 mt-1 ${
        error ? 'bg-apex-red' : !data ? 'bg-stone-300' : 'bg-apex-yellow'
      }`} />
      <div>
        <span className="text-apex-muted">{label}: </span>
        {!data && !error && <span className="text-apex-muted">Sprawdzanie...</span>}
        {error && <span className="text-apex-red font-medium">Niedostępny</span>}
        {reachable && (
          <span className={mqttConn === 'connected' ? 'text-apex-yellow font-medium' : 'text-amber-600 font-medium'}>
            {mqttConn === 'connected' ? 'MQTT połączony' : mqttConn ? `MQTT: ${mqttConn}` : 'MQTT: brak danych'}
          </span>
        )}
        {reachable && scanning && <span className="ml-2 text-xs text-apex-yellow">· skanowanie aktywne</span>}
      </div>
    </div>
  )
}

function MqttStatus() {
  const [connected, setConnected] = useState(null)
  const { data: statusData } = useQuery({ queryKey: ['rfid-status'], queryFn: () => api.rfid.status() })
  const { data: readerConfig } = useQuery({ queryKey: ['reader-config'], queryFn: () => api.reader.getConfig() })
  useEffect(() => { if (statusData != null) setConnected(statusData.connected) }, [statusData])
  useWsEvent('rfid:status', (payload) => setConnected(payload.connected))

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>Infrastruktura RFID</CardTitle>
          <Link to="/reader" className="text-xs font-bold uppercase tracking-widest text-apex-muted hover:text-apex-muted border border-apex-border hover:border-apex-border-bright px-2 py-1 transition-colors">
            Diagnostyka →
          </Link>
        </div>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <div className="flex items-center gap-3">
          <span className={`w-2 h-2 rounded-full shrink-0 ${connected === null ? 'bg-stone-300' : connected ? 'bg-apex-yellow' : 'bg-apex-red'}`} />
          <span className="text-apex-muted">
            {connected === null ? 'Sprawdzanie...' : connected ? 'Broker Mosquitto połączony' : 'Brak połączenia z brokerem'}
          </span>
        </div>
        {connected === false && (
          <p className="text-xs text-apex-red border-t border-stone-100 pt-2">
            Sprawdź czy Mosquitto jest uruchomiony:{' '}
            <code className="font-mono">/opt/homebrew/sbin/mosquitto -c mosquitto/config/mosquitto.conf</code>
          </p>
        )}
        {readerConfig?.mainIp && (
          <div className="border-t border-stone-100 pt-2 space-y-1.5">
            <ReaderStatusRow role="main" label="Czytnik główny" />
            {readerConfig.finishIp && <ReaderStatusRow role="finish" label="Czytnik mety" />}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function DocumentsManager({ eventId }) {
  const qc = useQueryClient()
  const [addOpen, setAddOpen] = useState(false)
  const [form, setForm] = useState({ name: '', type: 'acknowledge', url: '', requiredFor: 'all', sortOrder: 0 })
  const [editingId, setEditingId] = useState(null)

  const { data: documents = [] } = useQuery({
    queryKey: ['documents', eventId],
    queryFn: () => api.documents.list(eventId),
  })

  const createDoc = useMutation({
    mutationFn: (body) => api.documents.create(eventId, body),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['documents', eventId] }); closeDialog() },
  })

  const updateDoc = useMutation({
    mutationFn: ({ id, ...body }) => api.documents.update(id, body),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['documents', eventId] }); closeDialog() },
  })

  const deleteDoc = useMutation({
    mutationFn: api.documents.delete,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['documents', eventId] }),
  })

  const closeDialog = () => {
    setAddOpen(false)
    setEditingId(null)
    setForm({ name: '', type: 'acknowledge', url: '', requiredFor: 'all', sortOrder: 0 })
  }

  const openEdit = (doc) => {
    setEditingId(doc.id)
    setForm({ name: doc.name, type: doc.type, url: doc.url || '', requiredFor: doc.requiredFor || 'all', sortOrder: doc.sortOrder ?? 0 })
    setAddOpen(true)
  }

  const handleSubmit = () => {
    const body = { ...form, sortOrder: parseInt(form.sortOrder) || 0, url: form.url || null }
    if (editingId) {
      updateDoc.mutate({ id: editingId, ...body })
    } else {
      createDoc.mutate(body)
    }
  }

  const TYPE_LABELS = { acknowledge: 'Do akceptacji', provide: 'Do dostarczenia', info: 'Info (link)' }
  const FOR_LABELS = { all: 'Wszyscy', minors: 'Niepełnoletni' }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="font-display text-2xl uppercase tracking-wider text-apex-text-bright">Dokumenty</h2>
        <Button size="sm" onClick={() => { setEditingId(null); setForm({ name: '', type: 'acknowledge', url: '', requiredFor: 'all', sortOrder: 0 }); setAddOpen(true) }}>
          <Plus size={13} /> Dodaj dokument
        </Button>
      </div>

      {documents.length === 0 && (
        <p className="text-sm text-apex-muted py-4">Brak dokumentów. Dodaj dokumenty wymagane od uczestników.</p>
      )}

      <div className="border border-apex-border bg-apex-surface overflow-x-auto">
        {documents.length > 0 && (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-apex-border bg-apex-surface-2">
                {['Nazwa', 'Typ', 'URL', 'Wymagany dla', 'Kolejność', ''].map(h => (
                  <th key={h} className="text-left px-3 py-2 text-xs font-bold uppercase tracking-wider text-apex-muted whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-apex-border">
              {documents.map(doc => (
                <tr key={doc.id} className="hover:bg-apex-surface-2 group">
                  <td className="px-3 py-2 text-apex-text-bright">{doc.name}</td>
                  <td className="px-3 py-2">
                    <Badge variant="outline" className="text-xs">{TYPE_LABELS[doc.type] || doc.type}</Badge>
                  </td>
                  <td className="px-3 py-2 max-w-48 truncate">
                    {doc.url ? (
                      <a href={doc.url} target="_blank" rel="noopener noreferrer" className="text-apex-cyan hover:underline text-xs font-mono">{doc.url}</a>
                    ) : (
                      <span className="text-apex-muted">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs">{FOR_LABELS[doc.requiredFor] || doc.requiredFor}</td>
                  <td className="px-3 py-2 text-xs font-mono">{doc.sortOrder}</td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-1">
                      <Button variant="ghost" size="icon" className="text-apex-text hover:text-apex-text-bright" onClick={() => openEdit(doc)}>
                        <Pencil size={13} />
                      </Button>
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button variant="ghost" size="icon" className="text-apex-text hover:text-apex-red">
                            <Trash2 size={13} />
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogTitle>Usuń dokument</AlertDialogTitle>
                          <AlertDialogDescription>Usunąć <strong>{doc.name}</strong>?</AlertDialogDescription>
                          <AlertDialogFooter>
                            <AlertDialogCancel asChild><Button variant="outline">Anuluj</Button></AlertDialogCancel>
                            <AlertDialogAction asChild>
                              <Button variant="destructive" onClick={() => deleteDoc.mutate(doc.id)}>Usuń</Button>
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Add/Edit dialog */}
      <Dialog open={addOpen} onOpenChange={o => { if (!o) closeDialog(); else setAddOpen(true) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingId ? 'Edytuj dokument' : 'Dodaj dokument'}</DialogTitle>
          </DialogHeader>
          <DialogBody className="space-y-3">
            <label className="block">
              <span className="text-xs font-bold uppercase tracking-widest text-apex-muted mb-1 block">Nazwa *</span>
              <Input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Regulamin zawodów" />
            </label>
            <label className="block">
              <span className="text-xs font-bold uppercase tracking-widest text-apex-muted mb-1 block">Typ *</span>
              <select
                className="h-9 w-full border border-apex-border-mid bg-apex-surface px-3 text-sm text-apex-text rounded-none"
                value={form.type}
                onChange={e => setForm(f => ({ ...f, type: e.target.value }))}
              >
                <option value="acknowledge">Do akceptacji</option>
                <option value="provide">Do dostarczenia</option>
                <option value="info">Info (link)</option>
              </select>
            </label>
            <label className="block">
              <span className="text-xs font-bold uppercase tracking-widest text-apex-muted mb-1 block">URL</span>
              <Input value={form.url} onChange={e => setForm(f => ({ ...f, url: e.target.value }))} placeholder="https://..." />
            </label>
            <label className="block">
              <span className="text-xs font-bold uppercase tracking-widest text-apex-muted mb-1 block">Wymagany dla</span>
              <select
                className="h-9 w-full border border-apex-border-mid bg-apex-surface px-3 text-sm text-apex-text rounded-none"
                value={form.requiredFor}
                onChange={e => setForm(f => ({ ...f, requiredFor: e.target.value }))}
              >
                <option value="all">Wszyscy</option>
                <option value="minors">Niepełnoletni</option>
              </select>
            </label>
            <label className="block">
              <span className="text-xs font-bold uppercase tracking-widest text-apex-muted mb-1 block">Kolejność</span>
              <Input type="number" value={form.sortOrder} onChange={e => setForm(f => ({ ...f, sortOrder: e.target.value }))} />
            </label>
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={closeDialog}>Anuluj</Button>
            <Button
              disabled={!form.name || createDoc.isPending || updateDoc.isPending}
              onClick={handleSubmit}
            >
              {editingId ? 'Zapisz' : 'Dodaj'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function PartnersManager({ eventId }) {
  const qc = useQueryClient()
  const [addOpen, setAddOpen] = useState(false)
  const [form, setForm] = useState({ name: '', website_url: '', sort_order: 0 })
  const [editingId, setEditingId] = useState(null)
  const fileRef = useRef()

  const { data: partners = [] } = useQuery({
    queryKey: ['partners', eventId],
    queryFn: () => api.partners.list(eventId),
  })

  const createPartner = useMutation({
    mutationFn: (body) => api.partners.create(eventId, body),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['partners', eventId] }); closeDialog() },
  })

  const updatePartner = useMutation({
    mutationFn: ({ id, ...body }) => api.partners.update(id, body),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['partners', eventId] }); closeDialog() },
  })

  const deletePartner = useMutation({
    mutationFn: api.partners.delete,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['partners', eventId] }),
  })

  const uploadLogo = useMutation({
    mutationFn: ({ id, file }) => {
      const fd = new FormData()
      fd.append('file', file)
      return api.partners.uploadLogo(id, fd)
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['partners', eventId] }),
  })

  const deleteLogo = useMutation({
    mutationFn: api.partners.deleteLogo,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['partners', eventId] }),
  })

  const closeDialog = () => {
    setAddOpen(false)
    setEditingId(null)
    setForm({ name: '', website_url: '', sort_order: 0 })
  }

  const openEdit = (p) => {
    setEditingId(p.id)
    setForm({ name: p.name, website_url: p.website_url || '', sort_order: p.sort_order ?? 0 })
    setAddOpen(true)
  }

  const handleSubmit = () => {
    const body = { name: form.name, website_url: form.website_url || null, sort_order: parseInt(form.sort_order) || 0 }
    if (editingId) {
      updatePartner.mutate({ id: editingId, ...body })
    } else {
      createPartner.mutate(body)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="font-display text-2xl uppercase tracking-wider text-apex-text-bright">Partnerzy</h2>
        <Button size="sm" onClick={() => { setEditingId(null); setForm({ name: '', website_url: '', sort_order: 0 }); setAddOpen(true) }}>
          <Plus size={13} /> Dodaj partnera
        </Button>
      </div>

      {partners.length === 0 && (
        <p className="text-sm text-apex-muted py-4">Brak partnerów. Dodaj partnerów i ich logotypy — będą widoczne na wynikach na żywo.</p>
      )}

      <div className="grid gap-3">
        {partners.map(p => (
          <div key={p.id} className="border border-apex-border bg-apex-surface p-4 flex items-center gap-4 group hover:bg-apex-surface-2">
            {/* Logo */}
            <div
              className={`shrink-0 w-24 h-16 border bg-apex-bg flex items-center justify-center overflow-hidden relative transition-colors ${
                p._dragging ? 'border-apex-yellow border-dashed' : 'border-apex-border'
              }`}
              onDragOver={(e) => { e.preventDefault(); e.currentTarget.classList.add('border-apex-yellow', 'border-dashed'); e.currentTarget.classList.remove('border-apex-border') }}
              onDragLeave={(e) => { e.currentTarget.classList.remove('border-apex-yellow', 'border-dashed'); e.currentTarget.classList.add('border-apex-border') }}
              onDrop={(e) => {
                e.preventDefault()
                e.currentTarget.classList.remove('border-apex-yellow', 'border-dashed')
                e.currentTarget.classList.add('border-apex-border')
                const file = e.dataTransfer.files[0]
                if (file && file.type.startsWith('image/')) uploadLogo.mutate({ id: p.id, file })
              }}
            >
              {p.logo_url ? (
                <>
                  <img src={p.logo_url} alt={p.name} className="max-w-full max-h-full object-contain" />
                  <button
                    onClick={() => deleteLogo.mutate(p.id)}
                    className="absolute top-0.5 right-0.5 bg-apex-bg/80 text-apex-muted hover:text-apex-red p-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
                    title="Usuń logo"
                  >
                    <X size={12} />
                  </button>
                </>
              ) : (
                <label className="cursor-pointer text-center w-full h-full flex flex-col items-center justify-center hover:text-apex-yellow transition-colors text-apex-muted">
                  <Upload size={16} />
                  <span className="text-[9px] mt-0.5 uppercase tracking-wide">Logo</span>
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/svg+xml,image/webp"
                    className="hidden"
                    onChange={(e) => {
                      if (e.target.files[0]) uploadLogo.mutate({ id: p.id, file: e.target.files[0] })
                    }}
                  />
                </label>
              )}
            </div>

            {/* Info */}
            <div className="flex-1 min-w-0">
              <div className="font-semibold text-sm text-apex-text-bright">{p.name}</div>
              {p.website_url && (
                <a href={p.website_url} target="_blank" rel="noopener" className="text-xs text-apex-cyan hover:underline font-mono truncate block">{p.website_url}</a>
              )}
              <div className="text-[10px] text-apex-muted font-mono mt-0.5">kolejność: {p.sort_order}</div>
            </div>

            {/* Replace logo when one exists */}
            {p.logo_url && (
              <label className="shrink-0 cursor-pointer">
                <Button variant="ghost" size="sm" className="text-apex-muted hover:text-apex-text-bright pointer-events-none">
                  <Upload size={13} />
                </Button>
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/svg+xml,image/webp"
                  className="hidden"
                  onChange={(e) => {
                    if (e.target.files[0]) uploadLogo.mutate({ id: p.id, file: e.target.files[0] })
                  }}
                />
              </label>
            )}

            {/* Actions */}
            <div className="flex items-center gap-1 shrink-0">
              <Button variant="ghost" size="icon" className="text-apex-text hover:text-apex-text-bright" onClick={() => openEdit(p)}>
                <Pencil size={13} />
              </Button>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="ghost" size="icon" className="text-apex-text hover:text-apex-red">
                    <Trash2 size={13} />
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogTitle>Usuń partnera</AlertDialogTitle>
                  <AlertDialogDescription>Usunąć <strong>{p.name}</strong> i logo?</AlertDialogDescription>
                  <AlertDialogFooter>
                    <AlertDialogCancel asChild><Button variant="outline">Anuluj</Button></AlertDialogCancel>
                    <AlertDialogAction asChild>
                      <Button variant="destructive" onClick={() => deletePartner.mutate(p.id)}>Usuń</Button>
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </div>
        ))}
      </div>

      {/* Add/Edit dialog */}
      <Dialog open={addOpen} onOpenChange={o => { if (!o) closeDialog(); else setAddOpen(true) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingId ? 'Edytuj partnera' : 'Dodaj partnera'}</DialogTitle>
          </DialogHeader>
          <DialogBody className="space-y-3">
            <label className="block">
              <span className="text-xs font-bold uppercase tracking-widest text-apex-muted mb-1 block">Nazwa *</span>
              <Input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Nazwa partnera" />
            </label>
            <label className="block">
              <span className="text-xs font-bold uppercase tracking-widest text-apex-muted mb-1 block">Strona www</span>
              <Input value={form.website_url} onChange={e => setForm(f => ({ ...f, website_url: e.target.value }))} placeholder="https://..." />
            </label>
            <label className="block">
              <span className="text-xs font-bold uppercase tracking-widest text-apex-muted mb-1 block">Kolejność</span>
              <Input type="number" value={form.sort_order} onChange={e => setForm(f => ({ ...f, sort_order: e.target.value }))} />
            </label>
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={closeDialog}>Anuluj</Button>
            <Button
              disabled={!form.name || createPartner.isPending || updatePartner.isPending}
              onClick={handleSubmit}
            >
              {editingId ? 'Zapisz' : 'Dodaj'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function EventSettings({ eventId, event, updateEvent }) {
  const qc = useQueryClient()
  const [slug, setSlug] = useState(event.slug || '')
  const [slugError, setSlugError] = useState('')
  const [syncing, setSyncing] = useState(false)

  const validateSlug = (val) => /^[a-z0-9-]*$/.test(val)

  const { data: pinData, isLoading: pinLoading } = useQuery({
    queryKey: ['checkin-pin', eventId],
    queryFn: () => api.secrets.getCheckinPin(eventId),
  })

  const regenPin = useMutation({
    mutationFn: () => api.secrets.generateCheckinPin(eventId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['checkin-pin', eventId] }),
  })

  const { data: checkpointPinData, isLoading: checkpointPinLoading } = useQuery({
    queryKey: ['checkpointPin', eventId],
    queryFn: () => api.secrets.getCheckpointPin(eventId),
  })

  const regenCheckpointPin = useMutation({
    mutationFn: () => api.secrets.generateCheckpointPin(eventId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['checkpointPin', eventId] }),
  })

  const handleSlugSave = () => {
    if (!validateSlug(slug)) {
      setSlugError('Tylko małe litery, cyfry i myślniki')
      return
    }
    setSlugError('')
    updateEvent.mutate({ slug })
  }

  const handlePullCheckins = async () => {
    setSyncing(true)
    try {
      await api.checkinSync.pullNow(eventId)
      qc.invalidateQueries({ queryKey: ['participants', eventId] })
    } finally {
      setSyncing(false)
    }
  }

  return (
    <div className="max-w-lg space-y-6">
      {/* Visibility */}
      <Card>
        <CardHeader><CardTitle>Widoczność na leszy.run</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-3">
            <Button
              variant={event.visibility === 'public' ? 'default' : 'outline'}
              size="sm"
              onClick={() => updateEvent.mutate({ visibility: event.visibility === 'public' ? 'private' : 'public' })}
              disabled={updateEvent.isPending}
            >
              {event.visibility === 'public' ? <Eye size={14} className="mr-1.5" /> : <EyeOff size={14} className="mr-1.5" />}
              {event.visibility === 'public' ? 'Publiczne' : 'Prywatne'}
            </Button>
            <span className="text-xs text-apex-muted">
              {event.visibility === 'public'
                ? 'Wydarzenie widoczne na stronie publicznej leszy.run'
                : 'Wydarzenie ukryte — widoczne tylko w panelu admina'}
            </span>
          </div>
        </CardContent>
      </Card>

      {/* Slug */}
      <Card>
        <CardHeader><CardTitle>Slug wydarzenia</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          <Input
            value={slug}
            onChange={e => {
              const val = e.target.value.toLowerCase()
              setSlug(val)
              if (!validateSlug(val)) setSlugError('Tylko małe litery, cyfry i myślniki')
              else setSlugError('')
            }}
            onBlur={handleSlugSave}
            onKeyDown={e => { if (e.key === 'Enter') handleSlugSave() }}
            placeholder="moj-wyscig-2026"
          />
          {slugError && <p className="text-xs text-apex-red">{slugError}</p>}
          <p className="text-xs text-apex-muted font-mono">leszy.run/events/{slug || '...'}</p>
        </CardContent>
      </Card>

      {/* Check-in PIN */}
      <Card>
        <CardHeader><CardTitle>PIN check-in</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {pinLoading ? (
            <p className="text-sm text-apex-muted">Ładowanie...</p>
          ) : (
            <div className="flex items-center gap-3">
              <span className="text-3xl font-mono font-bold text-apex-text-bright tracking-[0.3em]">
                {pinData?.checkinPin || '—'}
              </span>
              {pinData?.checkinPin && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => navigator.clipboard.writeText(pinData.checkinPin)}
                  title="Kopiuj PIN"
                >
                  <ClipboardCopy size={14} />
                </Button>
              )}
            </div>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => regenPin.mutate()}
            disabled={regenPin.isPending}
          >
            <RefreshCw size={13} className={regenPin.isPending ? 'animate-spin' : ''} />
            Regeneruj PIN
          </Button>
          {event?.slug && (
            <div className="pt-2 border-t border-apex-border">
              <p className="text-xs font-bold uppercase tracking-widest text-apex-muted mb-1">Link do skanowania QR</p>
              <div className="flex items-center gap-2">
                <span className="text-xs font-mono text-apex-cyan break-all">https://leszy.run/events/{event.slug}/admin/checkin</span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => navigator.clipboard.writeText(`https://leszy.run/events/${event.slug}/admin/checkin`)}
                  title="Kopiuj link"
                >
                  <Copy size={13} />
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Checkpoint PIN */}
      <Card>
        <CardHeader><CardTitle>PIN punktów kontrolnych</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {checkpointPinLoading ? (
            <p className="text-sm text-apex-muted">Ładowanie...</p>
          ) : (
            <div className="flex items-center gap-3">
              <span className="text-3xl font-mono font-bold text-apex-text-bright tracking-[0.3em]">
                {checkpointPinData?.checkpointPin || '—'}
              </span>
              {checkpointPinData?.checkpointPin && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => navigator.clipboard.writeText(checkpointPinData.checkpointPin)}
                  title="Kopiuj PIN"
                >
                  <ClipboardCopy size={14} />
                </Button>
              )}
            </div>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => regenCheckpointPin.mutate()}
            disabled={regenCheckpointPin.isPending}
          >
            <RefreshCw size={13} className={regenCheckpointPin.isPending ? 'animate-spin' : ''} />
            Regeneruj PIN
          </Button>
          {regenCheckpointPin.isError && (
            <p className="text-xs text-apex-red">{regenCheckpointPin.error?.message || 'Nie udało się wygenerować PIN-u'}</p>
          )}
          <p className="text-xs text-apex-muted">
            Dla urządzeń RFID na punktach kontrolnych (checkpoint-agent). Nie udostępniaj uczestnikom.
          </p>
        </CardContent>
      </Card>

      {/* Sync checkins */}
      <Card>
        <CardHeader><CardTitle>Synchronizacja check-inów</CardTitle></CardHeader>
        <CardContent>
          <Button
            variant="outline"
            onClick={handlePullCheckins}
            disabled={syncing}
          >
            <RefreshCw size={13} className={syncing ? 'animate-spin' : ''} />
            {syncing ? 'Pobieram...' : 'Pobierz check-iny'}
          </Button>
          <p className="text-xs text-apex-muted mt-2">
            Pobiera najnowsze check-iny z Supabase do lokalnej bazy danych.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}

function RfidSettings({ event, onSave, saving }) {
  // Saved values from the server are the dirty-tracking baseline. After a successful
  // save the event query refetches, this recomputes to match `form`, and the Save
  // button auto-disables again — the visual "changes applied" signal.
  const baseline = {
    rfidMode: event.rfidMode || 'single',
    goneWindowSeconds: event.goneWindowSeconds ?? 3,
    gunBackfillSeconds: event.gunBackfillSeconds ?? 60,
    gunBackfillEnabled: event.gunBackfillEnabled ?? true,
    rssiThreshold: event.rssiThreshold ?? -5000,
    minFinishSeconds: event.minFinishSeconds ?? 30,
  }
  const [form, setForm] = useState(baseline)
  const isDirty = JSON.stringify(form) !== JSON.stringify(baseline)

  const { data: readerConfig } = useQuery({ queryKey: ['reader-config'], queryFn: () => api.reader.getConfig() })
  const { data: mainStatus, error: mainError } = useQuery({
    queryKey: ['reader-status', 'main'],
    queryFn: () => api.reader.status('main'),
    retry: false,
    refetchInterval: 10000,
    enabled: !!readerConfig?.mainIp,
  })
  const isConfigured = !!readerConfig?.mainIp
  const readerOnline = !isConfigured || (!mainError && !!mainStatus)

  const set = (key, val) => setForm(f => ({ ...f, [key]: val }))

  return (
    <Card>
      <CardHeader><CardTitle>Ustawienia RFID</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div>
            <span className="text-xs font-bold uppercase tracking-widest text-apex-muted mb-2 block">Konfiguracja czytnika</span>
            <div className="space-y-2">
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="radio" name="rfidMode" value="single" checked={form.rfidMode === 'single'} onChange={() => set('rfidMode', 'single')} className="accent-terrain-green" />
                <span className="text-sm">Jeden czytnik — start i meta na tej samej bramce (domyślne, 95% wyścigów)</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="radio" name="rfidMode" value="separate" checked={form.rfidMode === 'separate'} onChange={() => set('rfidMode', 'separate')} className="accent-terrain-green" />
                <span className="text-sm">Oddzielne czytniki dla startu i mety</span>
              </label>
            </div>
            {form.rfidMode === 'separate' && (
              <p className="text-xs text-apex-muted mt-2">Tematy MQTT pobierane automatycznie z konfiguracji czytnika.</p>
            )}
          </div>

          <div className="pt-2 border-t border-stone-100 space-y-4">
            <label className="block">
              <span className="text-xs font-bold uppercase tracking-widest text-apex-muted mb-1 block">Okno ciszy (sekundy)</span>
              <Input type="number" step="1" min="1" max="10" value={form.goneWindowSeconds} onChange={e => set('goneWindowSeconds', parseInt(e.target.value))} className="max-w-32" />
              <p className="text-xs text-apex-muted mt-1">
                Domyślnie: 3 — czas braku sygnału po którym przejście przez bramkę zostaje potwierdzone. Czytnik rejestruje szczyt sygnału (moment przy bramce), a po N sekundach ciszy zapisuje start lub metę.
              </p>
            </label>
            <label className="block">
              <span className="text-xs font-bold uppercase tracking-widest text-apex-muted mb-1 block">Ignorowanie mety po starcie (sekundy)</span>
              <Input type="number" step="1" min="0" max="600" value={form.minFinishSeconds} onChange={e => set('minFinishSeconds', parseInt(e.target.value))} className="max-w-32" />
              <p className="text-xs text-apex-muted mt-1">
                Domyślnie: 30 — meta jest zaliczana przy PIERWSZYM odczycie chipa (reszta odczytów jest ignorowana), więc przez tyle sekund od strzału startowego odczyty mety są blokowane. Chroni przed „metą" zawodników stojących przy bramce tuż po starcie. Ustaw poniżej najszybszego możliwego czasu na trasie; przy krótkich testach obniż (np. 10 s).
              </p>
            </label>
            <div className="block">
              <label className="flex items-center gap-2 cursor-pointer mb-2">
                <input type="checkbox" checked={form.gunBackfillEnabled} onChange={e => set('gunBackfillEnabled', e.target.checked)} className="accent-terrain-green" />
                <span className="text-xs font-bold uppercase tracking-widest text-apex-muted">Auto-uzupełnienie startu</span>
              </label>
              <Input type="number" step="1" min="10" max="300" value={form.gunBackfillSeconds} onChange={e => set('gunBackfillSeconds', parseInt(e.target.value))} disabled={!form.gunBackfillEnabled} className={`max-w-32 ${!form.gunBackfillEnabled ? 'opacity-40 pointer-events-none' : ''}`} />
              <p className="text-xs text-apex-muted mt-1">
                {form.gunBackfillEnabled
                  ? 'Domyślnie: 60 — po tylu sekundach od startu, uczestnicy bez odczytu chipa na starcie automatycznie dostają czas strzałki startowej. Dzięki temu ich następne przejście przez bramkę zostanie zapisane jako meta, a nie start.'
                  : 'Wyłączone — uczestnicy bez odczytu chipa na starcie NIE dostaną automatycznie czasu strzałki startowej. Uzupełnisz ich ręcznie przyciskiem „Nadaj czas strzałki” w kontroli wyścigu.'}
              </p>
            </div>
            <label className="block">
              <span className="text-xs font-bold uppercase tracking-widest text-apex-muted mb-1 block">Próg sygnału (cdBm)</span>
              <Input type="number" step="50" min="-8000" max="-3000" value={form.rssiThreshold} onChange={e => set('rssiThreshold', parseInt(e.target.value))} className="max-w-32" />
              <p className="text-xs text-apex-muted mt-1">
                Domyślnie: -5000 (=-50 dBm) — odczyty słabsze niż próg są ignorowane przez detekcję przejść (nie liczą się jako obecność przy bramce i nie trafiają do audytu). Chroni przed łapaniem chipów stojących daleko od anteny (czułe tagi czytają się z 20+ m przy ok. -7500). Przejście przez bramkę to zwykle -4500…-6500 — jeśli detekcja gubi zawodników przy bramce, obniż próg (np. -6500); jeśli łapie stojących obok, podnieś.
              </p>
            </label>
          </div>

          {readerOnline ? (
            <Button onClick={() => onSave(form)} disabled={saving || !isDirty}>
              {saving ? 'Zapisywanie...' : isDirty ? 'Zapisz ustawienia RFID' : 'Zapisano'}
            </Button>
          ) : (
            <p className="text-xs text-apex-red">Czytnik niedostępny — zapis wyłączony.</p>
          )}
        </CardContent>
    </Card>
  )
}
