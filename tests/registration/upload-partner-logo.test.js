// Event partners, task 3: `upload-partner-logo`, a partner's logo re-encoded to PNG, its header
// checked before anything decodes it. Scenarios EP-12…EP-15 in docs/registration/scenario-matrix.md.
// LOCAL stack only.
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import sharp from 'sharp'
import { admin, resetThrottle, sessionFor } from './helpers/stack.js'
import { acceptAgreement, callFn, createPublishedPaidEvent } from './helpers/registrationFixtures.js'
import { db, one, rows, runnerEmail } from './helpers/orders.js'
import { dataUrl, pngBytes, pngHeaderOnly } from './helpers/images.js'
import { imageHeader } from '../../supabase/functions/_shared/imageHeader.js'

const TYPES = 'Dozwolone: PNG, JPG, WebP.'
const TOO_BIG = 'Plik jest za duży (limit 2 MB).'
const TOO_LARGE = 'Obraz jest za duży (maks. 6000×6000 px).'
const UNREADABLE = 'Nie udało się odczytać obrazu.'
const UUID_PNG = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.png$/

let owner, adminS, member, outsider, clubId
before(async () => {
  await resetThrottle()
  clubId = await acceptAgreement('zatyrani-test')
  ;[owner, adminS, member, outsider] = await Promise.all([
    'owner@zatyrani-test.local', 'admin@zatyrani-test.local', 'member@zatyrani-test.local', runnerEmail('outsider'),
  ].map(sessionFor))
})

const rand = () => crypto.randomBytes(4).toString('hex')
const upload = (eventId, partnerId, body, session = owner) => callFn('upload-partner-logo', session, { eventId, partnerId, ...body })
const bucket = () => admin().storage.from('partner-logos')

async function partner(eventId) {
  const r = await callFn('organizer-partners', owner, { eventId, action: 'create', name: `Sklep ${rand()}` })
  assert.equal(r.status, 201, JSON.stringify(r.body))
  return r.body.data.id
}
async function stored(path) {
  const { data, error } = await bucket().download(path)
  if (error || !data) return null
  return new Uint8Array(await data.arrayBuffer())
}
async function objectNames() {
  const { data, error } = await bucket().list('', { limit: 1000 })
  assert.equal(error, null, error?.message)
  return new Set(data.map((o) => o.name))
}

// ---------------------------------------------------------------- EP-12

test('EP-12 an 800×400 PNG is stored as a 400×200 PNG at a root <uuid>.png, the row points at it; a JPEG re-encoded; logged', async () => {
  const event = await createPublishedPaidEvent(owner)
  const id = await partner(event.eventId)
  const r = await upload(event.eventId, id, { dataUrl: dataUrl('image/png', pngBytes(800, 400)) })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  const row = await one('event_partners', { id })
  assert.match(row.logo_path, UUID_PNG)
  assert.equal(r.body.data.logoUrl, row.logo_url)
  assert.ok(row.logo_url.endsWith(`/partner-logos/${row.logo_path}`), row.logo_url)
  assert.ok(row.updated_at, 'updated_at stamped')
  const bytes = await stored(row.logo_path)
  assert.deepEqual(imageHeader(bytes), { type: 'png', width: 400, height: 200 })

  // A small JPEG-typed PNG is decided by its bytes: stored as PNG, never enlarged.
  const small = await upload(event.eventId, id, { dataUrl: dataUrl('image/jpeg', pngBytes(120, 60)) })
  assert.equal(small.status, 200, JSON.stringify(small.body))
  const row2 = await one('event_partners', { id })
  assert.deepEqual(imageHeader(await stored(row2.logo_path)), { type: 'png', width: 120, height: 60 })

  // A real JPEG (made by sharp) decodes and comes out as a PNG inside 400×400.
  await assertReencoded(event.eventId, id, 'image/jpeg',
    await sharp({ create: { width: 300, height: 900, channels: 3, background: '#c03' } }).jpeg().toBuffer(), [133, 400])

  const logged = (await rows('organizer_actions', { event_id: event.eventId })).filter((l) => l.action === 'partner_logo_changed')
  assert.equal(logged.length, 3)
  for (const l of logged) assert.deepEqual([l.target, l.payload, l.club_id], [id, null, clubId])
})

