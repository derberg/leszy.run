// The payout account of one registration event (ruling P3-R1). The details
// live in event_payout_details, service role only; no row means the club's
// own account (club_payout_details). Only update-event-payout writes them and
// only get-event-payout reads them. Everything else, the publish checklist
// included, sees payoutState(): { mode, ready }, never the account itself.

import { isValidNip, isValidPolishIban, normalizeIban, normalizeNip } from '../payoutValidation.js'

export const PAYOUT_MODES = ['club', 'custom']
const RECIPIENT_MAX = 200
const TITLE_MAX = 140

const blank = (v) => v == null || String(v).trim() === ''

/** A stored other account is complete: a recipient, a valid NIP and a valid Polish IBAN. */
export function customPayoutReady(row) {
  return !!row && !blank(row.payout_recipient) && isValidNip(row.payout_tax_id) && isValidPolishIban(row.payout_iban)
}

/**
 * What update-event-payout may store. → { ok: true, value } with the
 * save_event_payout arguments, or { ok: false, error } (Plan 1's messages).
 */
export function validateEventPayout({ mode, recipient, taxId, iban, title } = {}) {
  if (!PAYOUT_MODES.includes(mode)) return { ok: false, error: 'Wybierz konto do wypłat.' }
  if (mode === 'club') return { ok: true, value: { p_mode: 'club', p_recipient: null, p_tax_id: null, p_iban: null, p_title: null } }
  const name = String(recipient ?? '').trim()
  const label = String(title ?? '').trim()
  if (!name) return { ok: false, error: 'Podaj nazwę odbiorcy.' }
  if (name.length > RECIPIENT_MAX) return { ok: false, error: `Nazwa odbiorcy jest za długa (maks. ${RECIPIENT_MAX} znaków).` }
  if (!isValidNip(taxId)) return { ok: false, error: 'Nieprawidłowy NIP.' }
  if (!isValidPolishIban(iban)) return { ok: false, error: 'Nieprawidłowy numer rachunku.' }
  if (label.length > TITLE_MAX) return { ok: false, error: `Tytuł przelewu jest za długi (maks. ${TITLE_MAX} znaków).` }
  return {
    ok: true,
    value: { p_mode: 'custom', p_recipient: name, p_tax_id: normalizeNip(taxId), p_iban: normalizeIban(iban), p_title: label || null },
  }
}

/** → { mode: 'club'|'custom', ready: boolean } for the checklist; reads no more than it needs. */
export async function payoutState(admin, settings) {
  const { data: row, error } = await admin.from('event_payout_details')
    .select('payout_mode, payout_recipient, payout_tax_id, payout_iban').eq('event_id', settings.event_id).maybeSingle()
  if (error) throw error
  if (row?.payout_mode === 'custom') return { mode: 'custom', ready: customPayoutReady(row) }
  const { data: club, error: cErr } = await admin.from('club_payout_details')
    .select('club_id').eq('club_id', settings.club_id).maybeSingle()
  if (cErr) throw cErr
  return { mode: 'club', ready: !!club }
}
