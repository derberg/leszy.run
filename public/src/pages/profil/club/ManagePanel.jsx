import { useState, useEffect } from 'react'
import useAuth from '../../../hooks/useAuth.js'
import ClubLogoUpload from '../../../components/ClubLogoUpload.jsx'
import MemberView from './MemberView.jsx'
import {
  manageMember, manageClubInvite, transferOwnership, updateClub, deleteClub, respondJoin,
} from '../../../lib/clubs.js'
import { sectionTitle, actionBtnClass, inputClass } from '../fields.jsx'

const ROLE_LABELS = { owner: 'Właściciel', admin: 'Administrator', member: 'Członek' }
const primaryBtnClass = 'font-display font-bold text-[11px] tracking-widest uppercase px-3 py-1.5 border-2 border-apex-yellow text-apex-yellow hover:bg-apex-yellow hover:text-apex-ink transition-all disabled:opacity-40 disabled:cursor-not-allowed'
const btnOk = `${actionBtnClass} border-apex-yellow text-apex-yellow hover:bg-apex-yellow hover:text-apex-ink`
const btnGhost = `${actionBtnClass} border-apex-border text-apex-muted hover:text-apex-text-bright`
const btnDanger = `${actionBtnClass} border-apex-red text-apex-red hover:bg-apex-red hover:text-apex-ink`

function displayNameFor(m) {
  return m?.display_name || m?.nickname || 'Uczestnik anonimowy'
}

