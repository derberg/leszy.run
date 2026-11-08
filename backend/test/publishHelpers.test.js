import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ogSlugsToGenerate, stampPublish } from '../scripts/lib/publishHelpers.js'

// publish-event-pages.js used to decide which OG images to redraw by looking at
// public/public/kalendarz/<slug>/og.png in the checkout. The images now live in
// the calendar-og bucket, so "missing" means "not listed in the bucket", and a
// run must still draw only new, changed and missing images.

test('only new, changed and missing images are drawn', () => {
  const out = ogSlugsToGenerate({
    newSlugs: ['new', 'changed', 'same', 'same-no-image'],
    added: ['new'],
    changed: ['changed'],
    existingOg: new Set(['changed', 'same', 'removed']),
    regenOg: false,
  })
  assert.deepEqual(out, ['new', 'changed', 'same-no-image'])
})

test('--regen-og draws every event', () => {
  const out = ogSlugsToGenerate({
    newSlugs: ['a', 'b'], added: [], changed: [], existingOg: new Set(['a', 'b']), regenOg: true,
  })
  assert.deepEqual(out, ['a', 'b'])
})

test('stampPublish writes public/data-version.json in a checkout', () => {
  const root = mkdtempSync(join(tmpdir(), 'repo-'))
  mkdirSync(join(root, 'public'))
  writeFileSync(join(root, 'public/package.json'), '{}')
  const file = stampPublish(root, 'events', 1, new Date('2026-11-04T10:00:00Z'))
  assert.equal(file, join(root, 'public/data-version.json'))
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf-8')), { events: { publishedAt: '2026-11-04T10:00:00.000Z', count: 1 } })
  rmSync(root, { recursive: true })
})

test('stampPublish skips where there is no public app (the scheduler backend container)', () => {
  const root = mkdtempSync(join(tmpdir(), 'container-'))
  assert.equal(stampPublish(root, 'listy', 745), null)
  assert.ok(!existsSync(join(root, 'public/data-version.json')))
  rmSync(root, { recursive: true })
})
