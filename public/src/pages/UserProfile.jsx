import { useState, useEffect } from 'react'
import { useParams } from 'react-router-dom'
import Navbar from '../components/Navbar.jsx'
import Footer from '../components/Footer.jsx'
import { supabase } from '../lib/supabase.js'
import useSeo from '../hooks/useSeo.js'

const sectionTitle = 'font-display font-bold text-[10px] tracking-widest uppercase text-apex-muted border-b border-apex-border pb-1 mb-3'

function StatusBadge({ status }) {
  if (status === 'accepted') {
    return <span className="px-1.5 py-0.5 text-[9px] font-mono border border-green-800 text-green-400">OK</span>
  }
  return <span className="px-1.5 py-0.5 text-[9px] font-mono border border-apex-yellow-dim text-apex-yellow">oczekuje</span>
}

export default function UserProfile() {
  const { username } = useParams()
  const [profile, setProfile] = useState(null)
  const [badges, setBadges] = useState([])
  const [reports, setReports] = useState([])
  const [submissions, setSubmissions] = useState([])
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)

  useSeo({
    title: profile ? `@${profile.username} — Leszy.run` : 'Profil — Leszy.run',
    path: `/u/${username}`,
  })

  useEffect(() => {
    async function load() {
      const { data: p } = await supabase
        .from('profiles_public')
        .select('*')
        .eq('username', username)
        .single()

      if (!p) {
        setNotFound(true)
        setLoading(false)
        return
      }
      setProfile(p)

      const [{ data: b }, { data: r }, { data: s }] = await Promise.all([
        supabase.from('user_badges').select('*, badge_definitions(*)').eq('user_id', p.id),
        supabase
          .from('calendar_event_reports')
          .select('field, status, created_at')
          .eq('user_id', p.id)
          .eq('status', 'accepted')
          .order('created_at', { ascending: false })
          .limit(10),
        supabase
          .from('calendar_events')
          .select('name, status, created_at')
          .eq('submitted_by', p.id)
          .order('created_at', { ascending: false })
          .limit(10),
      ])

      setBadges(b || [])
      setReports(r || [])
      setSubmissions(s || [])
      setLoading(false)
    }
    load()
  }, [username])

  if (loading) {
    return (
      <div className="min-h-screen bg-apex-bg text-apex-text">
        <Navbar />
        <div className="flex items-center justify-center min-h-[60vh]">
          <span className="font-mono text-sm text-apex-muted animate-pulse">Ładowanie…</span>
        </div>
      </div>
    )
  }

  if (notFound) {
    return (
      <div className="min-h-screen bg-apex-bg text-apex-text">
        <Navbar />
        <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4">
          <p className="font-display font-bold text-xl text-apex-muted">
            Nie znaleziono użytkownika @{username}
          </p>
        </div>
      </div>
    )
  }

  const allContribs = [
    ...reports.map(r => ({
      contribType: 'raport',
      name: `Raport: ${r.field || 'ogólny'}`,
      status: r.status,
      created_at: r.created_at,
    })),
    ...submissions
      .filter(s => s.status === 'active')
      .map(s => ({
        contribType: 'nowe wydarzenie',
        name: s.name,
        status: 'accepted',
        created_at: s.created_at,
      })),
  ].sort((a, b) => new Date(b.created_at) - new Date(a.created_at))

  const acceptedCount = allContribs.filter(c => c.status === 'accepted').length

  return (
    <div className="min-h-screen bg-apex-bg text-apex-text">
      <Navbar />
      <main className="pt-20 pb-16 px-4 md:px-8 max-w-5xl mx-auto">
        <div className="flex gap-8">
          <aside className="w-52 flex-shrink-0">
            <div className="flex flex-col items-center gap-3 mb-6">
              <div className="w-14 h-14 bg-apex-surface border-2 border-apex-yellow flex items-center justify-center font-display font-bold text-xl text-apex-yellow">
                {profile.username[0].toUpperCase()}
              </div>
              <div className="font-display font-bold text-sm text-apex-yellow">@{profile.username}</div>
              {profile.display_name && (
                <div className="font-sans text-xs text-apex-text text-center">{profile.display_name}</div>
              )}
              {profile.club && (
                <div className="text-[9px] font-mono text-apex-muted border border-apex-border px-2 py-0.5 text-center">
                  {profile.club}
                </div>
              )}
            </div>

            <div className="space-y-1 mb-6">
              <div className="flex justify-between text-xs">
                <span className="text-apex-muted">zgłoszenia</span>
                <span className="font-mono text-apex-yellow">{allContribs.length}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-apex-muted">zaakceptowane</span>
                <span className="font-mono text-apex-yellow">{acceptedCount}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-apex-muted">odznaki</span>
                <span className="font-mono text-apex-yellow">{badges.length}</span>
              </div>
            </div>

            {badges.length > 0 && (
              <div data-testid="badges-section">
                <div className={sectionTitle}>Odznaki</div>
                <div className="flex flex-wrap gap-1">
                  {badges.map(b => {
                    const def = b.badge_definitions
                    const label = profile?.gender === 'F' && def?.name_female ? def.name_female : def?.name
                    return (
                      <span
                        key={b.id}
                        title={def?.description}
                        className="text-[10px] font-mono border border-apex-border px-1.5 py-0.5 text-apex-yellow"
                      >
                        {def?.icon} {label}
                      </span>
                    )
                  })}
                </div>
              </div>
            )}
          </aside>

          <div className="flex-1">
            <div className={sectionTitle}>Zaakceptowane zgłoszenia</div>
            {allContribs.length === 0 ? (
              <p className="font-sans text-sm text-apex-muted py-8">Brak zaakceptowanych zgłoszeń.</p>
            ) : (
              <div>
                {allContribs.map((c, i) => (
                  <div key={i} className="flex items-center gap-3 py-2.5 border-b border-apex-border/50 text-xs">
                    <span className="bg-apex-surface border border-apex-border px-1.5 py-0.5 font-mono text-[9px] text-apex-muted flex-shrink-0">
                      {c.contribType}
                    </span>
                    <span className="flex-1 text-apex-text truncate">{c.name}</span>
                    <span className="text-apex-muted flex-shrink-0">
                      {new Date(c.created_at).toLocaleDateString('pl-PL')}
                    </span>
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
