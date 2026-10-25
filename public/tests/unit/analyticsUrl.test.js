import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { cleanSearch, cleanLocation } from '../../src/lib/analyticsUrl.js'

describe('analyticsUrl', () => {
  it('drops every private parameter and keeps the rest', () => {
    assert.equal(cleanSearch('?p=abc&t=tok&pin=123&email=a%40b.pl&code=1&nr=12&from=x'), '?from=x')
    assert.equal(cleanSearch('?checkpoint=cp&pin=1234567890'), '?checkpoint=cp')
    assert.equal(cleanSearch(''), '')
  })

  it('cleanLocation removes them from a full address and drops the hash', () => {
    assert.equal(
      cleanLocation('https://www.leszy.run/events/x/checkin?p=id&t=token#top'),
      'https://www.leszy.run/events/x/checkin',
    )
  })
})
