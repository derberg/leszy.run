import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { cardContent, cardFileName, wrapText, shareMode } from '../../src/lib/checkinCard.js'

const event = { name: 'Nocny Zew Wilka', date: '2026-08-07', location: 'Leszno' }
const participant = { first_name: 'Anna', last_name: 'Kowal', bib_number: 12, emoji: '🦊', tshirt_size: 'M' }

describe('cardContent', () => {
  it('carries name, bib, emoji and T-shirt size onto the card', () => {
    assert.deepEqual(cardContent({ event, participant }), {
      eventName: 'Nocny Zew Wilka',
      eventMeta: '2026-08-07 · Leszno',
      name: 'Anna Kowal',
      bib: '#12',
      emoji: '🦊',
      tshirt: 'Odbierz koszulkę: rozmiar M',
      minor: false,
    })
  })

  it('leaves out what the runner does not have', () => {
    const c = cardContent({ event: { name: 'X', date: '2026-01-01' }, participant: { first_name: 'Jan' } })
    assert.equal(c.eventMeta, '2026-01-01')
    assert.equal(c.bib, '')
    assert.equal(c.emoji, null)
    assert.equal(c.tshirt, null)
  })

  it('keeps bib 0', () => {
    assert.equal(cardContent({ event, participant: { bib_number: 0 } }).bib, '#0')
  })
})

describe('cardFileName', () => {
  it('names the file by bib, falling back to the participant id', () => {
    assert.equal(cardFileName(participant, 'abc'), 'checkin-12.png')
    assert.equal(cardFileName({}, 'abc'), 'checkin-abc.png')
  })
})

describe('wrapText', () => {
  const measure = s => s.length

  it('breaks on whole words', () => {
    assert.deepEqual(wrapText('aaa bbb ccc', 7, measure), ['aaa bbb', 'ccc'])
  })

  it('gives an over-long word its own line instead of cutting it', () => {
    assert.deepEqual(wrapText('a verylongword b', 5, measure), ['a', 'verylongword', 'b'])
  })
})

describe('shareMode', () => {
  const file = { name: 'checkin-12.png' }

  it('shares when the browser can share files', () => {
    assert.equal(shareMode({ share() {}, canShare: () => true }, file), 'share')
  })

  it('downloads when the browser cannot share files', () => {
    assert.equal(shareMode({ share() {}, canShare: () => false }, file), 'download')
    assert.equal(shareMode({ share() {} }, file), 'download')
    assert.equal(shareMode({}, file), 'download')
  })

  it('downloads when canShare throws', () => {
    assert.equal(shareMode({ share() {}, canShare: () => { throw new TypeError() } }, file), 'download')
  })
})
