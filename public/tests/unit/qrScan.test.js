import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { participantIdFromQr, isRepeatScan } from '../../src/lib/qrScan.js'

const ID = '3f2b9c1e-8d4a-4b7e-9f10-2a6c5d8e7b01'

describe('participantIdFromQr', () => {
  it('reads the id from the check-in link', () => {
    assert.equal(participantIdFromQr(`https://www.leszy.run/events/wilczy/admin/checkin?p=${ID}`), ID)
  })

  it('accepts a bare participant id', () => {
    assert.equal(participantIdFromQr(`  ${ID}\n`), ID)
  })

  it('returns null for a link without the participant parameter', () => {
    assert.equal(participantIdFromQr('https://example.com/menu'), null)
  })

  it('returns null for text that is not an id', () => {
    assert.equal(participantIdFromQr('WIFI:S:biuro;T:WPA;P:haslo;;'), null)
    assert.equal(participantIdFromQr(''), null)
  })
})

describe('isRepeatScan', () => {
  it('ignores the same code inside the cooldown', () => {
    assert.equal(isRepeatScan({ text: 'a', at: 1000 }, 'a', 3000), true)
  })

  it('accepts the same code after the cooldown', () => {
    assert.equal(isRepeatScan({ text: 'a', at: 1000 }, 'a', 4001), false)
  })

  it('accepts a different code at once', () => {
    assert.equal(isRepeatScan({ text: 'a', at: 1000 }, 'b', 1001), false)
    assert.equal(isRepeatScan(null, 'a', 0), false)
  })
})
