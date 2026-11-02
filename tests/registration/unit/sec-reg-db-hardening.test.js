// Static check of 20261111210000_registration_db_hardening.sql: the default-privileges revoke
// (so a future function is not client-callable by accident), the two club helper revokes, the logo
// bucket MIME list and the client write revoke. Comments are stripped before matching.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const raw = readFileSync(new URL('../../../supabase/migrations/20261111210000_registration_db_hardening.sql', import.meta.url), 'utf8')
const sql = raw.split('\n').map((l) => l.replace(/--.*$/, '')).join(' ').replace(/\s+/g, ' ')

test('default privileges: PUBLIC loses EXECUTE globally, anon and authenticated in public', () => {
  assert.match(sql, /ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;/i)
  assert.match(sql, /ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated;/i)
  assert.doesNotMatch(sql, /REVOKE EXECUTE ON FUNCTIONS FROM[^;]*service_role/i)
})

test('find_or_create_club(text) and similar_club_pairs(real) are revoked from PUBLIC, anon, authenticated', () => {
  assert.match(sql, /REVOKE EXECUTE ON FUNCTION public\.find_or_create_club\(text\), public\.similar_club_pairs\(real\) FROM PUBLIC, anon, authenticated;/i)
})

test('logo buckets accept PNG and JPEG only, and nothing is deleted', () => {
  assert.match(sql, /UPDATE storage\.buckets SET allowed_mime_types = ARRAY\['image\/png', 'image\/jpeg'\] WHERE id IN \('partner-logos', 'club-logos'\);/i)
  assert.doesNotMatch(sql, /\bDELETE FROM\b|\bDROP\b|\bTRUNCATE\b/i)
})

test('client write privileges are revoked on every listed table, SELECT untouched', () => {
  const m = sql.match(/REVOKE INSERT, UPDATE, DELETE ON (.*?) FROM anon, authenticated;/i)
  assert.ok(m, 'the write revoke')
  const tables = m[1].split(',').map((t) => t.trim())
  for (const t of ['admin_actions', 'event_secrets', 'participants', 'events', 'results', 'race_runs', 'categories',
    'checkpoints', 'consent_log', 'user_badges', 'geocode_cache', 'url_suggestions', 'notification_preferences',
    'event_documents', 'gate_crossings', 'checkpoint_categories', 'checkins', 'checkin_documents', 'checkpoint_observations']) {
    assert.ok(tables.includes(`public.${t}`), t)
  }
  assert.doesNotMatch(sql, /REVOKE[^;]*\bSELECT\b/i)
})
