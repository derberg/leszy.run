import { useState, useEffect, useRef, useCallback } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api.js'
import { useWsEvent } from '../lib/ws.js'
import { Card, CardHeader, CardTitle, CardContent } from '../components/ui/card.jsx'
import { Button } from '../components/ui/button.jsx'
import { Input } from '../components/ui/input.jsx'
import { Wifi, WifiOff, Play, Square, Settings, RefreshCw, Eye, EyeOff, Info, ChevronDown } from 'lucide-react'

export default function ReaderDashboard() {
  const { data: config } = useQuery({ queryKey: ['reader-config'], queryFn: () => api.reader.getConfig() })
  const [configOpen, setConfigOpen] = useState(false)

  return (
    <div>
      <div className="flex items-start justify-between mb-6 gap-4">
        <h1 className="font-display text-4xl uppercase tracking-widest text-apex-text-bright">Stan czytnika RFID</h1>
        <button
          onClick={() => setConfigOpen(v => !v)}
          className="flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-apex-muted hover:text-apex-text border border-apex-border-mid hover:border-apex-yellow px-3 py-2 shrink-0 transition-colors"
        >
          <Settings size={13} />
          Konfiguracja adresów
          <ChevronDown size={12} className={`transition-transform duration-200 ${configOpen ? 'rotate-180' : ''}`} />
        </button>
      </div>

      {configOpen && (
        <div className="mb-6">
          <ReaderConfig />
        </div>
      )}

      <MqttBrokerBanner />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ReaderPanel role="main" label="Czytnik główny (start)" />
        {config?.finishIp && <ReaderPanel role="finish" label="Czytnik mety" />}
      </div>
    </div>
  )
}

// ─── Backend ↔ Mosquitto broker status banner ────────────────────────────────
// Mosquitto runs natively on macOS (outside Docker — the R700 must reach it on
// the LAN), so `docker compose up` does NOT start it. When it's down, nothing
// on this page can work — surface that loudly instead of a muted badge.

function MqttBrokerBanner() {
  const [connected, setConnected] = useState(null)
  const { data: statusData } = useQuery({
    queryKey: ['rfid-status'],
    queryFn: () => api.rfid.status(),
    refetchInterval: 10000,
  })
  useEffect(() => { if (statusData != null) setConnected(statusData.connected) }, [statusData])
  useWsEvent('rfid:status', useCallback((payload) => setConnected(payload.connected), []))

  if (connected !== false) return null

  return (
    <div className="mb-6 border-2 border-apex-red bg-apex-red/10 px-4 py-3 flex items-start gap-3">
      <WifiOff size={22} className="text-apex-red shrink-0 mt-0.5" />
      <div className="space-y-1.5">
        <p className="text-sm font-bold uppercase tracking-widest text-apex-red">Broker MQTT (Mosquitto) nie działa</p>
        <p className="text-xs text-apex-muted">
          Backend nie ma połączenia z brokerem — odczyty RFID z czytników nie dotrą do systemu,
          nawet jeśli czytnik jest dostępny. Mosquitto działa natywnie na macOS (poza Dockerem,
          bo czytnik R700 musi się z nim łączyć po sieci lokalnej) i trzeba go uruchomić osobno:
        </p>
        <p className="font-mono text-xs bg-apex-surface border border-apex-border px-2 py-1 inline-block select-all">
          /opt/homebrew/sbin/mosquitto -c mosquitto/config/mosquitto.conf
        </p>
      </div>
    </div>
  )
}

// ─── Reader IP + MQTT host config ─────────────────────────────────────────────

