// An event partner's field rules (event_partners): one copy for organizer-partners and the admin
// app's backend. The table's CHECKs state the same rules (migration 20261106200000).
// Plain ESM, no Deno APIs. null means "no value", undefined means "invalid".

import { isUuid } from './organizerEvent.js'

export const MAX_PARTNER_NAME = 80
export const MAX_PARTNER_NOTE = 500
const MAX_PARTNER_URL = 500

/** A partner's name: trimmed, 1–80 characters, else null. */
export function partnerName(v) {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t.length >= 1 && t.length <= MAX_PARTNER_NAME ? t : null
}

/** A note: absent or blank → null; a string of at most 500 → trimmed; anything else → undefined. */
export function partnerNote(v) {
  if (v == null) return null
  if (typeof v !== 'string') return undefined
  const t = v.trim()
  if (t.length > MAX_PARTNER_NOTE) return undefined
  return t || null
}

/** A website: absent or blank → null; an http(s) address of at most 500 → trimmed; else undefined. */
export function partnerUrl(v) {
  if (v == null) return null
  if (typeof v !== 'string') return undefined
  const t = v.trim()
  if (!t) return null
  if (t.length > MAX_PARTNER_URL || !/^https?:\/\/\S+$/i.test(t)) return undefined
  return t
}

/** The partner row, when it belongs to the event (else null: a 404, never another event's partner). */
export async function partnerOf(admin, eventId, id) {
  if (!isUuid(id)) return null
  const { data, error } = await admin.from('event_partners').select('*').eq('id', id).eq('event_id', eventId).maybeSingle()
  if (error) throw error
  return data
}
