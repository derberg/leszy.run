// Who a club invite is actually for.
//
// accept-invite used to look an invite up by id and never compare it to the
// person accepting. A direct invite stores target_email / target_username, is
// created with no expiry and no use limit, and its `uses` counter was only
// incremented for link invites — so the UUID in it was a permanent, unlimited,
// transferable key to the club. Anyone who saw it (a forwarded screenshot, a
// shared screen, an admin who later left) could join, repeatedly, under any
// account, until somebody thought to revoke it.

function norm(value) {
  return String(value ?? '').trim().toLowerCase()
}

/**
 * @param invite {{ kind: string, target_email?: string|null, target_username?: string|null }}
 * @param caller {{ email?: string|null, username?: string|null }}
 */
export function inviteIsForCaller(invite, caller) {
  if (invite?.kind !== 'direct') return true // a link is meant to be passed around

  const email = norm(invite.target_email)
  const username = norm(invite.target_username)
  if (!email && !username) return false // names nobody → nobody, not everybody

  if (email && norm(caller?.email) && email === norm(caller.email)) return true
  if (username && norm(caller?.username) && username === norm(caller.username)) return true
  return false
}

/**
 * Whether an invite can still be used, judged on the row alone. accept-invite
 * and preview-invite both read this, so the page that shows an invite and the
 * call that redeems it cannot disagree about whether it is alive.
 *
 * @param invite {{ revoked?: boolean, expires_at?: string|null, max_uses?: number|null, uses?: number }}
 * @returns {'valid'|'revoked'|'expired'|'exhausted'}
 */
export function inviteState(invite, now = new Date()) {
  if (invite.revoked) return 'revoked'
  if (invite.expires_at && new Date(invite.expires_at) < now) return 'expired'
  if (invite.max_uses != null && invite.uses >= invite.max_uses) return 'exhausted'
  return 'valid'
}
