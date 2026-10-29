// Plan 2, task 4: poster, regulamin PDF and GPX uploads (W-12 in
// docs/registration/scenario-matrix.md). LOCAL stack only, Storage included
// (start-stack.sh no longer excludes storage-api). Every test makes its own
// event, so "nothing stored" is checked per event.
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import zlib from 'node:zlib'
import { createClient } from '@supabase/supabase-js'
import sharp from 'sharp'
import { admin, localEnv, sessionFor } from './helpers/stack.js'
import { acceptAgreement, callFn } from './helpers/registrationFixtures.js'

const ZT = '00000000-0000-4000-8000-0000000000c1' // enabled
const FN = 'upload-registration-file'
const fx = (name) => readFileSync(new URL(`./fixtures/gpx/${name}`, import.meta.url))
const rand = () => crypto.randomBytes(4).toString('hex')

const POSTER_WIDTH = 'Plakat musi mieć co najmniej 1200 px szerokości.'
const REGULAMIN_BAD = 'Regulamin musi być plikiem PDF do 10 MB.'
const GPX_TOO_BIG = 'Plik GPX może mieć najwyżej 5 MB.'

let owner, zAdmin, member, ikOwner
before(async () => {
  await acceptAgreement('zatyrani-test')
  ;[owner, zAdmin, member, ikOwner] = await Promise.all([
    'owner@zatyrani-test.local', 'admin@zatyrani-test.local', 'member@zatyrani-test.local', 'owner@inny-klub.local',
  ].map(sessionFor))
})

async function newEvent() {
  const r = await callFn('create-registration-event', owner, { clubId: ZT, name: `Bieg Plików ${rand()}` })
  assert.equal(r.status, 201, JSON.stringify(r.body))
  return r.body.data.eventId
}

async function uploadsOf(eventId) {
  const { data, error } = await admin().from('registration_uploads').select('*').eq('event_id', eventId)
  if (error) throw error
  return data
}

async function objectsUnder(bucket, prefix) {
  const { data, error } = await admin().storage.from(bucket).list(prefix, { limit: 100 })
  if (error) throw error
  return data.filter((o) => o.name !== '.emptyFolderPlaceholder')
}

async function assertNothingStored(eventId) {
  assert.deepEqual(await uploadsOf(eventId), [], 'no registration_uploads row')
  assert.deepEqual(await objectsUnder('registration-pending', eventId), [], 'no pending object')
  assert.deepEqual(await objectsUnder('registration-files', eventId), [], 'no final object')
}

async function stored(path) {
  const { data, error } = await admin().storage.from('registration-files').download(path)
  if (error) throw error
  return Buffer.from(await data.arrayBuffer())
}

const dataUrl = (buf, mime = 'image/jpeg') => `data:${mime};base64,${buf.toString('base64')}`

async function jpegWithExif(width, height) {
  return sharp({ create: { width, height, channels: 3, background: { r: 120, g: 160, b: 40 } } })
    .jpeg({ quality: 80 })
    .withExif({ IFD0: { Copyright: 'LESZY-EXIF-MARK', Artist: 'LESZY-EXIF-MARK' } })
    .toBuffer()
}

/** start → PUT through the signed upload token (as the browser does) → finish. */
async function twoStep(session, eventId, kind, bytes, fileName, contentType) {
  const start = await callFn(FN, session, { eventId, kind, fileName, action: 'start' })
  if (start.status !== 200) return { start }
  const { pendingPath, token } = start.body.data
  const { url, anonKey } = localEnv()
  const anon = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } })
  const put = await anon.storage.from('registration-pending').uploadToSignedUrl(pendingPath, token, bytes, { contentType })
  const finish = await callFn(FN, session, { eventId, kind, pendingPath, action: 'finish' })
  return { start, put, finish, pendingPath }
}

const pdf = (extra = 0) => Buffer.concat([Buffer.from('%PDF-1.4\n% LESZY.RUN regulamin\n'), Buffer.alloc(extra, 0x20), Buffer.from('\n%%EOF\n')])

// ---------------------------------------------------------------- poster

