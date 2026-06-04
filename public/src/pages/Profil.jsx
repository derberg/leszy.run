import { useState, useEffect } from 'react'
import AuthGuard from '../components/AuthGuard.jsx'
import Navbar from '../components/Navbar.jsx'
import Footer from '../components/Footer.jsx'
import useAuth from '../hooks/useAuth.js'
import { callFunction } from '../lib/auth.js'
import useSeo from '../hooks/useSeo.js'
import ClubInput from '../components/ClubInput.jsx'
import useFavorites from '../hooks/useFavorites.js'
import useNotifications from '../hooks/useNotifications.js'
import StarButton from '../components/StarButton.jsx'
import { slugify } from '../lib/slugify.js'

const inputClass = 'flex-1 min-w-0 bg-apex-surface border border-apex-border text-apex-text-bright font-sans text-sm font-medium py-1.5 px-2.5 outline-none focus:border-apex-yellow-dim transition-colors'
const sectionTitle = 'font-display font-bold text-[10px] tracking-widest uppercase text-apex-muted border-b border-apex-border pb-1 mb-3'
const actionBtnClass = 'font-mono text-xs px-2 py-1.5 border transition-all leading-none'

function PencilIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
    </svg>
  )
}

// Parse stored E.164 (+48xxxxxxxxx) into local digits.
// Tolerates legacy values without country code.
function parsePhone(stored) {
  if (!stored) return ''
  const digits = stored.replace(/\D/g, '')
  if (digits.startsWith('48') && digits.length === 11) return digits.slice(2)
  if (stored.startsWith('+48')) return stored.slice(3).replace(/\D/g, '')
  return digits.length === 9 ? digits : digits
}

// Strip everything not a digit; remove leading 48 / +48 / 0048 that user might type.
function normalizePhoneDigits(input) {
  let s = (input || '').replace(/[\s\-()]/g, '')
  if (s.startsWith('+48')) s = s.slice(3)
  else if (s.startsWith('0048')) s = s.slice(4)
  else if (s.startsWith('48') && s.length > 9) s = s.slice(2)
  return s.replace(/\D/g, '').slice(0, 9)
}

function formatPhoneDisplay(stored) {
  const d = parsePhone(stored)
  if (d.length !== 9) return stored || ''
  return `+48 ${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6, 9)}`
}

