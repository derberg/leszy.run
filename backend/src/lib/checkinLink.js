import { createHmac, randomInt } from 'node:crypto'

// Self check-in links carry `t`, an HMAC of the participant id under the
// event's checkin_link_key (Supabase event_secrets, service role only). The
// self-checkin edge function recomputes it in supabase/functions/_shared/
// checkinToken.js; test/checkinLink.test.js holds both to one vector. A bare
// participant id is public, so on its own it no longer checks anybody in.

export const TOKEN_LENGTH = 32

export function checkinToken(key, participantId) {
  return createHmac('sha256', key).update(participantId).digest('base64url').slice(0, TOKEN_LENGTH)
}

export function checkinUrl(event, participantId, key) {
  return `https://leszy.run/events/${event.slug}/checkin?p=${participantId}&t=${checkinToken(key, participantId)}`
}

/**
 * The event's link key, creating the event_secrets row if the event has none
 * yet (the column default generates the key).
 * @returns {Promise<string>}
 */
export async function getCheckinLinkKey(supabase, eventId) {
  const read = () => supabase.from('event_secrets').select('checkin_link_key').eq('event_id', eventId).maybeSingle()
  let { data, error } = await read()
  if (error) throw new Error(error.message)
  if (!data) {
    const { error: insErr } = await supabase
      .from('event_secrets').upsert({ event_id: eventId }, { onConflict: 'event_id', ignoreDuplicates: true })
    if (insErr) throw new Error(insErr.message)
    ;({ data, error } = await read())
    if (error) throw new Error(error.message)
  }
  if (!data?.checkin_link_key) throw new Error('No check-in link key for this event')
  return data.checkin_link_key
}

/**
 * A 10-digit PIN from the CSPRNG (Math.random is predictable). The lockout in
 * event_pin_ok() allows 100 wrong guesses per 15 minutes per event, which
 * against 9e9 values never finds the PIN; with 6 digits it would within weeks.
 */
export function generatePin() {
  return String(randomInt(1_000_000_000, 10_000_000_000))
}