test('W-12 poster: a JPEG with EXIF is stored re-encoded, without EXIF', async () => {
  const eventId = await newEvent()
  const src = await jpegWithExif(1300, 1800)
  assert.ok(src.includes('LESZY-EXIF-MARK'), 'fixture carries EXIF')
  const r = await callFn(FN, owner, { eventId, kind: 'poster', dataUrl: dataUrl(src), fileName: 'plakat.jpg' })
  assert.equal(r.status, 201, JSON.stringify(r.body))
  const { uploadId, url, meta } = r.body.data
  assert.match(url, new RegExp(`/registration-files/${eventId}/poster/[0-9a-f-]{36}\\.jpg$`))
  assert.deepEqual({ width: meta.width, height: meta.height }, { width: 1300, height: 1800 })
  const [row] = await uploadsOf(eventId)
  assert.equal(row.id, uploadId)
  assert.equal(row.kind, 'poster')
  assert.equal(row.uploaded_by, owner.profileId)
  const bytes = await stored(row.path)
  assert.ok(!bytes.includes('LESZY-EXIF-MARK'), 'EXIF value gone')
  assert.ok(!bytes.includes('Exif\0'), 'no EXIF segment')
  const m = await sharp(bytes).metadata()
  assert.equal(m.format, 'jpeg')
  assert.equal(m.exif, undefined)
  assert.equal(m.width, 1300)
  assert.deepEqual(await objectsUnder('registration-pending', eventId), [])
})

test('W-12 poster: an admin may upload; wider than 1600 px is scaled down to 1600', async () => {
  const eventId = await newEvent()
  const src = await sharp({ create: { width: 2000, height: 2828, channels: 3, background: '#bbdd00' } }).png().toBuffer()
  const r = await callFn(FN, zAdmin, { eventId, kind: 'poster', dataUrl: dataUrl(src, 'image/png'), fileName: 'p.png' })
  assert.equal(r.status, 201, JSON.stringify(r.body))
  assert.deepEqual({ w: r.body.data.meta.width, h: r.body.data.meta.height }, { w: 1600, h: 2262 })
  const [row] = await uploadsOf(eventId)
  assert.equal((await sharp(await stored(row.path)).metadata()).width, 1600)
})

test('W-12 poster narrower than 1200 px → 400, nothing stored', async () => {
  const eventId = await newEvent()
  const src = await jpegWithExif(1000, 1400)
  const r = await callFn(FN, owner, { eventId, kind: 'poster', dataUrl: dataUrl(src), fileName: 'maly.jpg' })
  assert.equal(r.status, 400)
  assert.equal(r.body.error, POSTER_WIDTH)
  await assertNothingStored(eventId)
})

test('W-12 poster that is not an image → 400, nothing stored', async () => {
  const eventId = await newEvent()
  for (const url of [dataUrl(pdf(), 'application/pdf'), dataUrl(Buffer.from('nie obraz'), 'image/jpeg')]) {
    const r = await callFn(FN, owner, { eventId, kind: 'poster', dataUrl: url, fileName: 'x.jpg' })
    assert.equal(r.status, 400, JSON.stringify(r.body))
    assert.equal(r.body.error, 'Plakat musi być plikiem JPG lub PNG.')
  }
  await assertNothingStored(eventId)
})

/** A real PNG whose IHDR then claims width × height (CRC fixed, so only the size is a lie). */
async function pngDeclaring(width, height) {
  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#000000' } }).png().toBuffer()
  png.writeUInt32BE(width, 16)
  png.writeUInt32BE(height, 20)
  png.writeUInt32BE(zlib.crc32(png.subarray(12, 29)), 29)
  return png
}

test('W-12 poster declaring 30000×30000 px (or taller than 6000) → 400 before decoding, nothing stored', async () => {
  const eventId = await newEvent()
  for (const [w, h] of [[30000, 30000], [1300, 7000]]) {
    const r = await callFn(FN, owner, { eventId, kind: 'poster', dataUrl: dataUrl(await pngDeclaring(w, h), 'image/png'), fileName: 'bomba.png' })
    assert.equal(r.status, 400, JSON.stringify(r.body))
    assert.equal(r.body.error, 'Plakat ma zbyt duże wymiary.')
  }
  await assertNothingStored(eventId)
})

