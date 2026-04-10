import { useParams, Link } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState, useRef, useMemo } from 'react'
import { api } from '../lib/api.js'
import { useWsEvent } from '../lib/ws.js'
import { formatDateTime, formatDuration, statusLabel, statusColor, cn } from '../lib/utils.js'
import { Badge } from '../components/ui/badge.jsx'
import { Button } from '../components/ui/button.jsx'
import { Card, CardHeader, CardTitle, CardContent } from '../components/ui/card.jsx'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogBody, DialogFooter } from '../components/ui/dialog.jsx'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../components/ui/tabs.jsx'
import { Radio, Flag, Square, RotateCcw, AlertTriangle, Trophy } from 'lucide-react'

const MAX_FEED = 50

const GATE_LABEL = { start: 'START', finish: 'META' }

export default function RaceControl() {
  const { id } = useParams()
  const qc = useQueryClient()
  const [feed, setFeed] = useState([])
  const [rawFeed, setRawFeed] = useState([])
  const feedRef = useRef(feed)

  const { data: categories = [] } = useQuery({
    queryKey: ['categories', id],
    queryFn: () => api.categories.list(id).then(rows => rows.map(r => r.category || r)),
  })
  const { data: races = [] } = useQuery({
    queryKey: ['races', id],
    queryFn: () => api.races.list(id),
  })
  const { data: participants = [] } = useQuery({
    queryKey: ['participants', id],
    queryFn: () => api.participants.list(id),
  })

  const participantMap = Object.fromEntries(participants.map(p => [p.id, p]))
  const epcMap = Object.fromEntries(participants.filter(p => p.rfidEpc).map(p => [p.rfidEpc, p]))

  // Determine the active raceRunId for audit (most recently started active race across all categories)
  const activeRaceRunId = useMemo(() => {
    const active = races.filter(r => r.status === 'active')
    if (!active.length) {
      // Fall back to most recent finished race
      const all = [...races].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      return all[0]?.id || null
    }
    return active.sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt))[0]?.id || null
  }, [races])

  const { data: auditData } = useQuery({
    queryKey: ['audit', activeRaceRunId],
    queryFn: () => api.races.audit(activeRaceRunId),
    enabled: !!activeRaceRunId,
    refetchInterval: 30000,
  })

  const gunStartFallback = auditData?.gunStartFallback ?? []
  const missingStart = auditData?.missingStart ?? []
  const unresolvedCount = gunStartFallback.filter(r => r.startTimeSource === 'gun').length + missingStart.length

  useWsEvent('rfid:crossing', (payload) => {
    const p = participantMap[payload.participantId]
    setFeed(prev => [{
      ...payload,
      participant: p,
      ts: new Date(),
    }, ...prev].slice(0, MAX_FEED))
    qc.invalidateQueries({ queryKey: ['races', id] })
    qc.invalidateQueries({ queryKey: ['results'] })
    qc.invalidateQueries({ queryKey: ['audit'] })
  })

  useWsEvent('rfid:raw', (payload) => {
    if (!epcMap[payload.epc]) return
    setRawFeed(prev => [{ ...payload, ts: new Date() }, ...prev].slice(0, 20))
  })

  useWsEvent('result:update', () => {
    qc.invalidateQueries({ queryKey: ['audit'] })
  })

  useWsEvent('race:update', () => {
    qc.invalidateQueries({ queryKey: ['races', id] })
    qc.invalidateQueries({ queryKey: ['audit'] })
  })

  const raceByCategory = {}
  for (const race of races) {
    const existing = raceByCategory[race.categoryId]
    if (!existing || new Date(race.createdAt) > new Date(existing.createdAt)) {
      raceByCategory[race.categoryId] = race
    }
  }

  // "Start all" logic — starts all categories where at least 1 participant is checked in
  const [startAllDialog, setStartAllDialog] = useState(false)
  const [startAllCountdown, setStartAllCountdown] = useState(null)
  const [startAllDuration, setStartAllDuration] = useState(3)
  const startAllIntervalRef = useRef(null)

  const startableCategories = categories.filter(cat => {
    const race = raceByCategory[cat.id]
    const isPending = !race || race.status === 'pending'
    if (!isPending) return false
    return participants.filter(p => p.categoryId === cat.id).some(p => p.checkin?.checkedInAt)
  })

  const startAllMutation = useMutation({
    mutationFn: () => Promise.all(startableCategories.map(cat => api.races.start(cat.id))),
    onSuccess: () => {
      setStartAllDialog(false)
      qc.invalidateQueries({ queryKey: ['races', id] })
    },
  })

  const beginStartAllCountdown = () => {
    setStartAllCountdown(startAllDuration)
    let current = startAllDuration
    startAllIntervalRef.current = setInterval(() => {
      current -= 1
      if (current <= 0) {
        clearInterval(startAllIntervalRef.current)
        setStartAllCountdown(0)
        startAllMutation.mutate()
      } else {
        setStartAllCountdown(current)
      }
    }, 1000)
  }

  const closeStartAllDialog = () => {
    clearInterval(startAllIntervalRef.current)
    setStartAllDialog(false)
    setStartAllCountdown(null)
  }

  // "Resume all" logic — restarts all finished/cancelled categories with checked-in participants
  const [resumeAllDialog, setResumeAllDialog] = useState(false)
  const [resumeAllCountdown, setResumeAllCountdown] = useState(null)
  const [resumeAllDuration, setResumeAllDuration] = useState(3)
  const resumeAllIntervalRef = useRef(null)

  const resumableCategories = categories.filter(cat => {
    const race = raceByCategory[cat.id]
    if (!race || (race.status !== 'finished' && race.status !== 'cancelled')) return false
    return participants.filter(p => p.categoryId === cat.id).some(p => p.checkin?.checkedInAt)
  })

  const resumeAllMutation = useMutation({
    mutationFn: () => Promise.all(resumableCategories.map(cat => api.races.start(cat.id))),
    onSuccess: () => {
      setResumeAllDialog(false)
      qc.invalidateQueries({ queryKey: ['races', id] })
    },
  })

  const beginResumeAllCountdown = () => {
    setResumeAllCountdown(resumeAllDuration)
    let current = resumeAllDuration
    resumeAllIntervalRef.current = setInterval(() => {
      current -= 1
      if (current <= 0) {
        clearInterval(resumeAllIntervalRef.current)
        setResumeAllCountdown(0)
        resumeAllMutation.mutate()
      } else {
        setResumeAllCountdown(current)
      }
    }, 1000)
  }

  const closeResumeAllDialog = () => {
    clearInterval(resumeAllIntervalRef.current)
    setResumeAllDialog(false)
    setResumeAllCountdown(null)
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="font-display text-4xl uppercase tracking-widest text-apex-text-bright">Sterowanie wyścigiem</h1>
        <div className="flex items-center gap-3">
          {startableCategories.length > 1 && (
            <Button size="sm" onClick={() => setStartAllDialog(true)}>
              <Flag size={13} /> Startuj wszystkie ({startableCategories.length})
            </Button>
          )}
          {resumableCategories.length > 1 && (
            <Button size="sm" variant="outline" onClick={() => setResumeAllDialog(true)}>
              <RotateCcw size={13} /> Wznów wszystkie ({resumableCategories.length})
            </Button>
          )}
          <div className="flex items-center gap-2 text-xs text-apex-muted">
            <Radio size={12} className="animate-pulse text-apex-yellow" />
            Na żywo
          </div>
          <Link to={`/events/${id}/results`}>
            <Button variant="outline" size="sm"><Trophy size={13} /> Wyniki na żywo</Button>
          </Link>
        </div>
      </div>

      {/* Start All Dialog */}
      <Dialog open={startAllDialog} onOpenChange={(o) => { if (!o) closeStartAllDialog() }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Start wszystkich kategorii</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <div className="text-sm text-apex-muted space-y-1 mb-4">
              <div>Kategorie do wystartowania:</div>
              <div className="border border-apex-border divide-y divide-apex-border mt-2">
                {startableCategories.map(cat => {
                  const catParticipants = participants.filter(p => p.categoryId === cat.id)
                  const catCheckedIn = catParticipants.filter(p => p.checkin?.checkedInAt).length
                  return (
                    <div key={cat.id} className="flex items-center justify-between px-3 py-1.5 text-xs">
                      <span className="text-apex-text font-semibold">{cat.name}</span>
                      <span>{catCheckedIn}/{catParticipants.length} zameldowanych</span>
                    </div>
                  )
                })}
              </div>
            </div>
            {startAllCountdown !== null ? (
              <div className="text-center py-4">
                <div className={`font-display text-8xl ${startAllCountdown === 0 ? 'text-apex-red' : 'text-apex-yellow'}`}>
                  {startAllCountdown === 0 ? 'START' : startAllCountdown}
                </div>
                <div className="text-sm text-apex-muted mt-2">{startAllCountdown === 0 ? 'Startowanie...' : 'Gotowość...'}</div>
              </div>
            ) : (
              <div className="space-y-3">
                <div>
                  <span className="text-xs font-semibold uppercase tracking-wider text-apex-muted mb-2 block">Czas odliczania</span>
                  <div className="flex gap-2">
                    {[3, 5, 10, 30].map(s => (
                      <button
                        key={s}
                        onClick={() => setStartAllDuration(s)}
                        className={`px-3 py-1.5 text-sm font-semibold border transition-colors ${startAllDuration === s ? 'border-apex-yellow bg-apex-yellow text-black' : 'border-apex-border-mid text-apex-muted hover:border-apex-yellow hover:text-apex-yellow'}`}
                      >
                        {s}s
                      </button>
                    ))}
                  </div>
                </div>
                <Button className="w-full" onClick={beginStartAllCountdown}>Rozpocznij odliczanie</Button>
              </div>
            )}
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={closeStartAllDialog}>Anuluj</Button>
            {startAllCountdown === null && (
              <Button onClick={() => startAllMutation.mutate()} disabled={startAllMutation.isPending}>
                {startAllMutation.isPending ? 'Startowanie...' : 'Startuj teraz (bez odliczania)'}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Resume All Dialog */}
      <Dialog open={resumeAllDialog} onOpenChange={(o) => { if (!o) closeResumeAllDialog() }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Wznów wszystkie kategorie</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <div className="text-sm text-apex-muted space-y-1 mb-4">
              <div>Kategorie do wznowienia:</div>
              <div className="border border-apex-border divide-y divide-apex-border mt-2">
                {resumableCategories.map(cat => {
                  const catParticipants = participants.filter(p => p.categoryId === cat.id)
                  const catCheckedIn = catParticipants.filter(p => p.checkin?.checkedInAt).length
                  return (
                    <div key={cat.id} className="flex items-center justify-between px-3 py-1.5 text-xs">
                      <span className="text-apex-text font-semibold">{cat.name}</span>
                      <span>{catCheckedIn}/{catParticipants.length} zameldowanych</span>
                    </div>
                  )
                })}
              </div>
            </div>
            {resumeAllCountdown !== null ? (
              <div className="text-center py-4">
                <div className={`font-display text-8xl ${resumeAllCountdown === 0 ? 'text-apex-red' : 'text-apex-yellow'}`}>
                  {resumeAllCountdown === 0 ? 'START' : resumeAllCountdown}
                </div>
                <div className="text-sm text-apex-muted mt-2">{resumeAllCountdown === 0 ? 'Startowanie...' : 'Gotowość...'}</div>
              </div>
            ) : (
              <div className="space-y-3">
                <div>
                  <span className="text-xs font-semibold uppercase tracking-wider text-apex-muted mb-2 block">Czas odliczania</span>
                  <div className="flex gap-2">
                    {[3, 5, 10, 30].map(s => (
                      <button
                        key={s}
                        onClick={() => setResumeAllDuration(s)}
                        className={`px-3 py-1.5 text-sm font-semibold border transition-colors ${resumeAllDuration === s ? 'border-apex-yellow bg-apex-yellow text-black' : 'border-apex-border-mid text-apex-muted hover:border-apex-yellow hover:text-apex-yellow'}`}
                      >
                        {s}s
                      </button>
                    ))}
                  </div>
                </div>
                <Button className="w-full" onClick={beginResumeAllCountdown}>Rozpocznij odliczanie</Button>
              </div>
            )}
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={closeResumeAllDialog}>Anuluj</Button>
            {resumeAllCountdown === null && (
              <Button onClick={() => resumeAllMutation.mutate()} disabled={resumeAllMutation.isPending}>
                {resumeAllMutation.isPending ? 'Startowanie...' : 'Wznów teraz (bez odliczania)'}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="space-y-3">
          {categories.map(cat => (
            <RaceCard
              key={cat.id}
              category={cat}
              race={raceByCategory[cat.id]}
              participants={participants.filter(p => p.categoryId === cat.id)}
              onRefresh={() => qc.invalidateQueries({ queryKey: ['races', id] })}
            />
          ))}
          {categories.length === 0 && (
            <div className="py-12 text-center text-apex-muted text-sm">Brak kategorii. Dodaj je w zakładce zawodów.</div>
          )}
        </div>

        <div>
          <Tabs defaultValue="feed">
            <TabsList className="w-full mb-3">
              <TabsTrigger value="feed" className="flex-1">Feed</TabsTrigger>
              <TabsTrigger value="audit" className="flex-1 relative">
                Audit
                {unresolvedCount > 0 && (
                  <span className="ml-1.5 bg-amber-500 text-black text-xs font-bold px-1.5 py-0.5 leading-none">
                    {unresolvedCount}
                  </span>
                )}
              </TabsTrigger>
            </TabsList>

            <TabsContent value="feed" className="space-y-3">
              <Card>
                <CardHeader className="py-2.5"><CardTitle className="text-base">Przejścia na żywo</CardTitle></CardHeader>
                <CardContent className="p-0 max-h-80 overflow-y-auto">
                  {feed.length === 0 && (
                    <div className="py-6 text-center text-xs text-apex-muted">Oczekiwanie na przejścia...</div>
                  )}
                  {feed.map((ev, i) => (
                    <div key={i} className="flex items-center gap-2 px-3 py-2 border-b border-apex-border last:border-0">
                      <span className={cn('px-1.5 py-0.5 text-xs font-bold border uppercase', ev.gate === 'start' ? 'border-apex-cyan text-apex-cyan bg-transparent font-mono' : 'border-apex-yellow text-apex-yellow bg-transparent font-mono')}>
                        {GATE_LABEL[ev.gate] ?? ev.gate}
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="text-xs font-semibold text-apex-text truncate">
                          {ev.participant ? `#${ev.participant.bibNumber} ${ev.participant.firstName} ${ev.participant.lastName}` : 'Nieznany'}
                        </div>
                        <div className="text-xs text-apex-muted">{formatDateTime(ev.confirmedAt)}</div>
                      </div>
                    </div>
                  ))}
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="py-2.5"><CardTitle className="text-base">Surowe odczyty RFID</CardTitle></CardHeader>
                <CardContent className="p-0 max-h-48 overflow-y-auto font-mono text-xs">
                  {rawFeed.length === 0 && (
                    <div className="py-4 text-center text-apex-muted">Brak sygnałów</div>
                  )}
                  {rawFeed.map((ev, i) => {
                    const p = epcMap[ev.epc]
                    return (
                      <div key={i} className="flex items-center gap-2 px-3 py-1 border-b border-apex-border last:border-0">
                        <span className="text-apex-muted shrink-0">{formatDateTime(ev.ts.toISOString())}</span>
                        <span className="truncate" title={ev.epc}>
                          {p
                            ? <span className="text-apex-text font-sans">#{p.bibNumber} {p.firstName} {p.lastName}</span>
                            : <span className="text-apex-muted font-mono">{ev.epc}</span>
                          }
                        </span>
                        <span className="text-apex-muted ml-auto shrink-0">{ev.rssi}</span>
                      </div>
                    )
                  })}
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="audit">
              <AuditPanel
                gunStartFallback={gunStartFallback}
                missingStart={missingStart}
                raceRunId={activeRaceRunId}
                raceRun={races.find(r => r.id === activeRaceRunId)}
                onCorrect={() => qc.invalidateQueries({ queryKey: ['audit'] })}
              />
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </div>
  )
}

function RaceCard({ category, race, participants, onRefresh }) {
  const qc = useQueryClient()
  const [startDialog, setStartDialog] = useState(false)
  const [stopDialog, setStopDialog] = useState(false)
  const [countdown, setCountdown] = useState(null)
  const [countdownDuration, setCountdownDuration] = useState(3)
  const [sliderVal, setSliderVal] = useState(0)
  const intervalRef = useRef(null)

  const { data: results = [] } = useQuery({
    queryKey: ['results', race?.id],
    queryFn: () => api.results.list(race.id),
    enabled: !!race?.id,
    refetchInterval: race?.status === 'active' ? 5000 : false,
  })

  useWsEvent('result:update', (payload) => {
    if (payload.raceRunId === race?.id) {
      qc.invalidateQueries({ queryKey: ['results', race.id] })
    }
  })

  const start = useMutation({
    mutationFn: () => api.races.start(category.id),
    onSuccess: () => { setStartDialog(false); onRefresh() },
  })

  const stop = useMutation({
    mutationFn: ({ markDnf }) => api.races.update(race.id, { status: 'finished', markRemainingDnf: markDnf }),
    onSuccess: () => { setStopDialog(false); onRefresh() },
  })

  const checkedIn = participants.filter(p => p.checkin?.checkedInAt).length
  const finished = results.filter(r => r.status === 'finished').length
  const started = results.filter(r => r.status === 'started').length
  const isActive = race?.status === 'active'
  const isPending = !race || race.status === 'pending'

  const beginCountdown = () => {
    setCountdown(countdownDuration)
    let current = countdownDuration
    intervalRef.current = setInterval(() => {
      current -= 1
      if (current <= 0) {
        clearInterval(intervalRef.current)
        setCountdown(0)
        start.mutate()
      } else {
        setCountdown(current)
      }
    }, 1000)
  }

  const closeStartDialog = () => {
    clearInterval(intervalRef.current)
    setStartDialog(false)
    setCountdown(null)
  }

  return (
    <>
      <Card className={isActive ? 'border-terrain-green' : ''}>
        <CardHeader className="py-2.5 flex flex-row items-center justify-between">
          <CardTitle className="text-lg">{category.name}</CardTitle>
          <Badge className={statusColor(race?.status || 'pending')}>{statusLabel(race?.status || 'pending')}</Badge>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-6 text-xs text-apex-muted mb-3">
            <span>{participants.length} uczestników</span>
            <span>{checkedIn} zameldowanych</span>
            {isActive && <span className="text-apex-cyan font-bold tracking-wider">{finished} na mecie · {started} na trasie</span>}
            {race?.startedAt && <span>Start {formatDateTime(race.startedAt)}</span>}
          </div>

          {isActive && results.filter(r => r.finishTime).length > 0 && (
            <div className="mb-3 border border-apex-border divide-y divide-apex-border">
              {results.filter(r => r.finishTime).slice(0, 3).map((r, i) => (
                <div key={r.id} className="flex items-center gap-3 px-3 py-1.5 text-sm">
                  <span className="font-display text-lg text-apex-yellow w-5">{r.position}</span>
                  <span className="flex-1 font-medium text-apex-text">
                    #{r.participant?.bibNumber} {r.participant?.firstName} {r.participant?.lastName}
                  </span>
                  <span className="font-mono text-xs text-apex-muted">{formatDuration(r.durationMs)}</span>
                </div>
              ))}
            </div>
          )}

          <div className="flex items-center gap-2">
            {isPending && (
              <Button size="sm" onClick={() => setStartDialog(true)} disabled={checkedIn === 0} title={checkedIn === 0 ? 'Brak zameldowanych uczestników' : undefined}>
                <Flag size={13} /> Rozpocznij wyścig
              </Button>
            )}
            {isActive && (
              <Button size="sm" variant="destructive" onClick={() => setStopDialog(true)}>
                <Square size={13} /> Zatrzymaj wyścig
              </Button>
            )}
            {(race?.status === 'finished' || race?.status === 'cancelled') && (
              <Button size="sm" variant="outline" onClick={() => setStartDialog(true)} disabled={checkedIn === 0} title={checkedIn === 0 ? 'Brak zameldowanych uczestników' : undefined}>
                <RotateCcw size={13} /> Wznów
              </Button>
            )}
            {checkedIn === 0 && !isActive && (
              <span className="text-xs text-apex-muted">Zamelduj uczestników, aby rozpocząć</span>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Dialog startu */}
      <Dialog open={startDialog} onOpenChange={(o) => { if (!o) closeStartDialog() }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Start — {category.name}</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <div className="text-sm text-apex-muted space-y-1 mb-4">
              <div>Uczestnicy ogółem: <strong>{participants.length}</strong></div>
              <div>Zameldowani: <strong className={checkedIn < participants.length ? 'text-amber-400' : 'text-apex-yellow'}>{checkedIn}</strong></div>
              {checkedIn < participants.length && (
                <div className="mt-2 space-y-1.5">
                  <div className="flex items-center gap-1.5 text-amber-400 text-xs">
                    <AlertTriangle size={13} /> {participants.length - checkedIn} uczestników niezameldowanych
                  </div>
                  <div className="border border-amber-400/30 bg-amber-400/5 max-h-32 overflow-y-auto">
                    {participants.filter(p => !p.checkin?.checkedInAt).map(p => (
                      <div key={p.id} className="flex items-center gap-2 px-2 py-1 text-xs border-b border-amber-400/20 last:border-0">
                        <span className="font-mono text-apex-muted w-8 shrink-0">#{p.bibNumber}</span>
                        <span className="text-apex-text">{p.firstName} {p.lastName}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
            {countdown !== null ? (
              <div className="text-center py-4">
                <div className={`font-display text-8xl ${countdown === 0 ? 'text-apex-red' : 'text-apex-yellow'}`}>
                  {countdown === 0 ? 'START' : countdown}
                </div>
                <div className="text-sm text-apex-muted mt-2">{countdown === 0 ? 'Startowanie...' : 'Gotowość...'}</div>
              </div>
            ) : (
              <div className="space-y-3">
                <div>
                  <span className="text-xs font-semibold uppercase tracking-wider text-apex-muted mb-2 block">Czas odliczania</span>
                  <div className="flex gap-2">
                    {[3, 5, 10, 30].map(s => (
                      <button
                        key={s}
                        onClick={() => setCountdownDuration(s)}
                        className={`px-3 py-1.5 text-sm font-semibold border transition-colors ${countdownDuration === s ? 'border-apex-yellow bg-apex-yellow text-black' : 'border-apex-border-mid text-apex-muted hover:border-apex-yellow hover:text-apex-yellow'}`}
                      >
                        {s}s
                      </button>
                    ))}
                  </div>
                </div>
                <Button className="w-full" onClick={beginCountdown} disabled={checkedIn === 0}>Rozpocznij odliczanie</Button>
              </div>
            )}
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={closeStartDialog}>Anuluj</Button>
            {countdown === null && (
              <Button onClick={() => start.mutate()} disabled={start.isPending || checkedIn === 0}>
                {start.isPending ? 'Startowanie...' : 'Startuj teraz (bez odliczania)'}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Dialog zatrzymania */}
      <Dialog open={stopDialog} onOpenChange={setStopDialog}>
        <DialogContent>
          <DialogHeader><DialogTitle>Zatrzymaj — {category.name}</DialogTitle></DialogHeader>
          <DialogBody>
            <p className="text-sm text-apex-muted mb-4">
              Przesuń, aby potwierdzić zatrzymanie wyścigu. Tej operacji nie można cofnąć (możesz wznowić nowy bieg).
            </p>
            <div className="mb-4">
              <input
                type="range" min={0} max={100} value={sliderVal}
                onChange={e => setSliderVal(Number(e.target.value))}
                className="w-full accent-apex-yellow"
              />
              <p className="text-xs text-center text-apex-muted mt-1">
                {sliderVal < 100 ? `Przesuń, aby potwierdzić (${sliderVal}%)` : '✓ Gotowy do zatrzymania'}
              </p>
            </div>
            {sliderVal === 100 && (
              <Button className="w-full" variant="destructive" onClick={() => stop.mutate({ markDnf: true })} disabled={stop.isPending}>
                Zatrzymaj wyścig
              </Button>
            )}
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setStopDialog(false); setSliderVal(0) }}>Anuluj</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

function AuditPanel({ gunStartFallback, missingStart, raceRunId, raceRun, onCorrect }) {
  const [editingId, setEditingId] = useState(null)
  const [timeInput, setTimeInput] = useState('')

  const correctMutation = useMutation({
    mutationFn: ({ resultId, startTime }) => api.results.update(resultId, { startTime }),
    onSuccess: () => {
      setEditingId(null)
      setTimeInput('')
      onCorrect()
    },
  })

  const assignGunMutation = useMutation({
    mutationFn: (participantIds) => api.races.assignGunStart(raceRunId, participantIds),
    onSuccess: () => onCorrect(),
  })

  function parseTime(hhmmss, gunStartTime) {
    // Parse HH:MM:SS relative to the race start date
    const [h, m, s] = hhmmss.split(':').map(Number)
    if ([h, m, s].some(isNaN)) return null
    const base = new Date(gunStartTime)
    base.setHours(h, m, s, 0)
    return base.toISOString()
  }

  if (!gunStartFallback.length && !missingStart.length) {
    return (
      <div className="py-8 text-center text-xs text-apex-muted">
        Brak wpisów auditu.
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Section: gun start fallback */}
      <div>
        <div className="flex items-center gap-2 mb-2">
          <span className="bg-amber-900 text-amber-400 text-xs font-bold px-2 py-0.5 uppercase tracking-widest">
            <AlertTriangle size={10} className="inline mr-1" />
            Brutto użyte zamiast netto
          </span>
          {gunStartFallback.filter(r => r.startTimeSource === 'gun').length > 0 && (
            <span className="text-xs text-apex-muted">
              {gunStartFallback.filter(r => r.startTimeSource === 'gun').length} do poprawy
            </span>
          )}
        </div>

        <div className="border border-apex-border">
          {/* Header row */}
          <div className="grid grid-cols-[2fr_1fr_1fr_1fr_1.5fr] gap-2 px-3 py-1.5 bg-apex-surface text-xs text-apex-muted uppercase tracking-widest border-b border-apex-border">
            <span>Zawodnik</span>
            <span>Netto*</span>
            <span>Brutto</span>
            <span>Powód</span>
            <span>Akcja</span>
          </div>

          {gunStartFallback.map(r => {
            const reason = r.startTimeSource === 'manual'
              ? 'poprawiono ręcznie'
              : r.startTimeTrigger === 'finish_crossing'
                ? 'brak startu RFID (meta)'
                : r.startTimeTrigger === 'auto_backfill'
                  ? 'brak startu RFID (auto)'
                  : r.startTimeTrigger?.startsWith('checkpoint:')
                    ? r.checkpointName
                      ? `brak startu RFID (pkt ${r.checkpointName})`
                      : 'brak startu RFID (usunięty punkt)'  // checkpoint deleted
                    : 'brak startu RFID'

            const nettoLabel = r.durationMs ? formatDuration(r.durationMs) : '—'
            const bruttoLabel = r.gunDurationMs ? formatDuration(r.gunDurationMs) : '—'
            const isResolved = r.startTimeSource === 'manual'

            return (
              <div
                key={r.resultId}
                className={`grid grid-cols-[2fr_1fr_1fr_1fr_1.5fr] gap-2 px-3 py-2 border-b border-apex-border last:border-0 text-xs items-center ${isResolved ? 'opacity-50' : ''}`}
              >
                <span className="text-apex-text truncate">
                  {r.emoji && <span className="mr-1">{r.emoji}</span>}
                  {r.firstName} {r.lastName}
                  {r.bibNumber && <span className="ml-1 text-apex-muted">#{r.bibNumber}</span>}
                </span>

                <span className={isResolved ? 'text-green-400' : 'text-amber-400'}>
                  {nettoLabel}
                  <span className={`ml-1 text-xs font-bold px-1 ${isResolved ? 'bg-green-900 text-green-400' : 'bg-amber-900 text-amber-400'}`}>
                    {r.startTimeSource === 'manual' ? 'MANUAL' : 'GUN'}
                  </span>
                </span>

                <span className="text-apex-muted">{bruttoLabel}</span>

                <span className="text-apex-muted truncate" title={reason}>{reason}</span>

                <div>
                  {isResolved ? (
                    <span className="text-apex-muted italic">poprawiono ✓</span>
                  ) : editingId === r.resultId ? (
                    <div className="flex gap-1 items-center">
                      <input
                        type="text"
                        placeholder="HH:MM:SS"
                        value={timeInput}
                        onChange={e => setTimeInput(e.target.value)}
                        className="bg-apex-surface border border-apex-border text-apex-text px-1.5 py-0.5 w-20 text-xs font-mono focus:outline-none focus:border-apex-yellow"
                      />
                      <button
                        className="border border-apex-border px-2 py-0.5 text-xs text-apex-text hover:border-apex-yellow hover:text-apex-yellow"
                        onClick={() => {
                          if (!raceRun?.startedAt) return
                          const iso = parseTime(timeInput, raceRun.startedAt)
                          if (!iso) return
                          correctMutation.mutate({ resultId: r.resultId, startTime: iso })
                        }}
                        disabled={correctMutation.isPending}
                      >
                        OK
                      </button>
                      <button
                        className="text-apex-muted text-xs hover:text-apex-text"
                        onClick={() => { setEditingId(null); setTimeInput('') }}
                      >✕</button>
                    </div>
                  ) : (
                    <button
                      className="border border-apex-border px-2 py-0.5 text-xs text-apex-text hover:border-apex-yellow hover:text-apex-yellow"
                      onClick={() => { setEditingId(r.resultId); setTimeInput('') }}
                    >
                      Podaj czas startu
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>

        <p className="text-xs text-apex-muted mt-2">
          * GUN = użyto czasu brutto jako zastępstwo. MANUAL = ręcznie poprawiony przez operatora.
        </p>
      </div>

      {/* Checked-in participants with no start crossing */}
      {missingStart.length > 0 && (
        <div>
          <div className="flex items-center gap-2 mb-2">
            <span className="bg-blue-900 text-blue-400 text-xs font-bold px-2 py-0.5 uppercase tracking-widest">
              <AlertTriangle size={10} className="inline mr-1" />
              Zameldowani bez startu RFID
            </span>
            <span className="text-xs text-apex-muted">
              {missingStart.length} {missingStart.length === 1 ? 'osoba' : 'osób'}
            </span>
          </div>

          <div className="border border-apex-border">
            <div className="grid grid-cols-[2fr_1fr_1fr] gap-2 px-3 py-1.5 bg-apex-surface text-xs text-apex-muted uppercase tracking-widest border-b border-apex-border">
              <span>Zawodnik</span>
              <span>EPC</span>
              <span>Akcja</span>
            </div>

            {missingStart.map(p => (
              <div key={p.participantId} className="grid grid-cols-[2fr_1fr_1fr] gap-2 px-3 py-2 border-b border-apex-border last:border-0 text-xs items-center">
                <span className="text-apex-text truncate">
                  {p.emoji && <span className="mr-1">{p.emoji}</span>}
                  {p.firstName} {p.lastName}
                  {p.bibNumber && <span className="ml-1 text-apex-muted">#{p.bibNumber}</span>}
                </span>
                <span className="font-mono text-apex-muted truncate">{p.rfidEpc}</span>
                <button
                  className="border border-apex-border px-2 py-0.5 text-xs text-apex-text hover:border-apex-yellow hover:text-apex-yellow disabled:opacity-50"
                  onClick={() => assignGunMutation.mutate([p.participantId])}
                  disabled={assignGunMutation.isPending}
                >
                  Nadaj czas strzałki
                </button>
              </div>
            ))}
          </div>

          {missingStart.length > 1 && (
            <button
              className="mt-2 border border-apex-border px-3 py-1 text-xs text-apex-text hover:border-apex-yellow hover:text-apex-yellow disabled:opacity-50"
              onClick={() => assignGunMutation.mutate(missingStart.map(p => p.participantId))}
              disabled={assignGunMutation.isPending}
            >
              Nadaj czas strzałki wszystkim ({missingStart.length})
            </button>
          )}
        </div>
      )}
    </div>
  )
}
