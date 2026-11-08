import { test } from 'node:test'
import assert from 'node:assert/strict'
import { carryFormerSlugs, redirectStubs, buildRedirectHtml } from '../../scripts/lib/formerSlugs.js'

const entry = (id, name, date, extra = {}) => ({ id, name, date, ...extra })

test('a moved race keeps its old address as a former slug', () => {
  const prev = { 'rozbiegani-w-gminie-kluki-2026-09-27': entry('a', 'Rozbiegani w Gminie Kluki', '2026-09-27') }
  const next = { 'rozbiegani-w-gminie-kluki-2026-11-08': entry('a', 'Rozbiegani w Gminie Kluki', '2026-11-08') }
  const changed = carryFormerSlugs(prev, next)
  assert.deepEqual(changed, [{ from: 'rozbiegani-w-gminie-kluki-2026-09-27', to: 'rozbiegani-w-gminie-kluki-2026-11-08' }])
  assert.deepEqual(next['rozbiegani-w-gminie-kluki-2026-11-08'].former_slugs, ['rozbiegani-w-gminie-kluki-2026-09-27'])
})

test('former slugs are carried forward run after run, and a second move adds to them', () => {
  const prev = { 'x-2027-04-25': entry('a', 'X', '2027-04-25', { former_slugs: ['x-2027-03-25'] }) }
  const same = { 'x-2027-04-25': entry('a', 'X', '2027-04-25') }
  assert.deepEqual(carryFormerSlugs(prev, same), [])
  assert.deepEqual(same['x-2027-04-25'].former_slugs, ['x-2027-03-25'])
  const moved = { 'x-2027-05-02': entry('a', 'X', '2027-05-02') }
  carryFormerSlugs(prev, moved)
  assert.deepEqual(moved['x-2027-05-02'].former_slugs, ['x-2027-03-25', 'x-2027-04-25'])
})

test('a move back to an old address drops it from the former slugs', () => {
  const prev = { 'x-2027-04-25': entry('a', 'X', '2027-04-25', { former_slugs: ['x-2027-03-25'] }) }
  const next = { 'x-2027-03-25': entry('a', 'X', '2027-03-25') }
  carryFormerSlugs(prev, next)
  assert.deepEqual(next['x-2027-03-25'].former_slugs, ['x-2027-04-25'])
})

test('a former address that is another live page is never kept; untouched entries get no key', () => {
  const prev = { 'x-2027-03-25': entry('a', 'X', '2027-03-25'), 'y-2027-01-01': entry('b', 'Y', '2027-01-01') }
  const next = { 'x-2027-04-25': entry('a', 'X', '2027-04-25'), 'x-2027-03-25': entry('c', 'X', '2027-03-25'), 'y-2027-01-01': entry('b', 'Y', '2027-01-01') }
  carryFormerSlugs(prev, next)
  assert.equal(next['x-2027-04-25'].former_slugs, undefined)
  assert.equal('former_slugs' in next['y-2027-01-01'], false)
})

test('an event that is gone leaves no redirect, and a first publish has nothing to carry', () => {
  const next = { 'z-2027-01-01': entry('z', 'Z', '2027-01-01') }
  assert.deepEqual(carryFormerSlugs({ 'gone-2026-01-01': entry('g', 'Gone', '2026-01-01') }, next), [])
  assert.deepEqual(carryFormerSlugs(null, next), [])
})

test('redirect stubs: one per former address, never over a live page, never twice', () => {
  const manifest = {
    'x-2027-04-25': entry('a', 'X', '2027-04-25', { former_slugs: ['x-2027-03-25', 'live-2027-01-01'] }),
    'x2-2027-04-25': entry('b', 'X', '2027-04-25', { former_slugs: ['x-2027-03-25'] }),
    'live-2027-01-01': entry('c', 'Live', '2027-01-01'),
  }
  assert.deepEqual(redirectStubs(manifest).map(s => [s.slug, s.target]), [['x-2027-03-25', 'x-2027-04-25']])
})

test('the stub points canonical, refresh and script at the new address, with the name escaped', () => {
  const html = buildRedirectHtml({ name: 'Bieg "<Kluki>"' }, 'k-2026-11-08', 'https://www.leszy.run')
  assert.match(html, /<link rel="canonical" href="https:\/\/www\.leszy\.run\/kalendarz\/k-2026-11-08" \/>/)
  assert.match(html, /http-equiv="refresh" content="0; url=https:\/\/www\.leszy\.run\/kalendarz\/k-2026-11-08"/)
  assert.match(html, /window\.location\.replace\("https:\/\/www\.leszy\.run\/kalendarz\/k-2026-11-08"\)/)
  assert.ok(html.includes('Bieg &quot;&lt;Kluki&gt;&quot;'))
})