function EditablePhoneField({ value, onSave }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(parsePhone(value))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  async function save() {
    const digits = normalizePhoneDigits(draft)
    if (digits === '') {
      setSaving(true)
      await onSave('phone', null)
      setSaving(false)
      setEditing(false)
      return
    }
    if (digits.length !== 9) {
      setError('Numer musi mieć 9 cyfr (bez +48).')
      return
    }
    setError(null)
    setSaving(true)
    await onSave('phone', `+48${digits}`)
    setSaving(false)
    setEditing(false)
  }

  if (editing) {
    return (
      <div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 bg-apex-surface border border-apex-border px-2 py-1.5 text-sm font-mono text-apex-muted shrink-0" title="Obecnie wspieramy tylko numery polskie">
            +48
          </div>
          <input
            data-testid="input-phone"
            type="tel"
            inputMode="numeric"
            value={draft}
            onChange={e => { setDraft(e.target.value); setError(null) }}
            placeholder="123 456 789"
            className={inputClass}
            autoFocus
          />
          <button
            data-testid="save-phone"
            onClick={save}
            disabled={saving}
            className={`${actionBtnClass} border-apex-yellow text-apex-yellow hover:bg-apex-yellow hover:text-apex-ink`}
          >
            OK
          </button>
          <button onClick={() => { setEditing(false); setError(null) }} className={`${actionBtnClass} border-apex-border text-apex-muted hover:text-apex-text-bright hover:border-apex-border`}>✕</button>
        </div>
        {error && <p className="text-apex-red font-mono text-[10px] mt-1">{error}</p>}
        <p className="text-apex-muted font-mono text-[9px] mt-1">Wspieramy tylko numery polskie. Numer wykorzystamy do powiadomień SMS o wydarzeniach.</p>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-2 group">
      <span className="font-sans text-sm text-apex-text">
        {value ? formatPhoneDisplay(value) : <span className="text-apex-muted italic">nie ustawiono</span>}
      </span>
      <button
        data-testid="edit-phone"
        onClick={() => { setDraft(parsePhone(value)); setError(null); setEditing(true) }}
        aria-label="Edytuj telefon"
        title="Edytuj"
        className="p-1 text-apex-muted md:opacity-0 md:group-hover:opacity-100 hover:text-apex-yellow transition-all"
      >
        <PencilIcon />
      </button>
    </div>
  )
}

const VOIVODESHIP_OPTIONS = [
  'Dolnośląskie', 'Kujawsko-Pomorskie', 'Łódzkie', 'Lubelskie', 'Lubuskie',
  'Małopolskie', 'Mazowieckie', 'Opolskie', 'Podkarpackie', 'Podlaskie',
  'Pomorskie', 'Śląskie', 'Świętokrzyskie', 'Warmińsko-Mazurskie',
  'Wielkopolskie', 'Zachodniopomorskie',
]

const GENDER_LABELS = { M: 'Mężczyzna', F: 'Kobieta', X: 'Inna' }

function EditableField({ fieldKey, value, onSave, type = 'text', options, displayValue }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value ?? '')
  const [saving, setSaving] = useState(false)

  async function save() {
    setSaving(true)
    await onSave(fieldKey, draft === '' ? null : draft)
    setSaving(false)
    setEditing(false)
  }

  if (editing) {
    return (
      <div className="flex items-center gap-2">
        {options ? (
          <select
            data-testid={`input-${fieldKey}`}
            value={draft}
            onChange={e => setDraft(e.target.value)}
            className={`${inputClass} appearance-none cursor-pointer`}
            autoFocus
          >
            <option value="">— nie ustawiono —</option>
            {options.map(o => (
              <option key={o.value ?? o} value={o.value ?? o}>{o.label ?? o}</option>
            ))}
          </select>
        ) : (
          <input
            data-testid={`input-${fieldKey}`}
            type={type}
            value={draft}
            onChange={e => setDraft(e.target.value)}
            className={inputClass}
            autoFocus
          />
        )}
        <button
          data-testid={`save-${fieldKey}`}
          onClick={save}
          disabled={saving}
          className={`${actionBtnClass} border-apex-yellow text-apex-yellow hover:bg-apex-yellow hover:text-apex-ink`}
        >
          OK
        </button>
        <button
          onClick={() => setEditing(false)}
          className={`${actionBtnClass} border-apex-border text-apex-muted hover:text-apex-text-bright hover:border-apex-border`}
        >
          ✕
        </button>
      </div>
    )
  }

  const shown = displayValue !== undefined ? displayValue : value

  return (
    <div className="flex items-center gap-2 group">
      <span className="font-sans text-sm text-apex-text">
        {shown || <span className="text-apex-muted italic">nie ustawiono</span>}
      </span>
      <button
        data-testid={`edit-${fieldKey}`}
        onClick={() => { setDraft(value ?? ''); setEditing(true) }}
        aria-label="Edytuj"
        title="Edytuj"
        className="p-1 text-apex-muted md:opacity-0 md:group-hover:opacity-100 hover:text-apex-yellow transition-all"
      >
        <PencilIcon />
      </button>
    </div>
  )
}

function EditableClubField({ value, onSaveClub }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState({ name: value || '', clubId: null })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  async function save() {
    setSaving(true)
    setError(null)
    try {
      await onSaveClub(draft)
      setEditing(false)
    } catch {
      setError('Nie udało się zapisać klubu.')
    } finally {
      setSaving(false)
    }
  }

  if (editing) {
    return (
      <>
        <div className="flex items-center gap-2">
          <div className="flex-1 min-w-0">
            <ClubInput value={draft} onChange={setDraft} inputClass={inputClass} inputId="club-edit" testId="input-club" />
          </div>
          <button
            data-testid="save-club"
            onClick={save}
            disabled={saving}
            className={`${actionBtnClass} border-apex-yellow text-apex-yellow hover:bg-apex-yellow hover:text-apex-ink`}
          >
            OK
          </button>
          <button onClick={() => { setEditing(false); setError(null) }} className={`${actionBtnClass} border-apex-border text-apex-muted hover:text-apex-text-bright hover:border-apex-border`}>✕</button>
        </div>
        {error && <p className="text-apex-red font-sans text-xs mt-1">{error}</p>}
      </>
    )
  }

  return (
    <div className="flex items-center gap-2 group">
      <span className="font-sans text-sm text-apex-text">
        {value || <span className="text-apex-muted italic">nie ustawiono</span>}
      </span>
      <button
        data-testid="edit-club"
        onClick={() => { setDraft({ name: value || '', clubId: null }); setError(null); setEditing(true) }}
        aria-label="Edytuj klub"
        title="Edytuj"
        className="p-1 text-apex-muted md:opacity-0 md:group-hover:opacity-100 hover:text-apex-yellow transition-all"
      >
        <PencilIcon />
      </button>
    </div>
  )
}