test('W-12 an upper-case eventId is stored under the lower-case event path', async () => {
  const eventId = await newEvent()
  const src = await jpegWithExif(1300, 1800)
  const r = await callFn(FN, owner, { eventId: eventId.toUpperCase(), kind: 'poster', dataUrl: dataUrl(src), fileName: 'p.jpg' })
  assert.equal(r.status, 201, JSON.stringify(r.body))
  const [row] = await uploadsOf(eventId)
  assert.ok(row.path.startsWith(`${eventId}/poster/`), row.path)
})

// ---------------------------------------------------------------- regulamin

test('W-12 regulamin PDF: two-step upload lands in the public bucket, pending object removed', async () => {
  const eventId = await newEvent()
  const { start, put, finish, pendingPath } = await twoStep(owner, eventId, 'regulamin', pdf(1000), 'regulamin.pdf', 'application/pdf')
  assert.equal(start.status, 200, JSON.stringify(start.body))
  assert.match(pendingPath, new RegExp(`^${eventId}/[0-9a-f-]{36}$`))
  assert.ok(start.body.data.signedUrl)
  assert.equal(put.error, null, put.error?.message)
  assert.equal(finish.status, 201, JSON.stringify(finish.body))
  assert.match(finish.body.data.url, new RegExp(`/registration-files/${eventId}/regulamin/[0-9a-f-]{36}\\.pdf$`))
  const [row] = await uploadsOf(eventId)
  assert.equal(row.kind, 'regulamin')
  assert.equal(row.id, finish.body.data.uploadId)
  assert.ok((await stored(row.path)).subarray(0, 5).equals(Buffer.from('%PDF-')))
  assert.deepEqual(await objectsUnder('registration-pending', eventId), [])
})

test('W-12 regulamin that is not a PDF → 400, nothing stored', async () => {
  const eventId = await newEvent()
  const { finish } = await twoStep(owner, eventId, 'regulamin', Buffer.from('<html>regulamin</html>'), 'r.pdf', 'application/pdf')
  assert.equal(finish.status, 400)
  assert.equal(finish.body.error, REGULAMIN_BAD)
  await assertNothingStored(eventId)
})

test('W-12 regulamin over 10 MB: Storage refuses the PUT and finish → 400, nothing stored', async () => {
  const eventId = await newEvent()
  const { put, finish } = await twoStep(owner, eventId, 'regulamin', pdf(10 * 1024 * 1024), 'duzy.pdf', 'application/pdf')
  assert.ok(put.error, 'bucket limit refuses the upload')
  assert.equal(finish.status, 400)
  assert.equal(finish.body.error, REGULAMIN_BAD)
  await assertNothingStored(eventId)
})

// ---------------------------------------------------------------- gpx

test('W-12 GPX: a 9 km loop is parsed and its course stored in meta', async () => {
  const eventId = await newEvent()
  const { finish } = await twoStep(owner, eventId, 'gpx', fx('loop-9km.gpx'), 'trasa.gpx', 'application/gpx+xml')
  assert.equal(finish.status, 201, JSON.stringify(finish.body))
  const { meta, url } = finish.body.data
  assert.ok(Math.abs(meta.km - 9.1) < 0.1, `km ${meta.km}`)
  assert.deepEqual(Object.keys(meta).sort(), ['downM', 'km', 'points', 'profile', 'upM'])
  assert.ok(meta.points.length >= 2 && meta.points.length <= 500)
  assert.match(url, new RegExp(`/registration-files/${eventId}/gpx/[0-9a-f-]{36}\\.gpx$`))
  const [row] = await uploadsOf(eventId)
  assert.equal(row.kind, 'gpx')
  assert.deepEqual(row.meta, meta)
  assert.deepEqual(await objectsUnder('registration-pending', eventId), [])
})