async function assertReencoded(eventId, id, mime, bytes, size) {
  const res = await upload(eventId, id, { dataUrl: dataUrl(mime, bytes) })
  assert.equal(res.status, 200, `${mime}: ${JSON.stringify(res.body)}`)
  const h = imageHeader(await stored((await one('event_partners', { id })).logo_path))
  assert.equal(h.type, 'png', mime)
  assert.ok(Math.abs(h.width - size[0]) <= 1 && Math.abs(h.height - size[1]) <= 1, `${mime}: ${JSON.stringify(h)}`)
}

// The requirement (Global Constraints: PNG, JPEG and WebP in) that imagescript 1.2.15 cannot meet:
// it has no WebP decoder, so a real WebP is refused as unreadable. A todo until a decoder is chosen.
test('EP-12 a real WebP is re-encoded to PNG', { todo: 'imagescript 1.2.15 has no WebP decoder' }, async () => {
  const event = await createPublishedPaidEvent(owner)
  const id = await partner(event.eventId)
  await assertReencoded(event.eventId, id, 'image/webp',
    await sharp({ create: { width: 900, height: 300, channels: 3, background: '#0c3' } }).webp().toBuffer(), [400, 133])
})

// ---------------------------------------------------------------- EP-13

test('EP-13 refusals before decode: SVG, SVG bytes behind a PNG prefix, GIF, garbage, a 50000×50000 header, 2 MB + 1 byte; nothing written', async () => {
  const event = await createPublishedPaidEvent(owner)
  const id = await partner(event.eventId)
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>')
  const before = await objectNames()
  const cases = [
    ['svg data url', { dataUrl: dataUrl('image/svg+xml', svg) }, TYPES],
    ['png prefix, svg bytes', { dataUrl: dataUrl('image/png', svg) }, TYPES],
    ['gif', { dataUrl: dataUrl('image/gif', Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'latin1')) }, TYPES],
    ['png prefix, gif bytes', { dataUrl: dataUrl('image/png', Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'latin1')) }, TYPES],
    ['not base64', { dataUrl: 'data:image/png;base64,@@@@' }, TYPES],
    ['no data url', { dataUrl: 42 }, TYPES],
    ['bomb header', { dataUrl: dataUrl('image/png', pngHeaderOnly(50000, 50000)) }, TOO_LARGE],
    ['6001 wide', { dataUrl: dataUrl('image/png', pngHeaderOnly(6001, 10)) }, TOO_LARGE],
    ['2 MB + 1', { dataUrl: dataUrl('image/png', Buffer.concat([pngBytes(1, 1), Buffer.alloc(2 * 1024 * 1024 + 1 - pngBytes(1, 1).length)])) }, TOO_BIG],
    ['valid header, corrupt body', { dataUrl: dataUrl('image/png', pngHeaderOnly(10, 10)) }, UNREADABLE],
  ]
  for (const [name, body, message] of cases) {
    const r = await upload(event.eventId, id, body)
    assert.equal(r.status, 400, `${name}: ${JSON.stringify(r.body)}`)
    assert.equal(r.body.error, message, name)
  }
  const row = await one('event_partners', { id })
  assert.deepEqual([row.logo_url, row.logo_path], [null, null])
  const after = await objectNames()
  assert.deepEqual([...after].filter((n) => !before.has(n)), [], 'no object written')
  assert.equal((await rows('organizer_actions', { event_id: event.eventId })).filter((l) => l.action === 'partner_logo_changed').length, 0)
})

// ---------------------------------------------------------------- EP-14