function DangerZone() {
  const [busy, setBusy] = useState(false)
  const [step, setStep] = useState('idle') // 'idle' | 'confirm' | 'otp'
  const [code, setCode] = useState('')
  const [error, setError] = useState(null)

  const apiUrl = import.meta.env.VITE_SUPABASE_URL

  async function downloadData() {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`${apiUrl}/functions/v1/export-my-data`, {
        method: 'POST',
        credentials: 'include',
      })
      if (!res.ok) throw new Error('Eksport nie powiódł się')
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = res.headers.get('content-disposition')?.match(/filename="([^"]+)"/)?.[1] || 'moje-dane.json'
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  async function requestOtp() {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`${apiUrl}/functions/v1/delete-my-account`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'request' }),
      })
      if (!res.ok) throw new Error('Nie udało się wysłać kodu')
      setStep('otp')
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  async function confirmDelete() {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`${apiUrl}/functions/v1/delete-my-account`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'confirm', code }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || 'Niepoprawny kod')
      }
      window.location.href = '/'
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="mt-10 border-t border-apex-border pt-8">
      <h2 className="font-display text-xl uppercase text-apex-text-bright">Twoje dane</h2>
      <div className="mt-4 space-y-3">
        <button
          onClick={downloadData}
          disabled={busy}
          className="border border-apex-border px-4 py-2 text-sm hover:border-apex-yellow hover:text-apex-yellow disabled:opacity-50"
        >
          Pobierz moje dane (JSON)
        </button>

        {step === 'idle' && (
          <button
            onClick={() => setStep('confirm')}
            className="block border border-apex-red px-4 py-2 text-sm text-apex-red hover:bg-apex-red hover:text-apex-ink"
          >
            Usuń konto
          </button>
        )}

        {step === 'confirm' && (
          <div className="border border-apex-red p-4">
            <h3 className="font-display uppercase text-apex-red">Co się stanie po usunięciu konta?</h3>
            <ul className="mt-3 list-disc space-y-1 pl-5 text-sm">
              <li>Twój profil zostanie usunięty, a wszystkie dane osobowe (imię, telefon, data urodzenia, lokalizacja) wymazane.</li>
              <li>Twoje wyniki w archiwach biegów pozostaną widoczne, ale podpisane jako <strong>Uczestnik anonimowy</strong>.</li>
              <li><strong>Tego adresu email nie da się już ponownie wykorzystać do rejestracji w Leszy.run</strong> — to celowe, by usunięcie było ostateczne.</li>
              <li>Tej operacji nie da się cofnąć. Aby potwierdzić, wyślemy Ci kod OTP na email.</li>
            </ul>
            <div className="mt-4 flex gap-2">
              <button onClick={() => setStep('idle')} className="border border-apex-border px-4 py-1.5 text-sm">Anuluj</button>
              <button onClick={requestOtp} disabled={busy} className="border border-apex-red bg-apex-red px-4 py-1.5 text-sm text-apex-ink hover:bg-apex-red disabled:opacity-50">Wyślij kod OTP</button>
            </div>
          </div>
        )}

        {step === 'otp' && (
          <div className="border border-apex-red p-4">
            <p className="text-sm">Wysłaliśmy kod OTP na Twój email. Wpisz go poniżej, aby potwierdzić usunięcie konta.</p>
            <input
              type="text"
              value={code}
              onChange={e => setCode(e.target.value)}
              maxLength={6}
              className="mt-3 w-32 border border-apex-border bg-apex-bg px-3 py-1.5 font-mono"
              placeholder="000000"
            />
            <div className="mt-4 flex gap-2">
              <button onClick={() => { setStep('idle'); setCode('') }} className="border border-apex-border px-4 py-1.5 text-sm">Anuluj</button>
              <button onClick={confirmDelete} disabled={busy || code.length !== 6} className="border border-apex-red bg-apex-red px-4 py-1.5 text-sm text-apex-ink disabled:opacity-50">Potwierdź usunięcie</button>
            </div>
          </div>
        )}

        {error && <p className="text-sm text-apex-red">{error}</p>}
      </div>
    </section>
  )
}

