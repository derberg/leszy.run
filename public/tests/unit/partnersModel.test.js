import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { initials, linkHost, moveId, partnerForm, partnerOptionLabel, partnerRequest } from '../../src/lib/partnersModel.js'
import { LOGO_LIMIT_BYTES, dataUrlBytes, logoResize, logoSize } from '../../src/lib/logoResize.js'

// The wizard's „Partnerzy” (event partners step): the dialog's form as organizer-partners takes
// it, the list row's pieces, the order buttons, and the logo as upload-partner-logo takes it.

describe('partnerRequest', () => {
  it('trims every text field and keeps the public switch', () => {
    assert.deepEqual(partnerRequest({ name: '  Sklep Biegacz ', note: ' umowa do grudnia ', websiteUrl: ' https://sklep.pl ', isPublic: false }),
      { name: 'Sklep Biegacz', note: 'umowa do grudnia', websiteUrl: 'https://sklep.pl', isPublic: false })
  })
  it('an empty or blank field goes as null, so the server clears it (and names a blank name)', () => {
    assert.deepEqual(partnerRequest({ name: '   ', note: '', websiteUrl: '  ', isPublic: true }),
      { name: null, note: null, websiteUrl: null, isPublic: true })
  })
  it('missing fields read as empty, the switch as on', () => {
    assert.deepEqual(partnerRequest({}), { name: null, note: null, websiteUrl: null, isPublic: true })
  })
  it('an address without a scheme goes as typed: the server answers 422 under the field', () => {
    assert.equal(partnerRequest({ name: 'X', websiteUrl: 'sklep.pl' }).websiteUrl, 'sklep.pl')
  })
})

describe('partnerForm', () => {
  it('a new partner starts empty and shown on the event page', () => {
    assert.deepEqual(partnerForm(null), { name: '', note: '', websiteUrl: '', isPublic: true })
  })
  it('an existing one starts from its values, nulls as empty', () => {
    assert.deepEqual(partnerForm({ name: 'Radio', note: null, websiteUrl: 'https://radio.pl', isPublic: false }),
      { name: 'Radio', note: '', websiteUrl: 'https://radio.pl', isPublic: false })
  })
})

describe('the list row', () => {
  it('linkHost: the host without www, null for no or a broken address', () => {
    assert.equal(linkHost('https://www.sklep-biegacz.pl/promo?x=1'), 'sklep-biegacz.pl')
    assert.equal(linkHost('http://radio.pl'), 'radio.pl')
    assert.equal(linkHost(null), null)
    assert.equal(linkHost('nie adres'), null)
  })
  it('initials: up to two letters of the first two words, upper case', () => {
    assert.equal(initials('Sklep Biegacz'), 'SB')
    assert.equal(initials('radio'), 'R')
    assert.equal(initials('Stowarzyszenie Biegaczy Ziemi Gliwickiej'), 'SB')
    assert.equal(initials('„Łódzki” klub'), 'ŁK')
    assert.equal(initials('  '), '?')
  })
  it('partnerOptionLabel: a hidden partner reads „(ukryty)” in the code dialog', () => {
    assert.equal(partnerOptionLabel({ name: 'Sklep', isPublic: true }), 'Sklep')
    assert.equal(partnerOptionLabel({ name: 'Hurtownia', isPublic: false }), 'Hurtownia (ukryty)')
  })
})

describe('moveId (↑ ↓)', () => {
  const ids = ['a', 'b', 'c']
  it('swaps with the neighbour and returns every id once', () => {
    assert.deepEqual(moveId(ids, 'b', -1), ['b', 'a', 'c'])
    assert.deepEqual(moveId(ids, 'b', 1), ['a', 'c', 'b'])
    assert.deepEqual(ids, ['a', 'b', 'c'], 'the input is not changed')
  })
  it('null at either end or for an unknown id: nothing to send', () => {
    assert.equal(moveId(ids, 'a', -1), null)
    assert.equal(moveId(ids, 'c', 1), null)
    assert.equal(moveId(ids, 'x', 1), null)
  })
})

/** A canvas that records what was drawn and answers toDataURL with a payload of a chosen size. */
function fakeCanvas(log, sizes) {
  return (width, height) => {
    const canvas = {
      width, height,
      getContext: () => ({
        set fillStyle(v) { log.push(['fillStyle', v]) },
        fillRect: (...a) => log.push(['fillRect', ...a]),
        clearRect: (...a) => log.push(['clearRect', ...a]),
        drawImage: (_img, ...a) => log.push(['drawImage', ...a]),
      }),
      toDataURL: (type, quality) => {
        log.push(['toDataURL', type, quality])
        const bytes = sizes[type] ?? 100
        return `data:${type};base64,${'A'.repeat(Math.ceil(bytes / 3) * 4)}`
      },
    }
    log.push(['canvas', width, height])
    return canvas
  }
}

