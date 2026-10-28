import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { trackedPath } from '../../src/lib/trackedPath.js'

describe('trackedPath (what GA sees)', () => {
  it('a magic login link never sends the address or the code', () => {
    assert.equal(trackedPath('/login', '?email=ola%40x.pl&code=123456&from=%2Fprofil'), '/login?from=%2Fprofil')
    assert.equal(trackedPath('/login', '?email=ola%40x.pl&code=123456'), '/login')
  })

  it('the searched bib stays out, other parameters stay in', () => {
    assert.equal(trackedPath('/events/x/results', '?nr=12&kategoria=k'), '/events/x/results?kategoria=k')
    assert.equal(trackedPath('/kalendarz', ''), '/kalendarz')
  })
})
