// Static check of 20261112100000_team_minor_parent_consent.sql (a child whose parent is not the
// captain): what each recreated function must say, read with comments stripped. The behaviour is
// tests/registration/team-parent-consent.test.js, on the local stack.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const raw = readFileSync(new URL('../../../supabase/migrations/20261112100000_team_minor_parent_consent.sql', import.meta.url), 'utf8')
const sql = raw.split('\n').map((l) => l.replace(/--.*$/, '')).join(' ').replace(/\s+/g, ' ')
const body = (name) => {
  const start = sql.indexOf(`FUNCTION public.${name}(`)
  assert.ok(start >= 0, name)
  return sql.slice(start, sql.indexOf('REVOKE EXECUTE ON FUNCTION', start))
}

test('TP-30 every function is replaced, never created anew, and keeps its grants', () => {
  for (const [fn, sig, service] of [
    ['registration_group_lock', '(jsonb, jsonb)', false],
    ['registration_group_insert', '(public.registration_settings, jsonb, integer, uuid, text, text, uuid, text, integer, inet, text, integer, uuid, uuid)', false],
    ['team_squad_insert', '(public.registration_settings, public.registrations, jsonb, integer, integer, uuid, jsonb)', false],
    ['accept_consent_request', '(text, uuid, jsonb, jsonb)', true],
    ['mark_consent_office', '(uuid, uuid)', true],
    ['consent_requests_missing', '(integer)', true],
  ]) {
    assert.match(sql, new RegExp(`CREATE OR REPLACE FUNCTION public\\.${fn}\\(`), fn)
    const esc = sig.replace(/[().]/g, '\\$&')
    assert.match(sql, new RegExp(`REVOKE EXECUTE ON FUNCTION public\\.${fn}${esc} FROM public, anon, authenticated`), fn)
    if (service) assert.match(sql, new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}${esc} TO service_role;`), fn)
  }
  assert.doesNotMatch(sql, /\bCREATE FUNCTION\b|\bDROP\b|\bDELETE FROM\b|\bTRUNCATE\b/i)
})

test('TP-31 registration_group_insert: a named parent is the guardian, the child awaits, no acceptance is written for them', () => {
  const b = body('registration_group_insert')
  // coalesce: without it an ordinary child (no `guardian` key) made v_named NULL, so every
  // NOT v_named branch was NULL and the child got no guardian and no acceptance (CI, G-10…).
  assert.match(b, /v_named boolean := coalesce\(p_person->>'role' = 'minor' AND jsonb_typeof\(p_person->'guardian'\) = 'object', false\)/)
  assert.match(b, /guardian_email, guardian_named, consent_state,/)
  assert.match(b, /THEN p_buyer_email END, v_named, CASE WHEN/)
  assert.match(b, /v_gmail = lower\(btrim\(p_buyer_email\)\)\) THEN RAISE EXCEPTION 'invalid_people'/)
  assert.match(b, /CASE WHEN v_role = 'minor' AND NOT v_named THEN p_profile_id END/)
  assert.match(b, /CASE WHEN v_role = 'adult' OR v_named THEN 'awaiting' ELSE 'accepted' END/)
  assert.match(b, /IF v_role = 'self' OR \(v_role = 'minor' AND NOT v_named\) THEN INSERT INTO public\.consent_acceptances/)
})

test('TP-32 the captain accepts minors-only consents only for a child they answer for', () => {
  assert.match(body('registration_group_lock'), /e->>'role' = 'minor' AND jsonb_typeof\(e->'guardian'\) IS DISTINCT FROM 'object'/)
  assert.match(body('team_squad_insert'), /IF v_role = 'minor' AND jsonb_typeof\(p_person->'guardian'\) IS DISTINCT FROM 'object' THEN/)
})

test('TP-33 accept_consent_request: the guardian\'s address, every consent, accepted as guardian, the child stays a child', () => {
  const b = body('accept_consent_request')
  assert.match(b, /v_child := r\.guardian_named OR r\.guardian_name IS NOT NULL OR r\.guardian_profile_id IS NOT NULL OR r\.guardian_removed_at IS NOT NULL;/)
  assert.match(b, /v_to := CASE WHEN v_child THEN r\.guardian_email ELSE r\.email END/)
  assert.match(b, /lower\(btrim\(p\.email\)\) = lower\(btrim\(v_to\)\)\) THEN RAISE EXCEPTION 'profile_mismatch'/)
  assert.match(b, /\(public\.registration_age_on\(v_birth, v_today, 'race_day'\) < 18\) IS DISTINCT FROM v_child/)
  assert.match(b, /guardian_profile_id = CASE WHEN v_child THEN p_profile_id ELSE guardian_profile_id END/)
  assert.match(b, /profile_id = CASE WHEN v_child THEN profile_id ELSE p_profile_id END/)
  assert.equal((b.match(/\(v_child OR NOT ec\.minors_only\)/g) ?? []).length, 2, 'the set checked and the set recorded')
  assert.equal((b.match(/CASE WHEN v_child THEN 'guardian' ELSE 'self' END/g) ?? []).length, 2)
})

test('TP-34 the office signature covers a child\'s minors-only consents; a missing request is found by the guardian\'s address', () => {
  assert.match(body('mark_consent_office'), /ec\.event_id = v_event AND \(v_child OR NOT ec\.minors_only\)/)
  assert.match(body('mark_consent_office'), /SELECT event_id, guardian_named OR guardian_name IS NOT NULL/)
  assert.match(body('consent_requests_missing'), /coalesce\(r\.email, r\.guardian_email\) IS NOT NULL/)
})

// ---------------------------------------------------------------- the durable child marker and the swap notice

test('TP-35 registrations.guardian_named: added once with a false default; the purge is not recreated, so guardian_removed_at keeps meaning a deleted guardian (G-53)', () => {
  assert.match(sql, /ALTER TABLE public\.registrations ADD COLUMN guardian_named boolean NOT NULL DEFAULT false;/)
  assert.doesNotMatch(sql, /purge_registration_contact_data\(\)/)
  assert.doesNotMatch(sql2, /purge_registration_contact_data|guardian_removed_at/)
})

const raw2 = readFileSync(new URL('../../../supabase/migrations/20261112110000_team_parent_swap_notice.sql', import.meta.url), 'utf8')
const sql2 = raw2.split('\n').map((l) => l.replace(/--.*$/, '')).join(' ').replace(/\s+/g, ' ')

test('TP-36 team_squad_edit returns the named parent\'s address of a removed child, never the captain\'s', () => {
  assert.match(sql2, /CREATE OR REPLACE FUNCTION public\.team_squad_edit\(p_team_id uuid, p_actor_profile_id uuid, p_op jsonb, p_meta jsonb,/)
  assert.match(sql2, /'guardianEmail', CASE WHEN v_old\.guardian_named THEN v_old\.guardian_email END/)
  assert.match(sql2, /REVOKE EXECUTE ON FUNCTION public\.team_squad_edit\(uuid, uuid, jsonb, jsonb, boolean\) FROM public, anon, authenticated;/)
  assert.match(sql2, /GRANT EXECUTE ON FUNCTION public\.team_squad_edit\(uuid, uuid, jsonb, jsonb, boolean\) TO service_role;/)
  assert.doesNotMatch(sql2, /\bCREATE FUNCTION\b|\bDROP\b|\bDELETE FROM\b|\bTRUNCATE\b/i)
})