function ReaderConfig() {
  const qc = useQueryClient()
  const { data: config } = useQuery({
    queryKey: ['reader-config'],
    queryFn: () => api.reader.getConfig(),
  })
  const { data: preset } = useQuery({
    queryKey: ['reader-preset'],
    queryFn: () => api.reader.preset(),
  })
  const [presetForm, setPresetForm] = useState(null)
  useEffect(() => { if (preset?.antennaConfigs) setPresetForm(preset.antennaConfigs) }, [preset])

  const isPresetDirty = preset && presetForm
    ? JSON.stringify(presetForm) !== JSON.stringify(preset.antennaConfigs)
    : false

  const savePreset = useMutation({
    mutationFn: () => api.reader.savePreset({ antennaConfigs: presetForm }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['reader-preset'] }),
  })

  const setAntennaField = (port, field, rawValue) => {
    const value = field === 'transmitPowerCdbm' ? Math.round(parseFloat(rawValue) * 100)
      : ['inventorySession', 'estimatedTagPopulation', 'rfMode'].includes(field) ? parseInt(rawValue, 10)
      : rawValue
    setPresetForm(prev => prev.map(a => a.antennaPort === port ? { ...a, [field]: value } : a))
  }

  const [tooltipField, setTooltipField] = useState(null)

  const FIELD_INFO = {
    transmitPowerCdbm: {
      label: 'Moc nadawania (TX)',
      desc: 'Moc sygnału RF wysyłanego przez antenę. Wyższa moc = większy zasięg, ale też więcej odbić i "przesłuchań" z sąsiednich bram.',
      options: 'cdbm = dBm × 100, krok 25 cdbm (0.25 dBm). Maks. zależy od regionu i zasilania: PoE max ~3000 (30 dBm), PoE+ max ~3150–3300 (31.5–33 dBm)',
      recommended: '3150 (31.5 dBm) — wartość domyślna presetu, typowa dla PoE+. Zredukuj gdy bramka jest wąska lub zawodnicy biegną bardzo gęsto.',
    },
    inventorySession: {
      label: 'Sesja RFID',
      desc: 'Sesja protokołu EPC Gen2. Kontroluje jak szybko tag "wraca" do stanu gotowości po odczycie przez czytnik.',
      options: '0 – tag gotowy natychmiast (wysokie duplikaty)\n1 – tag czeka ok. 500 ms\n2 – tag czeka 2 s (zalecana)\n3 – tag czeka 8 s',
      recommended: 'Sesja 2 — po odczycie tag milczy ~2 s, co redukuje duplikaty przy długim przejściu przez bramkę. Sesja 1 gdy zawodnicy przebiegają bardzo szybko (< 1 s kontakt).',
    },
    inventorySearchMode: {
      label: 'Tryb wyszukiwania',
      desc: 'Algorytm przeszukiwania populacji tagów. Wpływa na to, czy czytnik przechodzi między stanami A i B tagów.',
      options: 'single-target — czyta tylko tagi w stanie A\ndual-target — czyta tagi w A, potem B, potem z powrotem A (zalecany)\nsingle-target-suppression — jak single-target ale z supresją duplikatów',
      recommended: 'dual-target — w połączeniu z sesją 2 zapewnia że każdy tag zostanie odczytany co najmniej raz na pełny cykl, minimalizując pominięcia.',
    },
    estimatedTagPopulation: {
      label: 'Szacowana populacja tagów',
      desc: 'Wskazówka dla algorytmu Q-Value: ile tagów spodziewasz się w zasięgu anteny jednocześnie. Zaniżona wartość spowalnia odczyty (za dużo kolizji), zawyżona marnuje czas.',
      options: 'Liczba całkowita ≥ 1',
      recommended: '32 dla typowych wyścigów (max ~20 zawodników w bramce jednocześnie). Zwiększ do 64–128 przy masowych startach. Zmniejsz do 8–16 przy pojedynczych zawodnikach (wynik dokładniejszy).',
    },
    rfMode: {
      label: 'RF Mode (DRMID)',
      desc: 'Tryb modulacji/kodowania RF definiowany przez Impinj. Każdy tryb to kombinacja szybkości transmisji Backscatter (BLF) i kodowania (Miller/FM0). R700 NIE obsługuje trybu 1000 (w razie potrzeby stosuj 1002).',
      options: '1002 – AutoSet Dense Reader Deep Scan (automatycznie cykluje przez kilka trybów)\n1003 – AutoSet Static Fast\n1004 – AutoSet Static Dense Reader\n1210 – statyczny tryb R700 (domyślny preset LeszyRun)\n1220 – statyczny tryb R700, większy zasięg',
      recommended: '1210 — domyślna wartość, sprawdzona na R700. Przy problemach z zasięgiem wypróbuj 1220. Unikaj AutoSet (1002–1004) przy bramkach — nieznana latencja utrudnia debugowanie.',
    },
  }

  const toggleTooltip = (field) => setTooltipField(prev => prev === field ? null : field)

  const [form, setForm] = useState({ mainIp: '', finishIp: '', mqttHost: '', readerUsername: 'root', readerPassword: '', mqttQos: 1, mqttTopicMain: 'leszyrun', mqttTopicFinish: 'leszyrun/finish' })
  const [showMqttHelp, setShowMqttHelp] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  useEffect(() => { if (config) setForm(config) }, [config])

  const { data: mainStatus, error: mainError } = useQuery({
    queryKey: ['reader-status', 'main'],
    queryFn: () => api.reader.status('main'),
    retry: false,
    refetchInterval: 10000,
    enabled: !!config?.mainIp,
  })
  const readerOnline = !config?.mainIp || (!mainError && !!mainStatus)

  const keys = ['mainIp', 'finishIp', 'mqttHost', 'readerUsername', 'readerPassword', 'mqttQos', 'mqttTopicMain', 'mqttTopicFinish']
  const isDirty = config ? keys.some(k => String(form[k] ?? '') !== String(config[k] ?? '')) : false

  const save = useMutation({
    mutationFn: () => api.reader.saveConfig(form),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['reader-config'] }),
  })

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  return (
    <Card>
      <CardHeader><CardTitle>Konfiguracja adresów</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-[1fr_1fr] gap-3">
          <label className="block">
            <span className="text-xs font-bold uppercase tracking-widest text-apex-muted mb-1 block">Adres czytnika głównego</span>
            <Input value={form.mainIp} onChange={e => set('mainIp', e.target.value)} placeholder="impinj-xx-xx-xx.local" />
            <p className="text-xs text-apex-muted mt-1">IP lub hostname, np. <code className="font-mono">192.168.1.100</code> albo <code className="font-mono">impinj-17-0a-30.local</code></p>
          </label>
          <label className="block">
            <span className="text-xs font-bold uppercase tracking-widest text-apex-muted mb-1 block">Adres czytnika mety</span>
            <Input value={form.finishIp} onChange={e => set('finishIp', e.target.value)} placeholder="impinj-xx-xx-xx.local" />
            <p className="text-xs text-apex-muted mt-1">Tylko przy dwóch osobnych czytnikach</p>
          </label>
        </div>
        <label className="block">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs font-bold uppercase tracking-widest text-apex-muted">Host MQTT</span>
            <button
              type="button"
              onClick={() => setShowMqttHelp(h => !h)}
              className="text-xs text-apex-muted hover:text-apex-muted underline"
            >
              {showMqttHelp ? 'ukryj' : 'jak znaleźć?'}
            </button>
          </div>
          <Input value={form.mqttHost} onChange={e => set('mqttHost', e.target.value)} placeholder="192.168.1.2" className="max-w-64" />
          <p className="text-xs text-apex-muted mt-1">IP twojego Maca na karcie sieciowej podłączonej do czytnika</p>
          {showMqttHelp && (
            <div className="mt-2 text-xs text-apex-muted border border-apex-border bg-apex-surface-2 px-3 py-2 space-y-2">
              <p>
                Wpisz tu IP Maca na tym interfejsie sieciowym, którym Mac jest połączony z czytnikiem.
                Nazwy interfejsów (<code>en0</code>, <code>en8</code>…) różnią się między Macami — znajdź
                właściwy w Terminalu:
              </p>
              <div>
                <p className="mb-0.5"><span className="text-apex-yellow font-bold">1.</span> Na którym interfejsie Mac widzi czytnik:</p>
                <p className="font-mono bg-apex-surface border border-apex-border px-2 py-1 select-all">arp -a | grep -i impinj</p>
                <p className="mt-0.5">Wynik np. <code>impinj-17-0a-30.local (169.254.1.1) … on <b>en8</b></code> — zapamiętaj nazwę po „on".
                  Brak wyniku? Otwórz najpierw stronę czytnika w przeglądarce (żeby Mac go „zobaczył") i spróbuj ponownie.</p>
              </div>
              <div>
                <p className="mb-0.5"><span className="text-apex-yellow font-bold">2.</span> Adresy IP Maca na wszystkich interfejsach:</p>
                <p className="font-mono bg-apex-surface border border-apex-border px-2 py-1 select-all">{"ifconfig -a | awk '/^[a-z]/{i=$1} /inet /{print i, $2}' | grep -v 127.0.0.1"}</p>
              </div>
              <div>
                <p><span className="text-apex-yellow font-bold">3.</span> Wpisz powyżej IP Maca z <b>tego samego interfejsu</b>, na którym widać czytnik
                  (np. czytnik on <code>en8</code> → weź IP przy <code>en8:</code>).</p>
              </div>
              <p>
                Przy bezpośrednim kablu (bez routera) oba adresy będą z zakresu <code>169.254.x.x</code> — to normalne.
                Uwaga: taki adres może się zmienić po restarcie Maca lub przepięciu kabla — jeśli czytnik przestanie
                łączyć się z MQTT, sprawdź to pole w pierwszej kolejności i wyślij konfigurację ponownie.
              </p>
            </div>
          )}
        </label>
        <div className="grid grid-cols-[1fr_1fr] gap-3">
          <label className="block">
            <span className="text-xs font-bold uppercase tracking-widest text-apex-muted mb-1 block">Login czytnika</span>
            <Input value={form.readerUsername} onChange={e => set('readerUsername', e.target.value)} placeholder="root" />
          </label>
          <label className="block">
            <span className="text-xs font-bold uppercase tracking-widest text-apex-muted mb-1 block">Hasło czytnika</span>
            <div className="relative">
              <Input type={showPassword ? 'text' : 'password'} value={form.readerPassword} onChange={e => set('readerPassword', e.target.value)} placeholder="(puste jeśli brak)" className="pr-8" />
              <button type="button" onClick={() => setShowPassword(v => !v)} className="absolute right-2 top-1/2 -translate-y-1/2 text-apex-muted hover:text-apex-muted">
                {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
          </label>
        </div>
        <p className="text-xs text-apex-muted">Dane logowania do REST API czytnika. Domyślnie: login <code className="font-mono">root</code>, hasło puste.</p>
        <div className="grid grid-cols-[1fr_1fr_1fr] gap-3 items-end">
          <label className="block">
            <span className="text-xs font-bold uppercase tracking-widest text-apex-muted mb-1 block">Temat MQTT (główny)</span>
            <Input value={form.mqttTopicMain} onChange={e => set('mqttTopicMain', e.target.value)} placeholder="leszyrun" />
          </label>
          {form.finishIp?.trim() ? (
            <label className="block">
              <span className="text-xs font-bold uppercase tracking-widest text-apex-muted mb-1 block">Temat MQTT (meta)</span>
              <Input value={form.mqttTopicFinish} onChange={e => set('mqttTopicFinish', e.target.value)} placeholder="leszyrun/finish" />
            </label>
          ) : <div />}
          <label className="block">
            <span className="text-xs font-bold uppercase tracking-widest text-apex-muted mb-1 block">QoS</span>
            <select
              value={form.mqttQos}
              onChange={e => set('mqttQos', parseInt(e.target.value, 10))}
              className="h-9 border border-apex-border-mid bg-apex-surface text-sm px-2 rounded-none w-full"
            >
              <option value={0}>0 – at most once</option>
              <option value={1}>1 – at least once</option>
              <option value={2}>2 – exactly once</option>
            </select>
          </label>
        </div>
        <Button onClick={() => save.mutate()} disabled={!isDirty || save.isPending} size="sm">
          {save.isPending ? 'Zapisywanie...' : 'Zapisz'}
        </Button>

        {presetForm?.length > 0 && (
          <div className="pt-3 border-t border-stone-100">
            <span className="text-xs font-bold uppercase tracking-widest text-apex-muted mb-2 block">Preset anten (wysyłany do czytnika)</span>
            <div className="border border-apex-border divide-y divide-apex-border">
              <div className="grid grid-cols-[3rem_1fr_1fr_1fr_1fr_1fr] gap-x-2 px-2 py-1 bg-apex-surface-2 text-xs font-bold uppercase tracking-widest text-apex-muted">
                <span>Port</span>
                {[
                  ['transmitPowerCdbm', 'Moc TX (dBm)'],
                  ['inventorySession', 'Sesja'],
                  ['inventorySearchMode', 'Tryb wyszukiwania'],
                  ['estimatedTagPopulation', 'Populacja'],
                  ['rfMode', 'RF Mode'],
                ].map(([field, label]) => (
                  <button
                    key={field}
                    type="button"
                    onClick={() => toggleTooltip(field)}
                    className={`flex items-center gap-1 text-left hover:text-apex-muted transition-colors ${tooltipField === field ? 'text-apex-yellow' : ''}`}
                  >
                    {label}
                    <Info size={11} className="shrink-0" />
                  </button>
                ))}
              </div>
              {tooltipField && FIELD_INFO[tooltipField] && (
                <div className="px-3 py-2.5 bg-apex-surface-2 border-b border-apex-border text-xs space-y-1.5">
                  <div className="font-semibold text-apex-text">{FIELD_INFO[tooltipField].label}</div>
                  <div className="text-apex-muted">{FIELD_INFO[tooltipField].desc}</div>
                  <div>
                    <span className="font-semibold text-apex-muted uppercase tracking-wide text-[10px]">Opcje: </span>
                    <span className="text-apex-muted whitespace-pre-line">{FIELD_INFO[tooltipField].options}</span>
                  </div>
                  <div>
                    <span className="font-semibold text-apex-yellow uppercase tracking-wide text-[10px]">Zalecane: </span>
                    <span className="text-apex-muted">{FIELD_INFO[tooltipField].recommended}</span>
                  </div>
                </div>
              )}
              {presetForm.map(a => (
                <div key={a.antennaPort} className="grid grid-cols-[3rem_1fr_1fr_1fr_1fr_1fr] gap-x-2 px-2 py-1.5 items-center text-xs">
                  <span className="font-semibold text-apex-muted">{a.antennaPort}</span>
                  <input
                    type="number" step="0.1" min="10" max="33"
                    value={(a.transmitPowerCdbm / 100).toFixed(1)}
                    onChange={e => setAntennaField(a.antennaPort, 'transmitPowerCdbm', e.target.value)}
                    className="w-full border border-apex-border px-1.5 py-1 font-mono text-xs rounded-none focus:outline-none focus:border-stone-400"
                  />
                  <select
                    value={a.inventorySession}
                    onChange={e => setAntennaField(a.antennaPort, 'inventorySession', e.target.value)}
                    className="w-full border border-apex-border px-1 py-1 text-xs rounded-none focus:outline-none focus:border-stone-400 bg-apex-surface"
                  >
                    {[0, 1, 2, 3].map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                  <select
                    value={a.inventorySearchMode}
                    onChange={e => setAntennaField(a.antennaPort, 'inventorySearchMode', e.target.value)}
                    className="w-full border border-apex-border px-1 py-1 text-xs rounded-none focus:outline-none focus:border-stone-400 bg-apex-surface"
                  >
                    <option value="single-target">single-target</option>
                    <option value="dual-target">dual-target</option>
                    <option value="single-target-with-suppression">single-target-suppression</option>
                  </select>
                  <input
                    type="number" min="1"
                    value={a.estimatedTagPopulation}
                    onChange={e => setAntennaField(a.antennaPort, 'estimatedTagPopulation', e.target.value)}
                    className="w-full border border-apex-border px-1.5 py-1 font-mono text-xs rounded-none focus:outline-none focus:border-stone-400"
                  />
                  <input
                    type="number" min="1"
                    value={a.rfMode}
                    onChange={e => setAntennaField(a.antennaPort, 'rfMode', e.target.value)}
                    className="w-full border border-apex-border px-1.5 py-1 font-mono text-xs rounded-none focus:outline-none focus:border-stone-400"
                  />
                </div>
              ))}
            </div>
            <div className="flex items-center gap-3 mt-2">
              {readerOnline ? (
                <Button size="sm" onClick={() => savePreset.mutate()} disabled={!isPresetDirty || savePreset.isPending}>
                  {savePreset.isPending ? 'Zapisywanie...' : 'Zapisz preset'}
                </Button>
              ) : (
                <p className="text-xs text-apex-red">Czytnik niedostępny — zapis wyłączony.</p>
              )}
              <p className="text-xs text-apex-muted">Używany przy „Konfiguruj MQTT + Preset" i „Uruchom skanowanie".</p>
            </div>
            {savePreset.isSuccess && <p className="text-xs text-apex-yellow mt-1">Preset zapisany.</p>}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

const rssiQuality = (rssi) => Math.max(0, Math.min(100, Math.round((rssi + 5000) / 5000 * 100)))

function formatUptime(seconds) {
  if (seconds == null) return '—'
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

const DIAG_ACCENT = {
  green: 'border-apex-yellow/30 bg-apex-yellow/5 text-apex-yellow',
  amber: 'border-amber-400/40 bg-amber-50 text-amber-700',
  red: 'border-terrain-burgundy/40 bg-apex-surface text-apex-red',
  neutral: 'border-apex-border bg-apex-surface-2 text-apex-muted',
}

function DiagTile({ label, value, sub, accent = 'neutral', mono = false, tooltip }) {
  const [open, setOpen] = useState(false)
  return (
    <div className={`border px-2.5 py-2 ${DIAG_ACCENT[accent]}`}>
      <div className="flex items-center justify-between mb-0.5">
        <div className="text-xs text-apex-muted uppercase tracking-wider">{label}</div>
        {tooltip && (
          <button
            type="button"
            onClick={() => setOpen(v => !v)}
            className="text-apex-muted hover:text-apex-muted ml-1 shrink-0"
          >
            <Info size={11} />
          </button>
        )}
      </div>
      <div className={`text-sm font-semibold leading-tight ${mono ? 'font-mono' : ''}`}>{value}</div>
      {sub && <div className="text-xs text-apex-muted mt-0.5">{sub}</div>}
      {open && tooltip && (
        <div className="mt-1.5 pt-1.5 border-t border-apex-border space-y-0.5">
          {tooltip.split('\n').map((line, i) => (
            <div key={i} className="text-xs text-apex-muted leading-snug">{line}</div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Per-reader management panel ─────────────────────────────────────────────

function ReaderPanel({ role, label }) {
  const qc = useQueryClient()

  const { data: config } = useQuery({ queryKey: ['reader-config'], queryFn: () => api.reader.getConfig() })
  const ip = role === 'finish' ? config?.finishIp : config?.mainIp
  const hasIp = !!ip

  const { data: status, error: statusError, isFetching: statusFetching, refetch: refetchStatus } = useQuery({
    queryKey: ['reader-status', role],
    queryFn: () => api.reader.status(role),
    enabled: hasIp,
    refetchInterval: 8000,
    retry: false,
  })

  const { data: antennas, refetch: refetchAntennas } = useQuery({
    queryKey: ['reader-antennas', role],
    queryFn: () => api.reader.antennas(role),
    enabled: hasIp,
    refetchInterval: 30000,
    retry: false,
  })

  const configure = useMutation({
    mutationFn: () => api.reader.configure(role),
    onSuccess: () => { refetchStatus(); refetchAntennas() },
  })
  const start = useMutation({
    mutationFn: () => api.reader.start(role),
    onSuccess: () => setTimeout(() => refetchStatus(), 1500),
  })
  const stop = useMutation({
    mutationFn: () => api.reader.stop(role),
    onSuccess: () => setTimeout(() => refetchStatus(), 1500),
  })

  // Backend ↔ broker state — distinguishes "Mosquitto is down" from
  // "broker is up but this reader can't reach it" in the warning below
  const { data: brokerStatus } = useQuery({
    queryKey: ['rfid-status'],
    queryFn: () => api.rfid.status(),
    refetchInterval: 10000,
  })
  const brokerDown = brokerStatus?.connected === false

  const reachable = hasIp && !statusError
  const inventoryRunning = status?.status === 'running' || status?.status === 'starting'
  const anyPending = configure.isPending || start.isPending || stop.isPending
  const antList = antennas?.antennaStates ?? null

  // ── Live scanning diagnostics ──────────────────────────────────────────────
  const myTopic = role === 'finish' ? (config?.mqttTopicFinish || 'leszyrun/finish') : (config?.mqttTopicMain || 'leszyrun')
  const scanStartRef = useRef(null)
  const [scanStats, setScanStats] = useState(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (inventoryRunning && !scanStartRef.current) {
      scanStartRef.current = Date.now()
      setScanStats({ total: 0, perPort: {}, lastEpc: null, lastReadAt: null })
    } else if (!inventoryRunning) {
      scanStartRef.current = null
      setScanStats(null)
    }
  }, [inventoryRunning])

  // 1-second tick for live time display (reads/sec, "X s temu")
  useEffect(() => {
    if (!inventoryRunning) return
    const id = setInterval(() => setTick(t => t + 1), 1000)
    return () => clearInterval(id)
  }, [inventoryRunning])

  useWsEvent('rfid:raw', useCallback((payload) => {
    if (!payload.topic?.startsWith(myTopic)) return
    setScanStats(prev => {
      if (!prev) return prev
      const port = payload.antennaPort
      const cur = prev.perPort[port]
      const now = Date.now()
      return {
        total: prev.total + 1,
        lastEpc: payload.epc,
        lastReadAt: now,
        perPort: {
          ...prev.perPort,
          [port]: {
            count: (cur?.count || 0) + 1,
            peakRssi: cur ? Math.max(cur.peakRssi, payload.rssi) : payload.rssi,
            lastRssi: payload.rssi,
            lastSeenAt: now,
          },
        },
      }
    })
  }, [myTopic]))

  const elapsed = scanStartRef.current ? (Date.now() - scanStartRef.current) / 1000 : 1
  const readsPerSec = scanStats ? (scanStats.total / Math.max(elapsed, 1)).toFixed(1) : '0'
  const secAgo = scanStats?.lastReadAt ? Math.round((Date.now() - scanStats.lastReadAt) / 1000) : null

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>{label}</CardTitle>
          <div className="flex items-center gap-1.5 text-xs text-apex-muted">
            {hasIp && (
              <button onClick={() => { refetchStatus(); refetchAntennas() }} className="hover:text-apex-muted">
                <RefreshCw size={12} className={statusFetching ? 'animate-spin' : ''} />
              </button>
            )}
            {hasIp && (
              <a
                href={`http://${ip}`}
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono text-apex-muted hover:text-apex-yellow underline underline-offset-2"
              >{ip}</a>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {!hasIp ? (
          <div className="space-y-1 text-sm text-apex-muted">
            <p>IP czytnika niezskonfigurowane — wpisz adres powyżej.</p>
            <p>Jeśli nie znasz IP, spróbuj otworzyć UI czytnika bezpośrednio:{' '}
              <a href="https://impinj-17-0a-30.local/ui" target="_blank" rel="noopener noreferrer" className="font-mono text-apex-yellow hover:underline underline-offset-2">impinj-17-0a-30.local/ui</a>
              {' '}— login: <span className="font-mono">root</span> / hasło: <span className="font-mono">impinj</span> (lub własne jeśli zmienione).
            </p>
          </div>
        ) : (
          <>
            {/* Reader status row */}
            <div className="flex items-center gap-3 text-sm flex-wrap">
              <div className="flex items-center gap-1.5">
                {reachable
                  ? <Wifi size={14} className="text-apex-yellow" />
                  : <WifiOff size={14} className="text-apex-red" />}
                <span className={reachable ? 'text-apex-yellow font-medium' : 'text-apex-red font-medium'}>
                  {statusError ? 'Niedostępny' : status ? 'Dostępny' : 'Sprawdzanie...'}
                </span>
              </div>
              {status?.mqttBrokerConnectionStatus && (
                <span className={`text-xs font-semibold px-1.5 py-0.5 border ${status.mqttBrokerConnectionStatus === 'connected' ? 'border-apex-yellow/40 text-apex-yellow' : 'border-apex-red bg-apex-red/10 text-apex-red'}`}>
                  MQTT {status.mqttBrokerConnectionStatus}
                </span>
              )}
              {status?.firmwareVersion && (
                <span className="text-apex-muted text-xs font-mono">fw {status.firmwareVersion}</span>
              )}
              {status && (
                <span className={`text-xs font-semibold px-2 py-0.5 border ${inventoryRunning ? 'border-apex-yellow text-apex-yellow' : 'border-apex-border-mid text-apex-muted'}`}>
                  {inventoryRunning ? '● Skanowanie aktywne' : 'Skanowanie zatrzymane'}
                </span>
              )}
            </div>

            {/* Reader ↔ broker disconnected — loud warning, not a muted badge */}
            {reachable && status?.mqttBrokerConnectionStatus && status.mqttBrokerConnectionStatus !== 'connected' && (
              <div className="border-2 border-apex-red bg-apex-red/10 px-3 py-2.5 space-y-1">
                <p className="text-xs font-bold uppercase tracking-widest text-apex-red">Czytnik nie jest połączony z brokerem MQTT</p>
                <p className="text-xs text-apex-muted">
                  {brokerDown
                    ? 'Czytnik odpowiada, ale broker Mosquitto na Macu nie działa (szczegóły i komenda startu w czerwonym banerze u góry strony). Po uruchomieniu brokera czytnik połączy się sam.'
                    : 'Czytnik odpowiada i broker Mosquitto działa, ale czytnik się z nim nie łączy. Sprawdź pole „Host MQTT" w konfiguracji adresów (musi to być IP Maca widoczne z czytnika), a następnie wyślij konfigurację przyciskiem „Konfiguruj MQTT + Preset" poniżej.'}
                </p>
              </div>
            )}

            {/* Hardware diagnostics */}
            {status && (status.temperatureCelsius !== null || status.uptimeSeconds !== null || status.allocatedPowerMilliwatts !== null) && (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {status.temperatureCelsius !== null && (
                  <DiagTile
                    label="Temperatura"
                    value={`${status.temperatureCelsius}°C`}
                    accent={status.temperatureCelsius > 65 ? 'red' : status.temperatureCelsius > 50 ? 'amber' : 'green'}
                    tooltip={"Zielony: ≤50°C (normalna)\nŻółty: 51–65°C (ciepło, obserwuj)\nCzerwony: >65°C (za gorąco, może ograniczać moc TX)"}
                  />
                )}
                {status.uptimeSeconds !== null && (
                  <DiagTile label="Uptime" value={formatUptime(status.uptimeSeconds)} accent="neutral" />
                )}
                {status.allocatedPowerMilliwatts !== null && (() => {
                  const mw = status.allocatedPowerMilliwatts
                  const src = status.powerSource
                  const accent = src === 'dc' || mw >= 25000 ? 'green' : mw >= 15400 ? 'amber' : 'red'
                  const sub = src === 'dc' ? 'DC · pełna moc'
                    : mw >= 25000 ? 'PoE+ · pełna moc'
                    : mw >= 15400 ? 'PoE · ogranicz. zasięg!'
                    : 'za mało mocy!'
                  return (
                    <DiagTile
                      label="Zasilanie"
                      value={`${(mw / 1000).toFixed(1)} W`}
                      sub={sub}
                      accent={accent}
                      tooltip={"Zielony: ≥25W / DC — pełna moc TX, maksymalny zasięg\nŻółty: 15.4–25W — standard PoE, ograniczona moc TX, krótszy zasięg\nCzerwony: <15.4W — niewystarczające zasilanie, poważna utrata zasięgu"}
                    />
                  )
                })()}
              </div>
            )}

            {/* Live scanning diagnostics */}
            {inventoryRunning && scanStats !== null && (
              <div className="border border-apex-yellow/30 bg-apex-yellow/5 p-3 space-y-3">
                <div className="flex items-center gap-4 flex-wrap">
                  <span className="text-xs font-bold uppercase tracking-widest text-apex-yellow">Live</span>
                  <span className="text-sm font-mono font-semibold text-apex-muted">{scanStats.total.toLocaleString()}</span>
                  <span className="text-xs text-apex-muted">odczytów</span>
                  <span className="text-sm font-mono text-apex-muted">{readsPerSec}/s</span>
                  {secAgo !== null && (
                    <span className="text-xs text-apex-muted">{secAgo === 0 ? 'właśnie teraz' : `${secAgo}s temu`}</span>
                  )}
                  {secAgo === null && <span className="text-xs text-apex-muted animate-pulse">oczekiwanie…</span>}
                </div>
                {scanStats.lastEpc && (
                  <div className="text-xs font-mono text-apex-muted truncate">
                    <span className="text-apex-muted mr-1">EPC:</span>{scanStats.lastEpc}
                  </div>
                )}
                {Object.keys(scanStats.perPort).length > 0 ? (
                  <div className="space-y-1.5">
                    {Object.entries(scanStats.perPort)
                      .sort(([a], [b]) => Number(a) - Number(b))
                      .map(([port, info]) => {
                        const staleMs = Date.now() - (info.lastSeenAt || 0)
                        const stale = staleMs > 3000
                        const displayRssi = stale ? -9000 : info.lastRssi
                        const q = rssiQuality(displayRssi)
                        return (
                          <div key={port} className={`flex items-center gap-3 text-xs ${stale ? 'opacity-40' : ''}`}>
                            <span className="font-mono text-apex-muted w-12">Port {port}</span>
                            <div className="w-24 bg-apex-surface border border-apex-border h-2">
                              <div
                                className={`h-full transition-all duration-500 ${q > 60 ? 'bg-apex-yellow' : q > 30 ? 'bg-amber-500' : 'bg-apex-red'}`}
                                style={{ width: `${q}%` }}
                              />
                            </div>
                            <span className="text-apex-muted font-mono w-16">{stale ? '—' : `${(info.lastRssi / 100).toFixed(0)} dBm`}</span>
                            <span className="text-apex-muted">{info.count.toLocaleString()} odcz.</span>
                          </div>
                        )
                      })}
                  </div>
                ) : (
                  <p className="text-xs text-apex-muted animate-pulse">Oczekiwanie na odczyty RFID…</p>
                )}
              </div>
            )}

            {/* Antenna hub — only show when not scanning (less noise) */}
            {!inventoryRunning && antennas && antList?.length > 0 && (
              <div>
                <span className="text-xs font-bold uppercase tracking-widest text-apex-muted block mb-1">Hub anten</span>
                <div className="space-y-1.5">
                  {antList.map((ant, i) => {
                    const port = ant.antennaPort ?? ant.port ?? i + 1
                    const connected = ant.connected ?? ant.isConnected ?? true
                    return (
                      <div key={port} className="flex items-center gap-3 text-xs">
                        <span className="font-mono text-apex-muted w-12">Port {port}</span>
                        <span className={`w-2 h-2 rounded-full shrink-0 ${connected ? 'bg-apex-yellow' : 'bg-stone-300'}`} />
                        <span className={connected ? 'text-apex-muted' : 'text-apex-muted'}>{connected ? 'Podłączona' : 'Niepodłączona'}</span>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            {/* Error feedback */}
            {(configure.isError || start.isError || stop.isError) && (
              <p className="text-xs text-apex-red border border-terrain-burgundy px-2 py-1">
                {(configure.error || start.error || stop.error)?.message}
              </p>
            )}

            {/* Action buttons */}
            <div className="flex gap-2 flex-wrap pt-1 border-t border-stone-100">
              <Button
                size="sm"
                variant="outline"
                onClick={() => configure.mutate()}
                disabled={anyPending || inventoryRunning || !reachable}
                title={!reachable ? 'Czytnik niedostępny' : inventoryRunning ? 'Zatrzymaj skanowanie przed konfiguracją' : 'Wyślij konfigurację MQTT i preset do czytnika'}
              >
                <Settings size={13} />
                {configure.isPending ? 'Konfigurowanie...' : 'Konfiguruj MQTT + Preset'}
              </Button>
              <Button
                size="sm"
                onClick={() => start.mutate()}
                disabled={anyPending || inventoryRunning || !reachable}
              >
                <Play size={13} />
                {start.isPending ? 'Uruchamianie...' : 'Uruchom skanowanie'}
              </Button>
              <Button
                size="sm"
                variant="destructive"
                onClick={() => stop.mutate()}
                disabled={anyPending || !inventoryRunning}
              >
                <Square size={13} />
                {stop.isPending ? 'Zatrzymywanie...' : 'Zatrzymaj'}
              </Button>
            </div>

            {configure.isSuccess && (
              <p className="text-xs text-apex-yellow">Preset i konfiguracja MQTT wysłane. Czytnik powinien połączyć się z brokerem.</p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}
