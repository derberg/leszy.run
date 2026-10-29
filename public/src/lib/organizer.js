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

// ---- Registration events (Plan 2) ----

/** → [{ eventId, name, state, eventDate, taken, capacity, hasPending }], newest first. */
export async function listClubRegistrationEvents(clubId) {
  return (await callFunction('list-club-registration-events', { clubId })).data
}

/** → { eventId } */
export async function createRegistrationEvent(clubId, name) {
  return (await callFunction('create-registration-event', { clubId, name })).data
}

/** → { settings, competitions, officeHours, ageGroups, kidsGroups, consents, uploads, pending, registeredCount, role, checklist } */
export async function getRegistrationEvent(eventId) {
  return (await callFunction('get-registration-event', { eventId })).data
}

/** Throws with `fields` (422) when the server refuses a value. */
export async function saveRegistrationSection(eventId, section, value) {
  // keepalive: an autosave flushed as the tab closes or reloads still arrives.
  return (await callFunction('save-registration-section', { eventId, section, value }, { keepalive: true })).data
}

/** Poster: an already resized JPEG as a data URL. → { uploadId, url, meta } */
export async function uploadPoster(eventId, dataUrl, fileName) {
  return (await callFunction('upload-registration-file', { eventId, kind: 'poster', dataUrl, fileName })).data
}

/**
 * Regulamin PDF or GPX: too big for a JSON body, so start → PUT straight to
 * the private pending bucket through the signed token → finish.
 * → { uploadId, url, meta }
 */
export async function uploadDocument(eventId, kind, file) {
  const { supabase } = await import('./supabase.js')
  const start = (await callFunction('upload-registration-file', { eventId, kind, fileName: file.name, action: 'start' })).data
  const { error } = await supabase.storage.from('registration-pending')
    .uploadToSignedUrl(start.pendingPath, start.token, file, { contentType: file.type || 'application/octet-stream' })
  // A PUT over the bucket's limit is refused here; finish then answers with the size message.
  if (error) console.warn('registration upload PUT failed:', error.message)
  return (await callFunction('upload-registration-file', { eventId, kind, pendingPath: start.pendingPath, action: 'finish' })).data
}

/** Draft → published. 409 { error: 'Uzupełnij: …', blocking } while something blocks. → { state, url } */
export async function publishRegistrationEvent(eventId) {
  return (await callFunction('publish-registration-event', { eventId, action: 'publish' })).data
}

/** The event as a runner would see it, for club members. → { raw, pending } */
export async function previewRegistrationEvent(eventId, withPending = true) {
  return (await callFunction('preview-registration-event', { eventId, withPending })).data
}

/** What „Opublikuj zmiany” would apply. → { diff, affected: { all, categoryIds }, recipientCount } */
export async function previewRegistrationChanges(eventId) {
  return (await callFunction('publish-registration-event', { eventId, action: 'preview_changes' })).data
}

/**
 * Applies the staged changes. notify = { send: false } | { send: true, subject, body }.
 * → { diff, affected, notice: { sent, recipientCount, failed? } }; 422 `fields` for subject/body.
 */
export async function publishRegistrationChanges(eventId, notify) {
  return (await callFunction('publish-registration-event', { eventId, action: 'publish_changes', notify })).data
}

/** Drops everything staged. → { discarded } */
export async function discardRegistrationChanges(eventId) {
  return (await callFunction('publish-registration-event', { eventId, action: 'discard_changes' })).data
}