test('W-12 GPX carrying an XHTML <script> is served as a download, never as XML or HTML', async () => {
  const eventId = await newEvent()
  const gpx = fx('loop-9km.gpx').toString('utf8')
    .replace('</gpx>', '<h:script xmlns:h="http://www.w3.org/1999/xhtml">alert(1)</h:script></gpx>')
  assert.ok(gpx.includes('alert(1)'))
  const { finish } = await twoStep(owner, eventId, 'gpx', Buffer.from(gpx), 'trasa.gpx', 'application/gpx+xml')
  assert.equal(finish.status, 201, JSON.stringify(finish.body))
  const [row] = await uploadsOf(eventId)
  const res = await fetch(`${localEnv().url}/storage/v1/object/public/registration-files/${row.path}`)
  assert.equal(res.status, 200)
  const type = res.headers.get('content-type') ?? ''
  assert.equal(type.split(';')[0].trim(), 'application/octet-stream')
  assert.doesNotMatch(type, /xml|html|svg/i)
  assert.ok((await res.text()).includes('alert(1)'), 'the bytes are kept, only the type is defused')
})

test('W-12 GPX that does not parse → 400 with the parser message, nothing stored', async () => {
  const eventId = await newEvent()
  const { finish } = await twoStep(owner, eventId, 'gpx', fx('not-gpx.kml'), 'trasa.kml', 'application/vnd.google-earth.kml+xml')
  assert.equal(finish.status, 400)
  assert.equal(finish.body.error, 'To nie jest plik GPX.')
  await assertNothingStored(eventId)
})

test('W-12 GPX over 5 MB → 400, nothing stored', async () => {
  const eventId = await newEvent()
  const big = Buffer.concat([fx('loop-9km.gpx'), Buffer.alloc(5 * 1024 * 1024, 0x20)])
  const { put, finish } = await twoStep(owner, eventId, 'gpx', big, 'duza.gpx', 'application/gpx+xml')
  assert.equal(put.error, null, 'under the bucket limit, so Storage accepts it')
  assert.equal(finish.status, 400)
  assert.equal(finish.body.error, GPX_TOO_BIG)
  await assertNothingStored(eventId)
})

// ---------------------------------------------------------------- authorization and paths

test('W-12 another club\'s owner gets 404, a member 403, on every call', async () => {
  const eventId = await newEvent()
  const src = await jpegWithExif(1300, 1800)
  const poster = { eventId, kind: 'poster', dataUrl: dataUrl(src), fileName: 'p.jpg' }
  const start = { eventId, kind: 'gpx', fileName: 't.gpx', action: 'start' }
  const finish = { eventId, kind: 'gpx', pendingPath: `${eventId}/${crypto.randomUUID()}`, action: 'finish' }
  for (const body of [poster, start, finish]) {
    assert.equal((await callFn(FN, ikOwner, body)).status, 404)
    assert.equal((await callFn(FN, member, body)).status, 403)
  }
  assert.equal((await callFn(FN, null, poster)).status, 401)
  await assertNothingStored(eventId)
})

test('W-12 finish refuses a pending path of another event and leaves that object alone', async () => {
  const a = await newEvent()
  const b = await newEvent()
  const startA = await callFn(FN, owner, { eventId: a, kind: 'gpx', fileName: 't.gpx', action: 'start' })
  assert.equal(startA.status, 200)
  const { pendingPath, token } = startA.body.data
  const { url, anonKey } = localEnv()
  const anon = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } })
  await anon.storage.from('registration-pending').uploadToSignedUrl(pendingPath, token, fx('loop-9km.gpx'), { contentType: 'application/gpx+xml' })
  const r = await callFn(FN, owner, { eventId: b, kind: 'gpx', pendingPath, action: 'finish' })
  assert.equal(r.status, 400)
  assert.equal((await objectsUnder('registration-pending', a)).length, 1, 'event A\'s pending object untouched')
  await assertNothingStored(b)
  await admin().storage.from('registration-pending').remove([pendingPath])
})

test('W-12 a poster cannot take the two-step path, nor a regulamin the data URL', async () => {
  const eventId = await newEvent()
  const r1 = await callFn(FN, owner, { eventId, kind: 'poster', fileName: 'p.jpg', action: 'start' })
  assert.equal(r1.status, 400)
  const r2 = await callFn(FN, owner, { eventId, kind: 'regulamin', dataUrl: dataUrl(pdf(), 'application/pdf'), fileName: 'r.pdf' })
  assert.equal(r2.status, 400)
  const r3 = await callFn(FN, owner, { eventId, kind: 'mapa', fileName: 'm.png', action: 'start' })
  assert.equal(r3.status, 400)
  await assertNothingStored(eventId)
})
