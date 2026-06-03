import { useState, useEffect } from 'react'
import AuthGuard from '../components/AuthGuard.jsx'
import Navbar from '../components/Navbar.jsx'
import Footer from '../components/Footer.jsx'
import useAuth from '../hooks/useAuth.js'
import { callFunction } from '../lib/auth.js'
import useSeo from '../hooks/useSeo.js'
import ClubInput from '../components/ClubInput.jsx'

const inputClass = 'flex-1 min-w-0 bg-apex-surface border border-apex-border text-apex-text-bright font-sans text-sm font-medium py-1.5 px-2.5 outline-none focus:border-apex-yellow-dim transition-colors'
const sectionTitle = 'font-display font-bold text-[10px] tracking-widest uppercase text-apex-muted border-b border-apex-border pb-1 mb-3'

function EditableField({ fieldKey, value, onSave }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value || '')
  const [saving, setSaving] = useState(false)

  async function save() {
    setSaving(true)
    await onSave(fieldKey, draft)
    setSaving(false)
    setEditing(false)
  }

  if (editing) {
    return (
      <div className="flex items-center gap-2">
        <input
          data-testid={`input-${fieldKey}`}
          value={draft}
          onChange={e => setDraft(e.target.value)}
          className={inputClass}
          autoFocus
        />
        <button
          data-testid={`save-${fieldKey}`}
          onClick={save}
          disabled={saving}
          className="font-mono text-xs text-apex-yellow border border-apex-yellow px-2 py-1 hover:bg-apex-yellow hover:text-apex-ink transition-all"
        >
          OK
        </button>
        <button
          onClick={() => setEditing(false)}
          className="font-mono text-xs text-apex-muted hover:text-apex-text transition-colors px-2 py-1"
        >
          ✕
        </button>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-3 group">
      <span className="font-sans text-sm text-apex-text">
        {value || <span className="text-apex-muted italic">nie ustawiono</span>}
      </span>
      <button
        data-testid={`edit-${fieldKey}`}
        onClick={() => { setDraft(value || ''); setEditing(true) }}
        className="font-mono text-[10px] text-apex-muted md:opacity-0 md:group-hover:opacity-100 hover:text-apex-yellow transition-all border border-apex-border px-2 py-0.5"
      >
        edytuj
      </button>
    </div>
  )
}

function EditableClubField({ value, onSaveClub }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState({ name: value || '', clubId: null })
  const [saving, setSaving] = useState(false)

  async function save() {
    setSaving(true)
    await onSaveClub(draft)
    setSaving(false)
    setEditing(false)
  }

  if (editing) {
    return (
      <div className="flex items-center gap-2">
        <div className="flex-1 min-w-0">
          <ClubInput value={draft} onChange={setDraft} inputClass={inputClass} inputId="club-edit" testId="input-club" />
        </div>
        <button
          data-testid="save-club"
          onClick={save}
          disabled={saving}
          className="font-mono text-xs text-apex-yellow border border-apex-yellow px-2 py-1 hover:bg-apex-yellow hover:text-apex-ink transition-all"
        >
          OK
        </button>
        <button onClick={() => setEditing(false)} className="font-mono text-xs text-apex-muted hover:text-apex-text transition-colors px-2 py-1">✕</button>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-3 group">
      <span className="font-sans text-sm text-apex-text">
        {value || <span className="text-apex-muted italic">nie ustawiono</span>}
      </span>
      <button
        data-testid="edit-club"
        onClick={() => { setDraft({ name: value || '', clubId: null }); setEditing(true) }}
        className="font-mono text-[10px] text-apex-muted md:opacity-0 md:group-hover:opacity-100 hover:text-apex-yellow transition-all border border-apex-border px-2 py-0.5"
      >
        edytuj
      </button>
    </div>
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
  const acceptedCount = allContribs.filter(c => c.status === 'accepted').length

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

            <div className="space-y-1 mb-6">
              <div className="flex justify-between text-xs"><span className="text-apex-muted">zgłoszenia</span><span className="font-mono text-apex-yellow">{allContribs.length}</span></div>
              <div className="flex justify-between text-xs"><span className="text-apex-muted">zaakceptowane</span><span className="font-mono text-apex-yellow">{acceptedCount}</span></div>
              <div className="flex justify-between text-xs"><span className="text-apex-muted">odznaki</span><span className="font-mono text-apex-yellow">{badges.length}</span></div>
            </div>

            {badges.length > 0 && (
              <div className="mb-6">
                <div className={sectionTitle}>Odznaki</div>
                <div className="flex flex-wrap gap-1">
                  {badges.map(b => (
                    <span key={b.id} title={b.badge_definitions?.description} className="text-[10px] font-mono border border-apex-border px-1.5 py-0.5 text-apex-yellow">
                      {b.badge_definitions?.icon} {b.badge_definitions?.name}
                    </span>
                  ))}
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
              </div>
            </div>

            <div className="border border-apex-border p-3 text-center">
              <div className="text-[9px] font-mono text-apex-muted mb-1">Powiadomienia</div>
              <div className="text-xs text-apex-muted">Wkrótce</div>
            </div>
          </aside>

          {/* Main */}
          <div className="flex-1">
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
