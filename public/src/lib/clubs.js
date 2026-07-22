import { callFunction } from './auth.js'
import { supabase } from './supabase.js'

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

export async function createClub(body) {
  return (await callFunction('create-club', body)).data
}

export async function requestJoin(clubId) {
  return (await callFunction('request-join', { club_id: clubId })).data
}

export async function respondJoin(clubId, userId, action) {
  return (await callFunction('respond-join', { club_id: clubId, user_id: userId, action })).data
}

export async function manageMember(clubId, action, extra = {}) {
  return (await callFunction('manage-member', { club_id: clubId, action, ...extra })).data
}

export async function manageClubInvite(clubId, op, extra = {}) {
  return (await callFunction('manage-club-invite', { club_id: clubId, op, ...extra })).data
}

export async function acceptInvite(payload) {
  return (await callFunction('accept-invite', payload)).data
}

export async function uploadClubLogo(clubId, dataUrl) {
  return (await callFunction('upload-club-logo', { club_id: clubId, data_url: dataUrl })).data
}

export async function transferOwnership(clubId, op, userId) {
  return (await callFunction('transfer-ownership', { club_id: clubId, op, ...(userId ? { user_id: userId } : {}) })).data
}

export async function getClub(clubId) {
  return (await callFunction('get-club', clubId ? { club_id: clubId } : {})).data
}

// update-club / delete-club were added after this module's first pass (see
// supabase/functions/update-club, /delete-club — owner/admin edit, owner-only
// delete). Wrapped here for the manage panel (Task 9).
export async function updateClub(clubId, body) {
  return (await callFunction('update-club', { club_id: clubId, ...body })).data
}

export async function deleteClub(clubId) {
  return (await callFunction('delete-club', { club_id: clubId })).data
}