const file = (type) => ({ name: 'logo', type })
const bitmap = (width, height) => ({ width, height, close() {} })

describe('logoSize', () => {
  it('fits inside 800×800 keeping the aspect, never enlarging', () => {
    assert.deepEqual(logoSize(1600, 400), { width: 800, height: 200 })
    assert.deepEqual(logoSize(300, 1200), { width: 200, height: 800 })
    assert.deepEqual(logoSize(2000, 2000), { width: 800, height: 800 })
    assert.deepEqual(logoSize(120, 60), { width: 120, height: 60 })
  })
})

describe('dataUrlBytes', () => {
  it('counts the decoded bytes of a base64 payload, padding included', () => {
    assert.equal(dataUrlBytes(`data:image/png;base64,${Buffer.from('abcd').toString('base64')}`), 4)
    assert.equal(dataUrlBytes(`data:image/png;base64,${Buffer.from('abcde').toString('base64')}`), 5)
    assert.equal(dataUrlBytes(`data:image/png;base64,${Buffer.from('abcdef').toString('base64')}`), 6)
  })
})

describe('logoResize', () => {
  it('a 1600×400 WebP becomes an 800×200 PNG data URL: WebP never reaches the server', async () => {
    const log = []
    const url = await logoResize(file('image/webp'), { decode: async () => bitmap(1600, 400), createCanvas: fakeCanvas(log, {}) })
    assert.match(url, /^data:image\/png;base64,/)
    assert.deepEqual(log.find((l) => l[0] === 'canvas'), ['canvas', 800, 200])
    assert.deepEqual(log.find((l) => l[0] === 'drawImage'), ['drawImage', 0, 0, 800, 200])
    assert.deepEqual(log.filter((l) => l[0] === 'toDataURL'), [['toDataURL', 'image/png', undefined]])
    assert.ok(!log.some((l) => l[0] === 'fillRect'), 'a PNG keeps its transparency')
  })
  it('PNG and JPEG are accepted the same way, a small one is not enlarged', async () => {
    for (const type of ['image/png', 'image/jpeg']) {
      const log = []
      await logoResize(file(type), { decode: async () => bitmap(120, 60), createCanvas: fakeCanvas(log, {}) })
      assert.deepEqual(log.find((l) => l[0] === 'canvas'), ['canvas', 120, 60])
    }
  })
  it('a PNG over 2 MB falls back to JPEG at 0.9, on white (JPEG has no alpha)', async () => {
    const log = []
    const url = await logoResize(file('image/png'), {
      decode: async () => bitmap(800, 800), createCanvas: fakeCanvas(log, { 'image/png': LOGO_LIMIT_BYTES + 1, 'image/jpeg': 300_000 }),
    })
    assert.match(url, /^data:image\/jpeg;base64,/)
    assert.deepEqual(log.filter((l) => l[0] === 'toDataURL'), [['toDataURL', 'image/png', undefined], ['toDataURL', 'image/jpeg', 0.9]])
    const white = log.findIndex((l) => l[0] === 'fillStyle' && l[1] === '#ffffff')
    assert.ok(white > log.findIndex((l) => l[0] === 'toDataURL'), 'the white fill comes after the PNG try')
    assert.ok(log.findLastIndex((l) => l[0] === 'drawImage') > white, 'the image is redrawn over it')
  })
  it('a PNG of exactly 2 MB stays PNG', async () => {
    const url = await logoResize(file('image/png'), {
      decode: async () => bitmap(800, 800), createCanvas: fakeCanvas([], { 'image/png': LOGO_LIMIT_BYTES - 2 }),
    })
    assert.match(url, /^data:image\/png;/)
  })
  it('still over 2 MB as JPEG → „Plik jest za duży (limit 2 MB).”', async () => {
    await assert.rejects(logoResize(file('image/png'), {
      decode: async () => bitmap(800, 800), createCanvas: fakeCanvas([], { 'image/png': LOGO_LIMIT_BYTES + 10, 'image/jpeg': LOGO_LIMIT_BYTES + 10 }),
    }), { message: 'Plik jest za duży (limit 2 MB).' })
  })
  it('SVG, GIF or no type → „Dozwolone: PNG, JPG, WebP.” before anything is decoded', async () => {
    for (const type of ['image/svg+xml', 'image/gif', '', undefined]) {
      let decoded = false
      await assert.rejects(logoResize(file(type), { decode: async () => { decoded = true; return bitmap(1, 1) }, createCanvas: fakeCanvas([], {}) }),
        { message: 'Dozwolone: PNG, JPG, WebP.' })
      assert.equal(decoded, false, String(type))
    }
  })
  it('a file the browser cannot decode → „Nie udało się odczytać obrazu.”', async () => {
    await assert.rejects(logoResize(file('image/png'), { decode: async () => { throw new Error('bad') }, createCanvas: fakeCanvas([], {}) }),
      { message: 'Nie udało się odczytać obrazu.' })
  })
})
