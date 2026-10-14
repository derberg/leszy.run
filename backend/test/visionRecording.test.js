import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, writeFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import Fastify from 'fastify'
import { readRecording, writeRecording, RECORDING_FILE } from '../src/vision/recording.js'
import { healthVerdict } from '../src/vision/ingest.js'
import { visionRoutes } from '../src/routes/vision.js'

// capture.py reads this file once a second and stops writing frames while it
// says {"recording": false}. Both sides must agree on what every other content
// means, and the agreed answer is "record".

async function queueDir() {
  return mkdtemp(path.join(tmpdir(), 'vision-rec-'))
}

test('no switch file means recording', async () => {
  const dir = await queueDir()
  assert.deepEqual(await readRecording(dir), { recording: true, changedAt: null })
  await rm(dir, { recursive: true })
})

test('a pause is written as JSON capture.py understands, and read back', async () => {
  const dir = await queueDir()
  const written = await writeRecording(dir, false)
  assert.equal(written.recording, false)
  const raw = JSON.parse(await readFile(path.join(dir, RECORDING_FILE), 'utf8'))
  assert.equal(raw.recording, false)
  assert.ok(!Number.isNaN(Date.parse(raw.changed_at)))
  assert.deepEqual(await readRecording(dir), written)
  await rm(dir, { recursive: true })
})

test('the write leaves no temporary file behind', async () => {
  const dir = await queueDir()
  await writeRecording(dir, false)
  await writeRecording(dir, true)
  assert.deepEqual(await readdir(dir), [RECORDING_FILE])
  await rm(dir, { recursive: true })
})

test('a malformed switch file reads as recording, as capture.py treats it', async () => {
  const dir = await queueDir()
  await writeFile(path.join(dir, RECORDING_FILE), '{not json')
  assert.equal((await readRecording(dir)).recording, true)
  await writeFile(path.join(dir, RECORDING_FILE), '{"recording":"no"}')
  assert.equal((await readRecording(dir)).recording, true)
  await rm(dir, { recursive: true })
})

// ─── the verdict while paused ───────────────────────────────────────────────

const health = (over = {}) => ({
  capture_alive: true, keeping_up: true, clock_synced: true,
  exposure: 'ok', torn_frames: 0, ordering_anomalies: [],
  pending: 0, updated_at: Date.now() / 1000, ...over,
})

test('a paused camera is a warning, not a dead camera', () => {
  // Paused, capture writes no frames, so the reader reports capture_alive
  // false. That is the switch working, not a cable to go and check.
  const v = healthVerdict(health({ capture_alive: false }), { recording: false })
  assert.equal(v.level, 'warn')
  assert.match(v.headline, /wstrzymane/i)
})

test('an unsynced clock still outranks the pause', () => {
  const v = healthVerdict(health({ capture_alive: false, clock_synced: false }), { recording: false })
  assert.equal(v.level, 'error')
})

test('a dead reader still outranks the pause', () => {
  const v = healthVerdict(health({ updated_at: Date.now() / 1000 - 120 }), { recording: false })
  assert.equal(v.level, 'error')
})

// ─── the routes ─────────────────────────────────────────────────────────────

function appFor(session) {
  // The recording routes make one query: the session by id.
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: async () => (session ? [session] : []),
  }
  const app = Fastify()
  app.decorate('db', { select: () => chain })
  app.register(visionRoutes, { prefix: '/api' })
  return app
}

test('GET reports the file on disk', async () => {
  const dir = await queueDir()
  await writeRecording(dir, false)
  const app = appFor({ id: 's1', queueDir: dir })
  const res = await app.inject({ method: 'GET', url: '/api/vision/sessions/s1/recording' })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().data.recording, false)
  await app.close()
  await rm(dir, { recursive: true })
})

test('PUT pauses and resumes', async () => {
  const dir = await queueDir()
  const app = appFor({ id: 's1', queueDir: dir })
  let res = await app.inject({
    method: 'PUT', url: '/api/vision/sessions/s1/recording', payload: { recording: false },
  })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().data.recording, false)
  assert.equal((await readRecording(dir)).recording, false)

  res = await app.inject({
    method: 'PUT', url: '/api/vision/sessions/s1/recording', payload: { recording: true },
  })
  assert.equal(res.json().data.recording, true)
  assert.equal((await readRecording(dir)).recording, true)
  await app.close()
  await rm(dir, { recursive: true })
})

test('PUT refuses anything but a boolean', async () => {
  const dir = await queueDir()
  const app = appFor({ id: 's1', queueDir: dir })
  const res = await app.inject({
    method: 'PUT', url: '/api/vision/sessions/s1/recording', payload: { recording: 'off' },
  })
  assert.equal(res.statusCode, 400)
  assert.ok(res.json().error)
  assert.equal((await readRecording(dir)).changedAt, null)
  await app.close()
  await rm(dir, { recursive: true })
})

test('PUT on a queue directory that is gone is an error, not a silent no-op', async () => {
  const app = appFor({ id: 's1', queueDir: path.join(tmpdir(), 'no-such-vision-queue') })
  const res = await app.inject({
    method: 'PUT', url: '/api/vision/sessions/s1/recording', payload: { recording: false },
  })
  assert.equal(res.statusCode, 409)
  assert.ok(res.json().error)
  await app.close()
})

test('an unknown session is a 404', async () => {
  const app = appFor(null)
  const res = await app.inject({ method: 'GET', url: '/api/vision/sessions/x/recording' })
  assert.equal(res.statusCode, 404)
  await app.close()
})
