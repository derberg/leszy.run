import { callFunction } from './auth.js'
import { supabase } from './supabase.js'
import { clearAuthCache } from '../hooks/useAuth.js'

// Thin client wrappers over the club edge functions + the anon search_clubs
// RPC. callFunction() already returns the parsed body and throws on non-2xx,
// so each wrapper just unwraps `.data`. See docs/superpowers/plans/
// 2026-07-17-teams-clubs-frontend.md ("Backend contract recap") for the full
// per-endpoint request/response shapes.

export async function searchClubs(q) {
  if (!q || q.trim().length < 3) return []
  const { data, error } = await supabase.rpc('search_clubs', { q: q.trim() })
  if (error || !data) return []
  return data // [{ id, name, member_count }]
}

// The cached auth-me user carries club_id / club_slug, which the account menu
// links with. It is revalidated only once a day, so every call that changes the
// caller's own club drops it and the next render asks auth-me again.
function withFreshUser(result) {
  clearAuthCache()
  return result
}

export async function createClub(body) {
  return withFreshUser((await callFunction('create-club', body)).data)
}

export async function requestJoin(clubId, { hiddenPublic = true } = {}) {
  return (await callFunction('request-join', { club_id: clubId, hidden_public: hiddenPublic })).data
}

export async function respondJoin(clubId, userId, action) {
  return (await callFunction('respond-join', { club_id: clubId, user_id: userId, action })).data
}

export async function manageMember(clubId, action, extra = {}) {
  const data = (await callFunction('manage-member', { club_id: clubId, action, ...extra })).data
  return action === 'leave' ? withFreshUser(data) : data
}

export async function manageClubInvite(clubId, op, extra = {}) {
  return (await callFunction('manage-club-invite', { club_id: clubId, op, ...extra })).data
}

// Needs no session: it is what a logged-out visitor sees behind an invite link.
export async function previewInvite(code) {
  return (await callFunction('preview-invite', { code })).data
}

export async function acceptInvite(payload) {
  return withFreshUser((await callFunction('accept-invite', payload)).data)
}

export async function uploadClubLogo(clubId, dataUrl) {
  return (await callFunction('upload-club-logo', { club_id: clubId, data_url: dataUrl })).data
}

export async function transferOwnership(clubId, op, userId) {
  return (await callFunction('transfer-ownership', { club_id: clubId, op, ...(userId ? { user_id: userId } : {}) })).data
}

// ref: { club_id } | { slug } | {} (defaults to the caller's own club)
export async function getClub(ref = {}) {
  return (await callFunction('get-club', ref)).data
}

// update-club / delete-club were added after this module's first pass (see
// supabase/functions/update-club, /delete-club — owner/admin edit, owner-only
// delete). Wrapped here for the manage panel (Task 9).
export async function updateClub(clubId, body) {
  return (await callFunction('update-club', { club_id: clubId, ...body })).data
}

export async function deleteClub(clubId) {
  return withFreshUser((await callFunction('delete-club', { club_id: clubId })).data)
}