function RosterManage({ club, me, selfId, activeMembers, reload }) {
  const isOwner = me.role === 'owner'
  const [busyId, setBusyId] = useState(null)
  const [error, setError] = useState(null)

  async function setRole(userId, role) {
    setBusyId(userId)
    setError(null)
    try {
      await manageMember(club.id, 'set-role', { user_id: userId, role })
      await reload()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusyId(null)
    }
  }

  async function removeMember(userId) {
    setBusyId(userId)
    setError(null)
    try {
      await manageMember(club.id, 'remove', { user_id: userId })
      await reload()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div>
      <div className={sectionTitle}>Klubowicze i role</div>
      <div className="space-y-0">
        {activeMembers.map((m) => {
          const isSelf = m.user_id === selfId
          const canManage = !isSelf && m.role !== 'owner' && (isOwner || m.role === 'member')
          return (
            <div key={m.user_id} className="flex items-center gap-2 py-2 border-b border-apex-border/50 text-xs">
              <span className="flex-1 text-apex-text truncate">{displayNameFor(m)}</span>
              <span className={`px-1.5 py-0.5 text-[9px] font-mono border flex-shrink-0 ${
                m.role === 'owner' ? 'border-apex-yellow-dim text-apex-yellow' : 'border-apex-border text-apex-muted'
              }`}>
                {ROLE_LABELS[m.role] || m.role}
              </span>
              {canManage && (
                <>
                  {isOwner && (
                    <button
                      data-testid={`set-role-${m.user_id}`}
                      onClick={() => setRole(m.user_id, m.role === 'admin' ? 'member' : 'admin')}
                      disabled={busyId === m.user_id}
                      className={btnGhost}
                    >
                      {m.role === 'admin' ? 'Ustaw członka' : 'Ustaw admina'}
                    </button>
                  )}
                  <button
                    data-testid={`remove-member-${m.user_id}`}
                    onClick={() => removeMember(m.user_id)}
                    disabled={busyId === m.user_id}
                    className={btnDanger}
                  >
                    Usuń
                  </button>
                </>
              )}
            </div>
          )
        })}
      </div>
      {error && <p className="text-apex-red font-sans text-xs mt-1.5">{error}</p>}
    </div>
  )
}

function PendingRequests({ club, pendingMembers, reload }) {
  const [busyId, setBusyId] = useState(null)
  const [error, setError] = useState(null)

  async function respond(userId, action) {
    setBusyId(userId)
    setError(null)
    try {
      await respondJoin(club.id, userId, action)
      await reload()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div>
      <div className={sectionTitle}>Oczekujące prośby o dołączenie</div>
      <div className="space-y-0">
        {pendingMembers.map((m) => (
          <div key={m.user_id} className="flex items-center gap-2 py-2 border-b border-apex-border/50 text-xs">
            <span className="flex-1 text-apex-text truncate">{displayNameFor(m)}</span>
            <button data-testid={`approve-${m.user_id}`} onClick={() => respond(m.user_id, 'approve')} disabled={busyId === m.user_id} className={btnOk}>
              Zaakceptuj
            </button>
            <button data-testid={`reject-${m.user_id}`} onClick={() => respond(m.user_id, 'reject')} disabled={busyId === m.user_id} className={btnDanger}>
              Odrzuć
            </button>
          </div>
        ))}
      </div>
      {error && <p className="text-apex-red font-sans text-xs mt-1.5">{error}</p>}
    </div>
  )
}

function InvitesSection({ club }) {
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

  useEffect(() => { loadInvites() }, [club.id])

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

function EditClubSection({ club, reload }) {
  const [name, setName] = useState(club.name)
  const [description, setDescription] = useState(club.description || '')
  const [isPublic, setIsPublic] = useState(!!club.is_public)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const [saved, setSaved] = useState(false)

  async function save(e) {
    e.preventDefault()
    setSaving(true)
    setError(null)
    setSaved(false)
    try {
      await updateClub(club.id, { name: name.trim(), description: description.trim(), is_public: isPublic })
      await reload()
      setSaved(true)
    } catch (err) {
      setError(/istnieje/i.test(err.message) ? 'Klub o tej nazwie już istnieje.' : err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      <div className={sectionTitle}>Edytuj klub</div>
      <div className="mb-3">
        <ClubLogoUpload clubId={club.id} currentUrl={club.logo_url} onUploaded={() => reload()} />
      </div>
      <form onSubmit={save} className="space-y-2 max-w-sm">
        <input data-testid="edit-club-name" type="text" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} className={inputClass} />
        <textarea data-testid="edit-club-description" value={description} onChange={(e) => setDescription(e.target.value)} rows={2} className={`${inputClass} resize-none`} />
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            data-testid="toggle-club-public"
            type="checkbox"
            checked={isPublic}
            onChange={(e) => setIsPublic(e.target.checked)}
            className="accent-[#BBDD00]"
          />
          <span className="font-sans text-xs text-apex-text">Publiczna strona klubu widoczna dla wszystkich</span>
        </label>
        {error && <p className="text-apex-red font-sans text-xs">{error}</p>}
        <div className="flex items-center gap-2">
          <button type="submit" data-testid="save-club" disabled={saving} className={primaryBtnClass}>
            {saving ? 'Zapisywanie…' : 'Zapisz zmiany'}
          </button>
          {saved && <span className="font-mono text-xs text-apex-yellow">Zapisano</span>}
        </div>
      </form>
    </div>
  )
}

function TransferOwnershipSection({ club, activeMembers, selfId, reload }) {
  const [target, setTarget] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const candidates = activeMembers.filter((m) => m.user_id !== selfId && m.role !== 'owner')
  const nominee = club.pending_owner_id ? activeMembers.find((m) => m.user_id === club.pending_owner_id) : null

  async function nominate() {
    if (!target) return
    setBusy(true)
    setError(null)
    try {
      await transferOwnership(club.id, 'nominate', target)
      await reload()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  async function cancelNomination() {
    setBusy(true)
    setError(null)
    try {
      await transferOwnership(club.id, 'cancel')
      await reload()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <div className={sectionTitle}>Przekaż własność</div>
      {club.pending_owner_id ? (
        <div className="flex items-center gap-2 text-xs">
          <span className="flex-1 text-apex-text">
            Oczekuje na akceptację: <strong>{nominee ? displayNameFor(nominee) : 'nowy właściciel'}</strong>
          </span>
          <button data-testid="cancel-nomination" onClick={cancelNomination} disabled={busy} className={btnDanger}>
            Anuluj nominację
          </button>
        </div>
      ) : candidates.length === 0 ? (
        <p className="font-sans text-xs text-apex-muted">Brak innych aktywnych członków do nominacji.</p>
      ) : (
        <div className="flex items-center gap-2">
          <select
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            className={`${inputClass} appearance-none cursor-pointer max-w-xs`}
          >
            <option value="">— wybierz członka —</option>
            {candidates.map((m) => (
              <option key={m.user_id} value={m.user_id}>{displayNameFor(m)}</option>
            ))}
          </select>
          <button data-testid={target ? `nominate-${target}` : 'nominate'} onClick={nominate} disabled={busy || !target} className={btnOk}>
            Nominuj na właściciela
          </button>
        </div>
      )}
      {error && <p className="text-apex-red font-sans text-xs mt-1.5">{error}</p>}
    </div>
  )
}

function DeleteClubSection({ club, reload }) {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  async function doDelete() {
    setBusy(true)
    setError(null)
    try {
      await deleteClub(club.id)
      // get-club now returns { club: null } for the (former owner's) caller —
      // reload() takes the section back to the no-club create/join branch.
      await reload()
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }

  return (
    <div>
      <div className={sectionTitle}>Usuń klub</div>
      {!confirming ? (
        <button data-testid="delete-club-btn" onClick={() => setConfirming(true)} className={btnDanger}>
          Usuń klub
        </button>
      ) : (
        <div className="border border-apex-red p-3 max-w-sm">
          <p className="font-sans text-xs text-apex-text mb-2">
            Usunięcie klubu «{club.name}» jest nieodwracalne. Wszyscy członkowie stracą przypisanie do klubu.
          </p>
          <div className="flex items-center gap-2">
            <button data-testid="confirm-delete-club" onClick={doDelete} disabled={busy} className={btnDanger}>
              {busy ? 'Usuwanie…' : 'Tak, usuń klub'}
            </button>
            <button onClick={() => setConfirming(false)} disabled={busy} className={btnGhost}>Anuluj</button>
          </div>
        </div>
      )}
      {error && <p className="text-apex-red font-sans text-xs mt-1.5">{error}</p>}
    </div>
  )
}

// Owner/admin manage panel — roster+roles, pending requests, invites, edit,
// transfer ownership, delete. Embeds MemberView at the bottom so
// owners/admins also see the same roster/followed-events as a plain member.
// <ManagePanel club me members followedEvents reload />
export default function ManagePanel({ club, me, members, followedEvents, reload }) {
  const { user } = useAuth()
  const isOwner = me.role === 'owner'
  const activeMembers = (members ?? []).filter((m) => m.status === 'active')
  const pendingMembers = (members ?? []).filter((m) => m.status === 'pending')

  return (
    <div data-testid="manage-panel" className="space-y-8">
      <RosterManage club={club} me={me} selfId={user?.id} activeMembers={activeMembers} reload={reload} />
      {pendingMembers.length > 0 && (
        <PendingRequests club={club} pendingMembers={pendingMembers} reload={reload} />
      )}
      <InvitesSection club={club} />
      <EditClubSection club={club} reload={reload} />
      {isOwner && (
        <TransferOwnershipSection club={club} activeMembers={activeMembers} selfId={user?.id} reload={reload} />
      )}
      {isOwner && <DeleteClubSection club={club} reload={reload} />}

      <div>
        <div className={sectionTitle}>Widok klubowicza</div>
        <MemberView club={club} me={me} members={members} followedEvents={followedEvents} reload={reload} />
      </div>
    </div>
  )
}
