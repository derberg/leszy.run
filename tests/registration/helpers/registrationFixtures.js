// Registration fixtures for the LOCAL stack only (admin() refuses anything else).
// Plan 1 tests delete the seed clubs' agreements in their setup, so every test
// file that needs one calls acceptAgreement() itself; tests that need a club in
// another state get a club of their own from makeClub() rather than mutating the seed.
import crypto from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { admin, localEnv } from './stack.js'

// Loaded lazily so the Playwright specs can import this file: Playwright loads
// the Deno-side modules as CommonJS and cannot parse them. Specs therefore never
// call acceptAgreement(); they accept through accept-organizer-agreement.
async function agreementVersion() {
  const m = await import('../../../supabase/functions/_shared/organizer.js')
  return m.ORGANIZER_AGREEMENT_VERSION ?? m.default.ORGANIZER_AGREEMENT_VERSION
}

async function clubBySlug(slug) {
  const { data, error } = await admin().from('clubs').select('id, name').eq('slug', slug).single()
  if (error) throw new Error(`club ${slug}: ${error.message}`)
  return data
}

/** Records the current organizer agreement for the club (idempotent). */
export async function acceptAgreement(clubSlug) {
  const club = await clubBySlug(clubSlug)
  const { error } = await admin().from('organizer_agreements').upsert(
    { club_id: club.id, club_name: club.name, version: await agreementVersion() },
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

/**
 * A GPX through upload-registration-file as the browser does it: start →
 * signed PUT into the private bucket → finish. → { uploadId, url, meta }
 */
export async function uploadGpx(session, eventId, bytes, fileName = 'trasa.gpx') {
  const start = await callFn('upload-registration-file', session, { eventId, kind: 'gpx', fileName, action: 'start' })
  if (start.status !== 200) throw new Error(`gpx start: ${start.status} ${JSON.stringify(start.body)}`)
  const { pendingPath, token } = start.body.data
  const { url, anonKey } = localEnv()
  const anon = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } })
  const put = await anon.storage.from('registration-pending').uploadToSignedUrl(pendingPath, token, bytes, { contentType: 'application/gpx+xml' })
  if (put.error) throw put.error
  const finish = await callFn('upload-registration-file', session, { eventId, kind: 'gpx', pendingPath, action: 'finish' })
  if (finish.status !== 201) throw new Error(`gpx finish: ${finish.status} ${JSON.stringify(finish.body)}`)
  return finish.body.data
}

const DAY_MS = 24 * 3600 * 1000
const isoDay = (offsetDays) => new Date(Date.now() + offsetDays * DAY_MS).toISOString().slice(0, 10)

/**
 * A published FREE event, built only through the edge functions (create →
 * basics → competitions → publish), never by direct inserts. Defaults: the race
 * in 30 days, registration open from yesterday through race day, one 9 km
 * competition, a regulamin link. The club needs the current agreement
 * (acceptAgreement or makeClub). `owner` is a session ({ cookie }) or a cookie
 * string. Optional: `gpx` (file bytes) becomes the first competition's course,
 * `office` is saved as the Biuro zawodów section. → { eventId, slug, categoryIds, gpx }
 */
export async function createPublishedFreeEvent(owner, {
  clubSlug = 'zatyrani-test',
  name = `Bieg Leszego ${crypto.randomBytes(4).toString('hex')}`,
  competitions = [{ name: 'Bieg 9 km', discipline: 'run', distanceLabel: '9 km', startTime: '10:00', capacity: 50 }],
  eventDate = isoDay(30),
  opensOn = isoDay(-1),
  closesOn = eventDate,
  timingMode = 'leszyrun',
  gpx = null,
  office = null,
} = {}) {
  const session = typeof owner === 'string' ? { cookie: owner } : owner
  const club = await clubBySlug(clubSlug)
  const expect = (r, status, what) => {
    if (r.status !== status) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.body)}`)
    return r.body.data
  }
  const { eventId } = expect(await callFn('create-registration-event', session, { clubId: club.id, name }), 201, 'create')
  const save = async (section, value) => expect(
    await callFn('save-registration-section', session, { eventId, section, value }), 200, `save ${section}`)
  await save('basics', {
    eventDate, opensOn, closesOn, firstStartTime: '10:00',
    townLabel: 'Nieborowice', townArea: 'GM. PILCHOWICE · ŚLĄSKIE', lat: 50.2381, lng: 18.5412,
    regulaminKind: 'link', regulaminUrl: 'https://example.org/regulamin.pdf', contactEmail: 'zapisy@klub.example',
  })
  if (office) await save('office', office)
  const course = gpx ? await uploadGpx(session, eventId, gpx) : null
  const { categoryIds } = await save('competitions', {
    pricingMode: 'free',
    items: competitions.map((c, i) => ({
      kind: 'individual', timed: true, isKids: false, ...(course && i === 0 ? { gpxUploadId: course.uploadId } : {}), ...c,
    })),
  })
  if (timingMode !== 'leszyrun') await save('timing', { timingMode })
  const published = expect(await callFn('publish-registration-event', session, { eventId, action: 'publish' }), 200, 'publish')
  const slug = new URL(published.url).pathname.split('/').pop()
  return { eventId, slug, categoryIds, gpx: course }
}
