import { callFunction } from './auth.js'

// Thin wrappers over the organizer edge functions (registration, Plan 1).
// callFunction() returns the parsed body and throws on non-2xx with the
// server's message and `status`.

export async function organizerStatus(clubId) {
  return (await callFunction('organizer-status', { clubId })).data
}

export async function joinRegistrationWaitlist(clubId) {
  return (await callFunction('join-registration-waitlist', { clubId })).data
}

export async function acceptOrganizerAgreement(clubId, version) {
  return (await callFunction('accept-organizer-agreement', { clubId, version })).data
}

/** Owner: every field. Admin: { legalName, ibanMasked }. null when nothing is saved yet. */
export async function getClubPayout(clubId) {
  return (await callFunction('get-club-payout', { clubId })).data
}

export async function updateClubPayout(clubId, fields) {
  return (await callFunction('update-club-payout', { clubId, ...fields })).data
}