function StatusBadge({ status }) {
  if (status === 'accepted') {
    return <span className="px-1.5 py-0.5 text-[9px] font-mono border border-green-800 text-green-400 bg-green-950/30">OK</span>
  }
  if (status === 'rejected') {
    return <span className="px-1.5 py-0.5 text-[9px] font-mono border border-red-900 text-apex-red bg-red-950/30">odrzucone</span>
  }
  return <span className="px-1.5 py-0.5 text-[9px] font-mono border border-apex-yellow-dim text-apex-yellow">oczekuje</span>
}

function ProfilContent() {
  useSeo({ title: 'Mój profil — Leszy.run', path: '/profil', noindex: true })

  const { user } = useAuth()
  const { starredEvents } = useFavorites()
  const { notifications } = useNotifications({ markSeen: true })
  const [profile, setProfile] = useState(null)
  const [badges, setBadges] = useState([])
  const [reports, setReports] = useState([])
  const [submissions, setSubmissions] = useState([])
  const [filter, setFilter] = useState('all')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!user) return
    callFunction('get-profile-data', {}).then(({ profile, badges, reports, submissions }) => {
      setProfile(profile)
      setBadges(badges)
      setReports(reports)
      setSubmissions(submissions)
      setLoading(false)
    })
  }, [user])

  async function handleSave(field, value) {
    try {
      const updated = await callFunction('update-profile', { [field]: value })
      setProfile(updated.data)
    } catch (err) {
      console.error('Profile update failed:', err)
    }
  }

  async function handleClubSave(draft) {
    try {
      const payload = draft.clubId
        ? { club_id: draft.clubId }
        : { club: draft.name.trim() }   // empty string clears
      const updated = await callFunction('update-profile', payload)
      setProfile(updated.data)
    } catch (err) {
      console.error('Club update failed:', err)
      throw err
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <span className="font-mono text-sm text-apex-muted animate-pulse">Ładowanie…</span>
      </div>
    )
  }

  const allContribs = [
    ...reports.map(r => ({ ...r, contribType: 'raport', name: `Raport: ${r.field || 'ogólny'}` })),
    ...submissions.map(s => ({ ...s, contribType: 'nowe wydarzenie', status: s.status === 'active' ? 'accepted' : s.status })),
  ].sort((a, b) => new Date(b.created_at) - new Date(a.created_at))

  const filtered = filter === 'all' ? allContribs : allContribs.filter(c => c.status === filter)

  return (
    <div className="min-h-screen bg-apex-bg text-apex-text">
      <Navbar />
      <main data-testid="profil-page" className="pt-20 pb-16 px-4 md:px-8 max-w-5xl mx-auto">
        <div className="flex flex-col md:flex-row gap-6 md:gap-8">
          {/* Sidebar */}
          <aside className="w-full md:w-52 md:flex-shrink-0">
            <div className="flex flex-col items-center gap-3 mb-6">
              <div className="w-14 h-14 bg-apex-surface border-2 border-apex-yellow flex items-center justify-center font-display font-bold text-xl text-apex-yellow">
                {profile?.username?.[0]?.toUpperCase() || '?'}
              </div>
              <div className="font-display font-bold text-sm text-apex-yellow">@{profile?.username}</div>
              {profile?.club && (
                <div className="text-[9px] font-mono text-apex-muted border border-apex-border px-2 py-0.5 text-center">{profile.club}</div>
              )}
            </div>

            {badges.length > 0 && (
              <div className="mb-6">
                <div className={sectionTitle}>Odznaki</div>
                <div className="flex flex-wrap gap-1">
                  {badges.map(b => {
                    const def = b.badge_definitions
                    const label = profile?.gender === 'F' && def?.name_female ? def.name_female : def?.name
                    return (
                      <span key={b.id} title={def?.description} className="text-[10px] font-mono border border-apex-border px-1.5 py-0.5 text-apex-yellow">
                        {def?.icon} {label}
                      </span>
                    )
                  })}
                </div>
              </div>
            )}

            <div className="mb-6">
              <div className={sectionTitle}>Moje dane</div>
              <div className="space-y-3">
                <div>
                  <div className="text-[9px] font-mono text-apex-muted mb-0.5">Imię i nazwisko</div>
                  <EditableField fieldKey="display_name" value={profile?.display_name} onSave={handleSave} />
                </div>
                <div>
                  <div className="text-[9px] font-mono text-apex-muted mb-0.5">Klub</div>
                  <EditableClubField value={profile?.club} onSaveClub={handleClubSave} />
                </div>
                <div>
                  <div className="text-[9px] font-mono text-apex-muted mb-0.5">Płeć</div>
                  <EditableField
                    fieldKey="gender"
                    value={profile?.gender}
                    displayValue={GENDER_LABELS[profile?.gender]}
                    onSave={handleSave}
                    options={[
                      { value: 'M', label: 'Mężczyzna' },
                      { value: 'F', label: 'Kobieta' },
                      { value: 'X', label: 'Inna' },
                    ]}
                  />
                </div>
                <div>
                  <div className="text-[9px] font-mono text-apex-muted mb-0.5">Data urodzenia</div>
                  <EditableField fieldKey="date_of_birth" value={profile?.date_of_birth} onSave={handleSave} type="date" />
                </div>
                <div>
                  <div className="text-[9px] font-mono text-apex-muted mb-0.5">Telefon</div>
                  <EditablePhoneField value={profile?.phone} onSave={handleSave} />
                </div>
                <div>
                  <div className="text-[9px] font-mono text-apex-muted mb-0.5">Miejscowość</div>
                  <EditableField fieldKey="city" value={profile?.city} onSave={handleSave} />
                </div>
                <div>
                  <div className="text-[9px] font-mono text-apex-muted mb-0.5">Województwo</div>
                  <EditableField
                    fieldKey="voivodeship"
                    value={profile?.voivodeship}
                    onSave={handleSave}
                    options={VOIVODESHIP_OPTIONS}
                  />
                </div>
              </div>
            </div>

            <div className="mb-6">
              <div className={sectionTitle}>Powiadomienia</div>
              <label className="flex items-start gap-2 cursor-pointer mb-3">
                <input
                  data-testid="toggle-weekly-digest"
                  type="checkbox"
                  checked={!!profile?.weekly_digest}
                  onChange={(e) => handleSave('weekly_digest', e.target.checked)}
                  className="mt-0.5 accent-[#BBDD00]"
                />
                <span className="font-sans text-xs text-apex-text">
                  Cotygodniowe podsumowanie e-mailem
                  <span className="block text-[10px] text-apex-muted">Zmiany w obserwowanych biegach, raz w tygodniu.</span>
                </span>
              </label>
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  data-testid="toggle-club-visibility"
                  type="checkbox"
                  checked={(profile?.privacy_settings?.favorites ?? true) !== false}
                  onChange={(e) => handleSave('privacy_settings', { ...profile?.privacy_settings, favorites: e.target.checked })}
                  className="mt-0.5 accent-[#BBDD00]"
                />
                <span className="font-sans text-xs text-apex-text">
                  Pokazuj klubowiczom co obserwuję
                  <span className="block text-[10px] text-apex-muted">Członkowie Twojego klubu widzą, które biegi obserwujesz.</span>
                </span>
              </label>
            </div>
          </aside>

          {/* Main */}
          <div className="flex-1">
            <div className="mb-10">
              <div className={sectionTitle}>Obserwowane biegi</div>
              <p className="font-sans text-xs text-apex-muted -mt-2 mb-4">
                Powiadomimy Cię tutaj, gdy obserwowany bieg zostanie odwołany, pojawi się link do zapisów
                lub zostanie 7 dni do końca zapisów.
              </p>

              {notifications.length > 0 && (
                <div className="mb-5 space-y-0" data-testid="notifications-feed">
                  {notifications.map((n) => (
                    <div key={n.id} className="flex items-center gap-3 py-2 border-b border-apex-border/50 text-xs">
                      <span className={`px-1.5 py-0.5 font-mono text-[9px] border flex-shrink-0 ${
                        n.type === 'cancelled' ? 'border-apex-red/40 text-apex-red'
                        : n.type === 'registration_opened' ? 'border-green-800 text-green-400'
                        : 'border-apex-yellow-dim text-apex-yellow'
                      }`}>
                        {n.type === 'cancelled' ? 'Odwołany' : n.type === 'registration_opened' ? 'Zapisy ruszyły' : 'Koniec zapisów blisko'}
                      </span>
                      <a href={`/kalendarz/${slugify(n.event_name || '', n.event_date)}`} className="flex-1 text-apex-text truncate no-underline hover:text-apex-yellow">
                        {n.event_name}
                      </a>
                      <span className="text-apex-muted flex-shrink-0">{new Date(n.created_at).toLocaleDateString('pl-PL')}</span>
                    </div>
                  ))}
                </div>
              )}

              {starredEvents.length === 0 ? (
                <p className="font-sans text-sm text-apex-muted py-4">
                  Nie obserwujesz jeszcze żadnych biegów. Wejdź do{' '}
                  <a href="/kalendarz" className="text-apex-yellow underline">kalendarza</a>{' '}
                  i kliknij ★ przy biegu, który Cię interesuje.
                </p>
              ) : (
                <div className="space-y-0" data-testid="starred-list">
                  {starredEvents.map((ev) => (
                    <div key={ev.id} className="flex items-center gap-3 py-2.5 border-b border-apex-border/50 text-xs">
                      <span className="font-mono text-[11px] font-semibold text-apex-yellow flex-shrink-0">
                        {new Date(ev.date).toLocaleDateString('pl-PL', { day: '2-digit', month: '2-digit', year: 'numeric' })}
                      </span>
                      <a href={`/kalendarz/${slugify(ev.name, ev.date)}`} className={`flex-1 truncate no-underline hover:text-apex-yellow ${ev.status === 'cancelled' ? 'line-through text-apex-muted' : 'text-apex-text'}`}>
                        {ev.name}
                      </a>
                      {ev.status === 'cancelled' && (
                        <span className="px-1.5 py-0.5 text-[9px] font-mono border border-apex-red/40 text-apex-red flex-shrink-0">Odwołany</span>
                      )}
                      <StarButton eventId={ev.id} />
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className={sectionTitle}>Moje zgłoszenia</div>
            <p className="font-sans text-xs text-apex-muted -mt-2 mb-4">
              Twoje raporty o poprawkach do wydarzeń oraz propozycje nowych wydarzeń wysłane do kalendarza.
            </p>
            <div className="flex flex-wrap gap-2 mb-4">
              {[
                { key: 'all', label: 'Wszystkie' },
                { key: 'pending', label: 'Oczekujące' },
                { key: 'accepted', label: 'Zaakceptowane' },
                { key: 'rejected', label: 'Odrzucone' },
              ].map(f => (
                <button key={f.key} onClick={() => setFilter(f.key)}
                  className={`font-mono text-[10px] px-2 py-1 border transition-all ${filter === f.key ? 'border-apex-yellow text-apex-yellow' : 'border-apex-border text-apex-muted hover:border-apex-yellow/40'}`}>
                  {f.label}
                </button>
              ))}
            </div>

            {filtered.length === 0 ? (
              <p className="font-sans text-sm text-apex-muted py-8">Brak zgłoszeń do wyświetlenia.</p>
            ) : (
              <div className="space-y-0">
                {filtered.map((c, i) => (
                  <div key={c.id || i} className="flex items-center gap-3 py-2.5 border-b border-apex-border/50 text-xs">
                    <span className="bg-apex-surface border border-apex-border px-1.5 py-0.5 font-mono text-[9px] text-apex-muted flex-shrink-0">{c.contribType}</span>
                    <span className="flex-1 text-apex-text truncate">{c.name}</span>
                    <span className="text-apex-muted flex-shrink-0">{new Date(c.created_at).toLocaleDateString('pl-PL')}</span>
                    <StatusBadge status={c.status} />
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
        <DangerZone />
      </main>
      <Footer />
    </div>
  )
}

export default function Profil() {
  return (
    <AuthGuard>
      <ProfilContent />
    </AuthGuard>
  )
}
