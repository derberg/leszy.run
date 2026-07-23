import { useState } from 'react'
import useAuth from '../../../hooks/useAuth.js'
import { manageMember, respondJoin } from '../../../lib/clubs.js'
import { sectionTitle, actionBtnClass } from '../../profil/fields.jsx'
import { useKlub } from '../context.js'

// One roster for everyone: read-only rows for members, role controls +
// pending-request moderation for owner/admin (canManage from context).
// Copied (not imported — those files are retired in a later task) from
// public/src/pages/profil/club/ManagePanel.jsx (RosterManage lines ~20-95,
// PendingRequests lines ~97-133) and MemberView.jsx (RoleTag lines ~9-18,
// read-only roster lines ~72-84).

const ROLE_LABELS = { owner: 'Właściciel', admin: 'Administrator', member: 'Członek' }
const btnOk = `${actionBtnClass} border-apex-yellow text-apex-yellow hover:bg-apex-yellow hover:text-apex-ink`
const btnGhost = `${actionBtnClass} border-apex-border text-apex-muted hover:text-apex-text-bright`
const btnDanger = `${actionBtnClass} border-apex-red text-apex-red hover:bg-apex-red hover:text-apex-ink`

function displayNameFor(m) {
  return m?.display_name || m?.nickname || 'Uczestnik anonimowy'
}

function RoleTag({ role }) {
  const yellow = role === 'owner'
  return (
    <span className={`px-1.5 py-0.5 text-[9px] font-mono border flex-shrink-0 ${
      yellow ? 'border-apex-yellow-dim text-apex-yellow' : 'border-apex-border text-apex-muted'
    }`}>
      {ROLE_LABELS[role] || role}
    </span>
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

export default function Roster() {
  const { club, members, reload, canManage, isOwner } = useKlub()
  const { user } = useAuth()
  const [busyId, setBusyId] = useState(null)
  const [error, setError] = useState(null)

  const activeMembers = (members ?? []).filter((m) => m.status === 'active')
  const pendingMembers = (members ?? []).filter((m) => m.status === 'pending')

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
    <div className="space-y-8">
      <div>
        <div className={sectionTitle}>Klubowicze</div>
        <div data-testid="club-roster" className="space-y-0">
          {activeMembers.map((m) => {
            const isSelf = m.user_id === user?.id
            // Owners can manage admins+members; admins can only manage members
            // (same rule as RosterManage.canManage — copied verbatim).
            const rowCanManage = canManage && !isSelf && m.role !== 'owner' && (isOwner || m.role === 'member')
            return (
              <div key={m.user_id} className="flex items-center gap-2 py-2 border-b border-apex-border/50 text-xs">
                <span className="flex-1 text-apex-text truncate">{displayNameFor(m)}</span>
                <RoleTag role={m.role} />
                {rowCanManage && (
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

      {canManage && pendingMembers.length > 0 && (
        <PendingRequests club={club} pendingMembers={pendingMembers} reload={reload} />
      )}
    </div>
  )
}
