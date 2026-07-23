import { useState, useEffect } from 'react'
import { Navigate } from 'react-router-dom'
import useSeo from '../../hooks/useSeo.js'
import { manageClubInvite } from '../../lib/clubs.js'
import { sectionTitle, actionBtnClass, inputClass } from '../profil/fields.jsx'
import { useKlub } from './context.js'

// Copied verbatim from public/src/pages/profil/club/ManagePanel.jsx:135-272
// (InvitesSection) — that file is deleted in a later task, so this page owns
// its own copy rather than importing from it. `({ club })` prop replaced with
// `useKlub()`; access guarded below since ClubLayout only hides the tab link,
// it doesn't block direct navigation.

const primaryBtnClass = 'font-display font-bold text-[11px] tracking-widest uppercase px-3 py-1.5 border-2 border-apex-yellow text-apex-yellow hover:bg-apex-yellow hover:text-apex-ink transition-all disabled:opacity-40 disabled:cursor-not-allowed'
const btnOk = `${actionBtnClass} border-apex-yellow text-apex-yellow hover:bg-apex-yellow hover:text-apex-ink`
const btnGhost = `${actionBtnClass} border-apex-border text-apex-muted hover:text-apex-text-bright`
const btnDanger = `${actionBtnClass} border-apex-red text-apex-red hover:bg-apex-red hover:text-apex-ink`

export default function Zaproszenia() {
  const { club, canManage } = useKlub()

  useSeo({ title: `Zaproszenia — ${club.name} — Leszy.run`, noindex: true })

  // All hooks below must run unconditionally (Rules of Hooks) even though
  // non-managers get redirected — the guard return happens after them.
  const [invites, setInvites] = useState([])
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [copiedId, setCopiedId] = useState(null)
  const [directTarget, setDirectTarget] = useState('')
  const [directSent, setDirectSent] = useState(false)

  async function loadInvites() {
    try {
      const { invites } = await manageClubInvite(club.id, 'list')
      setInvites(invites ?? [])
    } catch (err) {
      setError(err.message)
    } finally {
      setLoaded(true)
    }
  }

  useEffect(() => {
    if (canManage) loadInvites()
  }, [club.id, canManage])

  if (!canManage) return <Navigate to={`/klub/${club.slug}/panel`} replace />

  async function generateLink() {
    setBusy(true)
    setError(null)
    try {
      await manageClubInvite(club.id, 'create-link', {})
      await loadInvites()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  async function revoke(inviteId) {
    setBusy(true)
    setError(null)
    try {
      await manageClubInvite(club.id, 'revoke', { invite_id: inviteId })
      await loadInvites()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  function copyLink(invite) {
    const url = `${window.location.origin}/klub/${club.slug}/dolacz?kod=${invite.code}`
    navigator.clipboard?.writeText(url)
    setCopiedId(invite.id)
    setTimeout(() => setCopiedId((id) => (id === invite.id ? null : id)), 2000)
  }

  async function sendDirect(e) {
    e.preventDefault()
    const target = directTarget.trim()
    if (!target) return
    setBusy(true)
    setError(null)
    setDirectSent(false)
    try {
      const isEmail = target.includes('@')
      await manageClubInvite(club.id, 'create-direct', isEmail ? { email: target } : { username: target.replace(/^@/, '') })
      setDirectTarget('')
      setDirectSent(true)
      await loadInvites()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const linkInvites = invites.filter((i) => i.kind === 'link')
  const directInvites = invites.filter((i) => i.kind === 'direct')

  return (
    <div>
      <div className={sectionTitle}>Zaproszenia</div>

      <div className="mb-4">
        <button data-testid="gen-link-invite" onClick={generateLink} disabled={busy} className={primaryBtnClass}>
          Wygeneruj link
        </button>
        {loaded && linkInvites.length > 0 && (
          <div className="mt-2 space-y-1.5">
            {linkInvites.map((inv) => (
              <div key={inv.id} className="flex items-center gap-2 text-xs">
                <code className="flex-1 truncate bg-apex-surface border border-apex-border px-2 py-1 font-mono text-[10px] text-apex-muted">
                  {`${window.location.origin}/klub/${club.slug}/dolacz?kod=${inv.code}`}
                </code>
                <span className="font-mono text-[9px] text-apex-muted flex-shrink-0">
                  {inv.uses}{inv.max_uses != null ? `/${inv.max_uses}` : ''} użyć
                </span>
                <button data-testid="copy-invite" onClick={() => copyLink(inv)} className={btnGhost}>
                  {copiedId === inv.id ? 'Skopiowano' : 'Kopiuj'}
                </button>
                <button data-testid="revoke-invite" onClick={() => revoke(inv.id)} disabled={busy} className={btnDanger}>
                  Unieważnij
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <form onSubmit={sendDirect} className="flex items-center gap-2 mb-2">
        <input
          data-testid="direct-invite-input"
          type="text"
          value={directTarget}
          onChange={(e) => { setDirectTarget(e.target.value); setDirectSent(false) }}
          placeholder="email@przyklad.pl albo @nazwa_uzytkownika"
          className={inputClass}
        />
        <button type="submit" disabled={busy || !directTarget.trim()} className={btnOk}>Zaproś</button>
      </form>
      {directSent && <p className="font-sans text-xs text-apex-yellow mb-2">Zaproszenie wysłane.</p>}

      {loaded && directInvites.length > 0 && (
        <div className="space-y-1.5">
          {directInvites.map((inv) => (
            <div key={inv.id} className="flex items-center gap-2 text-xs">
              <span className="flex-1 truncate text-apex-text">{inv.target_email || `@${inv.target_username}`}</span>
              <button data-testid="revoke-invite" onClick={() => revoke(inv.id)} disabled={busy} className={btnDanger}>
                Unieważnij
              </button>
            </div>
          ))}
        </div>
      )}

      {error && <p className="text-apex-red font-sans text-xs mt-1.5">{error}</p>}
    </div>
  )
}
