// Registration fixtures for the LOCAL stack only (admin() refuses anything else).
// Plan 1 tests delete the seed clubs' agreements in their setup, so every test
// file that needs one calls acceptAgreement() itself; tests that need a club in
// another state get a club of their own from makeClub() rather than mutating the seed.
import crypto from 'node:crypto'
import { admin, localEnv } from './stack.js'
import { ORGANIZER_AGREEMENT_VERSION } from '../../../supabase/functions/_shared/organizer.js'

async function clubBySlug(slug) {
  const { data, error } = await admin().from('clubs').select('id, name').eq('slug', slug).single()
  if (error) throw new Error(`club ${slug}: ${error.message}`)
  return data
}

/** Records the current organizer agreement for the club (idempotent). */
export async function acceptAgreement(clubSlug) {
  const club = await clubBySlug(clubSlug)
  const { error } = await admin().from('organizer_agreements').upsert(
    { club_id: club.id, club_name: club.name, version: ORGANIZER_AGREEMENT_VERSION },
    { onConflict: 'club_id,version', ignoreDuplicates: true },
  )
  if (error) throw error
  return club.id
}

async function profileFor(email) {
  const db = admin()
  const { data: found } = await db.from('profiles').select('id').eq('email', email).maybeSingle()
  if (found) return found.id
  const { data, error } = await db.from('profiles').insert({ id: crypto.randomUUID(), email }).select('id').single()
  if (error) throw error
  return data.id
}

/**
 * A club of its own with an owner, an admin and a member (<role>@<slug>.local).
 * Re-running with the same slug returns the same club.
 */
export async function makeClub({ slug, enabled = true, agreement = true }) {
  localEnv()
  const db = admin()
  const ownerEmail = `owner@${slug}.local`
  const adminEmail = `admin@${slug}.local`
  const memberEmail = `member@${slug}.local`
  const [ownerId, adminId, memberId] = await Promise.all([ownerEmail, adminEmail, memberEmail].map(profileFor))

  let { data: club } = await db.from('clubs').select('id').eq('slug', slug).maybeSingle()
  if (!club) {
    const { data, error } = await db.from('clubs').insert({
      name: `Klub ${slug}`, normalized_name: `klub ${slug}`, slug, owner_id: ownerId, is_public: true,
      registration_enabled: enabled,
    }).select('id').single()
    if (error) throw error
    club = data
    const { error: mErr } = await db.from('club_members').insert([
      { club_id: club.id, user_id: ownerId, role: 'owner', status: 'active', joined_at: new Date().toISOString() },
      { club_id: club.id, user_id: adminId, role: 'admin', status: 'active', joined_at: new Date().toISOString() },
      { club_id: club.id, user_id: memberId, role: 'member', status: 'active', joined_at: new Date().toISOString() },
    ])
    if (mErr) throw mErr
    await db.from('profiles').update({ club_id: club.id }).in('id', [ownerId, adminId, memberId])
  } else {
    const { error } = await db.from('clubs').update({ registration_enabled: enabled }).eq('id', club.id)
    if (error) throw error
  }
  if (agreement) await acceptAgreement(slug)
  return { clubId: club.id, ownerEmail, adminEmail, memberEmail }
}

/** POST an edge function as the given session ({ cookie }) or anonymously. */
export async function callFn(fn, session, body) {
  const res = await fetch(`${localEnv().functionsUrl}/${fn}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': '203.0.113.9',
      ...(session ? { cookie: session.cookie } : {}),
    },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { json = { raw: text } }
  return { status: res.status, body: json }
}