test('EP-14 a second upload removes the first object; remove: true clears both columns and the object; a legacy logo_url is only cleared', async () => {
  const event = await createPublishedPaidEvent(owner)
  const id = await partner(event.eventId)
  assert.equal((await upload(event.eventId, id, { dataUrl: dataUrl('image/png', pngBytes(20, 20)) })).status, 200)
  const first = (await one('event_partners', { id })).logo_path
  assert.ok(await stored(first))
  const second = await upload(event.eventId, id, { dataUrl: dataUrl('image/webp', pngBytes(30, 30)) }, adminS)
  assert.equal(second.status, 200, JSON.stringify(second.body))
  const secondPath = (await one('event_partners', { id })).logo_path
  assert.notEqual(secondPath, first)
  assert.equal(await stored(first), null, 'the first object is gone')
  assert.ok(await stored(secondPath))

  const rm = await upload(event.eventId, id, { remove: true })
  assert.equal(rm.status, 200, JSON.stringify(rm.body))
  assert.deepEqual(rm.body, { data: { logoUrl: null } })
  const cleared = await one('event_partners', { id })
  assert.deepEqual([cleared.logo_url, cleared.logo_path], [null, null])
  assert.equal(await stored(secondPath), null, 'the object is gone')
  const logged = (await rows('organizer_actions', { event_id: event.eventId })).filter((l) => l.action === 'partner_logo_changed')
  assert.deepEqual(logged.map((l) => JSON.stringify(l.payload)).sort(), ['null', 'null', '{"removed":true}'])

  // A legacy row (an old SVG, logo_url with no logo_path): its object is the admin backend's.
  const legacyPath = `legacy-${rand()}.svg`
  assert.equal((await bucket().upload(legacyPath, Buffer.from('<svg/>'), { contentType: 'image/svg+xml' })).error, null)
  const legacyUrl = bucket().getPublicUrl(legacyPath).data.publicUrl
  const legacy = await partner(event.eventId)
  await db().from('event_partners').update({ logo_url: legacyUrl }).eq('id', legacy)
  assert.equal((await upload(event.eventId, legacy, { dataUrl: dataUrl('image/png', pngBytes(10, 10)) })).status, 200)
  assert.ok(await stored(legacyPath), 'a new upload leaves the legacy object')
  assert.match((await one('event_partners', { id: legacy })).logo_path, UUID_PNG)
  await db().from('event_partners').update({ logo_url: legacyUrl, logo_path: null }).eq('id', legacy)
  assert.equal((await upload(event.eventId, legacy, { remove: true })).status, 200)
  const legacyRow = await one('event_partners', { id: legacy })
  assert.deepEqual([legacyRow.logo_url, legacyRow.logo_path], [null, null])
  assert.ok(await stored(legacyPath), 'remove leaves the legacy object')
  await bucket().remove([legacyPath])
})

// ---------------------------------------------------------------- EP-15

test('EP-15 who may: no session 401; a member, an outsider and a disabled club 404; another event\'s partner 404; nothing written', async () => {
  const event = await createPublishedPaidEvent(owner)
  const id = await partner(event.eventId)
  const other = await createPublishedPaidEvent(owner)
  const foreign = await partner(other.eventId)
  const body = { dataUrl: dataUrl('image/png', pngBytes(10, 10)) }
  const before = await objectNames()

  assert.equal((await upload(event.eventId, id, body, null)).status, 401)
  for (const [who, session] of [['member', member], ['outsider', outsider]]) {
    for (const b of [body, { remove: true }]) {
      const r = await upload(event.eventId, id, b, session)
      assert.equal(r.status, 404, `${who}: ${JSON.stringify(r.body)}`)
    }
  }
  for (const pid of [foreign, 'x', crypto.randomUUID()]) {
    const r = await upload(event.eventId, pid, body)
    assert.equal(r.status, 404, `${pid}: ${JSON.stringify(r.body)}`)
  }
  await db().from('clubs').update({ registration_enabled: false }).eq('id', clubId)
  try {
    assert.equal((await upload(event.eventId, id, body)).status, 404, 'disabled club')
  } finally {
    await db().from('clubs').update({ registration_enabled: true }).eq('id', clubId)
  }
  // Neither a file nor a removal: 400.
  assert.equal((await upload(event.eventId, id, {})).status, 400)

  for (const pid of [id, foreign]) {
    const row = await one('event_partners', { id: pid })
    assert.deepEqual([row.logo_url, row.logo_path], [null, null])
  }
  assert.deepEqual([...(await objectNames())].filter((n) => !before.has(n)), [], 'no object written')
})
