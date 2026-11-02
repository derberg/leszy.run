// „Widoczność: Tylko przez link” (W-83, W-85): an unlisted event is kept off every listing and its
// pages carry noindex, while every page reached by its address keeps working.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { LISTED_VISIBILITY, isUnlistedEvent, isUnlistedRegistration } from '../../src/lib/eventListing.js'

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')

describe('eventListing (W-85)', () => {
  it('an events row is unlisted only when its visibility says so', () => {
    assert.equal(isUnlistedEvent({ visibility: 'unlisted' }), true)
    assert.equal(isUnlistedEvent({ visibility: 'public' }), false)
    assert.equal(isUnlistedEvent({ visibility: 'private' }), false)
    assert.equal(isUnlistedEvent(null), false)
  })

  it('a registration snapshot is unlisted only when it says listed: false', () => {
    assert.equal(isUnlistedRegistration({ listed: false }), true)
    assert.equal(isUnlistedRegistration({ listed: true }), false)
    // The organizer's preview reads registration_raw, which carries no `listed`.
    assert.equal(isUnlistedRegistration({}), false)
    assert.equal(isUnlistedRegistration(null), false)
  })
})

describe('every public listing of leszy.run events filters the listed visibility (W-83)', () => {
  const LISTINGS = [
    ['src/pages/Landing.jsx', 2],
    ['src/pages/Home.jsx', 1],
    ['src/components/LeszyrunBanner.jsx', 1],
    ['../backend/scripts/publish-leszyrun-events.js', 1],
  ]
  for (const [file, count] of LISTINGS) {
    it(`${file} reads events only with visibility = '${LISTED_VISIBILITY}'`, () => {
      const src = read(file)
      const reads = src.match(/from\('events'\)/g) ?? []
      const filtered = src.match(/\.eq\('visibility', 'public'\)/g) ?? []
      assert.equal(reads.length, count, 'a new events read here needs the same filter')
      assert.equal(filtered.length, count)
    })
  }

  it('the event pages that are indexable carry noindex for an unlisted event', () => {
    for (const file of ['src/pages/zapisy/RegistrationEventPage.jsx', 'src/pages/zapisy/Trasa.jsx']) {
      assert.match(read(file), /isUnlistedRegistration\(raw\)/, file)
    }
    for (const file of ['src/pages/Results.jsx', 'src/pages/EventHub.jsx']) {
      assert.match(read(file), /isUnlistedEvent\(/, file)
    }
  })
})
