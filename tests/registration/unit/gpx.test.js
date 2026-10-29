import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseGpx, GpxError } from '../../../supabase/functions/_shared/registration/gpx.js'

const fx = (n) => readFileSync(new URL(`../fixtures/gpx/${n}`, import.meta.url), 'utf8')

test('W-04 loop-9km distance and downsampling', () => {
  const r = parseGpx(fx('loop-9km.gpx'))
  assert.ok(Math.abs(r.km - 9.1) < 0.1, `km ${r.km}`)
  assert.ok(r.points.length <= 500)
  assert.ok(r.profile.length <= 200)
  assert.ok(r.bounds)
})

test('W-04 noisy-climb hysteresis', () => {
  const r = parseGpx(fx('noisy-climb.gpx'))
  assert.ok(Math.abs(r.upM - 100) <= 3, `up ${r.upM}`)
  assert.ok(Math.abs(r.downM - 100) <= 3, `down ${r.downM}`)
})

test('W-04 route-only parses rtept', () => {
  const r = parseGpx(fx('route-only.gpx'))
  assert.equal(r.points.length, 5)
  assert.ok(r.km > 0.4 && r.km < 0.5)
})

test('W-04 errors', () => {
  assert.throws(() => parseGpx(fx('not-gpx.kml')), (e) => e instanceof GpxError && e.message === 'To nie jest plik GPX.')
  assert.throws(
    () => parseGpx('<gpx><trk><trkseg><trkpt lat="50" lon="19"/></trkseg></trk></gpx>'),
    (e) => e instanceof GpxError && e.message === 'Plik GPX nie zawiera trasy.',
  )
})

test('large track is downsampled', () => {
  let p = ''
  for (let i = 0; i < 3000; i++) p += `<trkpt lat="${(50 + i * 0.0001).toFixed(6)}" lon="19"><ele>${200 + (i % 50)}</ele></trkpt>`
  const r = parseGpx(`<gpx><trk><trkseg>${p}</trkseg></trk></gpx>`)
  assert.ok(r.points.length <= 500)
  assert.ok(r.profile.length <= 200)
})
