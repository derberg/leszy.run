// W-44: the host-side purge of registration participants' phone numbers.
// Needs a scratch Postgres (SCRATCH_HOST_DATABASE_URL, default 127.0.0.1:55432, the one
// tests/registration uses); skipped when none answers. Never the real database.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { eq, inArray } from 'drizzle-orm'
import * as schema from '../src/db/schema.js'
import { purgeRegistrationContact, cutoffDate } from '../scripts/lib/purgeRegistrationContact.js'

// 55432 + n x 100 under REG_TEST_SLOT=n (tests/registration/helpers/slot.js).
const SCRATCH_PORT = String(55432 + Number(process.env.REG_TEST_SLOT || 0) * 100)
const URL_ = process.env.SCRATCH_HOST_DATABASE_URL || `postgres://leszyrun:leszyrun@127.0.0.1:${SCRATCH_PORT}/leszyrun`
const u = new URL(URL_)
const isScratch = ['127.0.0.1', 'localhost'].includes(u.hostname) && u.port === SCRATCH_PORT

let sql, db, reachable = false
// Fixtures count days from the same Warsaw cutoff the purge uses, so the test does not flake near midnight UTC.
const dayFromCutoff = (offset) => {
  const [y, m, d] = cutoffDate().split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + offset)).toISOString().slice(0, 10)
}
const made = { events: [], participants: [] }

before(async () => {
  if (!isScratch) return
  const probe = postgres(URL_, { max: 1, connect_timeout: 2, onnotice: () => {} })
  try { await probe`select 1`; reachable = true } catch { reachable = false } finally { await probe.end({ timeout: 1 }) }
  if (!reachable) return
  sql = postgres(URL_, { max: 2, onnotice: () => {} })
  db = drizzle(sql, { schema })
  await migrate(db, { migrationsFolder: join(dirname(fileURLToPath(import.meta.url)), '../src/db/migrations') })
})
after(async () => {
  if (!reachable) return
  if (made.participants.length) await db.delete(schema.participants).where(inArray(schema.participants.id, made.participants))
  if (made.events.length) await db.delete(schema.events).where(inArray(schema.events.id, made.events))
  await sql.end({ timeout: 1 })
})

/** daysFromCutoff: 0 = exactly 30 days ago (due), 1 = 29 days ago (not due), -1 = 31 days ago. */
async function seed(daysAgo) {
  const [ev] = await db.insert(schema.events).values({ name: `purge ${daysAgo}`, slug: `purge-${crypto.randomUUID()}`, date: dayFromCutoff(daysAgo) }).returning()
  made.events.push(ev.id)
  const mk = async (registrationId) => {
    const [p] = await db.insert(schema.participants).values({
      eventId: ev.id, firstName: 'Ola', lastName: 'Leśna', email: 'o@x.test', phone: '600100200', registrationId,
    }).returning()
    made.participants.push(p.id)
    return p.id
  }
  return { viaRegistration: await mk(crypto.randomUUID()), manual: await mk(null) }
}
const phoneOf = async (id) => (await db.select({ phone: schema.participants.phone }).from(schema.participants).where(eq(schema.participants.id, id)))[0].phone

test('W-44 the cutoff is Warsaw today minus 30 days', () => {
  assert.equal(cutoffDate(new Date('2026-11-30T12:00:00Z')), '2026-10-31')
  assert.equal(cutoffDate(new Date('2026-11-30T23:30:00Z')), '2026-11-01') // already 1 Dec in Warsaw
})

test('W-44 a dry run changes nothing and reports the count; --apply nulls only registration participants of due events', { skip: !isScratch }, async (t) => {
  if (!reachable) return t.skip(`no scratch Postgres on 127.0.0.1:${SCRATCH_PORT}`)
  const old = await seed(-1)
  const boundary = await seed(0)
  const recent = await seed(1)

  const dry = await purgeRegistrationContact(db)
  assert.equal(dry.applied, false)
  assert.ok(dry.count >= 2, `the two due registration participants are counted, got ${dry.count}`)
  assert.equal(await phoneOf(old.viaRegistration), '600100200')
  assert.equal(await phoneOf(boundary.viaRegistration), '600100200')

  await purgeRegistrationContact(db, { apply: true })
  assert.equal(await phoneOf(old.viaRegistration), null)
  assert.equal(await phoneOf(boundary.viaRegistration), null, 'exactly 30 days ago is purged')
  assert.equal(await phoneOf(old.manual), '600100200', 'a participant with no registration is untouched')
  assert.equal(await phoneOf(boundary.manual), '600100200')
  assert.equal(await phoneOf(recent.viaRegistration), '600100200', 'an event 29 days ago is untouched')

  await purgeRegistrationContact(db, { apply: true })
  assert.equal(await phoneOf(recent.viaRegistration), '600100200', 'a second run changes nothing more')
  assert.equal(await phoneOf(old.viaRegistration), null)
})
