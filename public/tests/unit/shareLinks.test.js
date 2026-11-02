import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { shareLinks } from '../../src/lib/shareLinks.js'

describe('shareLinks („Udostępnij”)', () => {
  it('every network gets the event page, encoded', () => {
    const links = shareLinks({ url: 'https://www.leszy.run/events/bieg-leszego', text: 'Zapisy: Bieg Leszego & przyjaciół' })
    assert.deepEqual(links.map((l) => l.id), ['facebook', 'x', 'whatsapp'])
    const enc = encodeURIComponent('https://www.leszy.run/events/bieg-leszego')
    assert.equal(links[0].href, `https://www.facebook.com/sharer/sharer.php?u=${enc}`)
    assert.ok(links[1].href.startsWith('https://x.com/intent/post?text=Zapisy%3A%20Bieg%20Leszego%20%26%20przyjaci%C3%B3%C5%82&url='))
    assert.ok(links[1].href.endsWith(enc))
    assert.equal(new URL(links[2].href).searchParams.get('text'), 'Zapisy: Bieg Leszego & przyjaciół https://www.leszy.run/events/bieg-leszego')
  })
})
