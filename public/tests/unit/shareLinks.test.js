import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { shareLinks, signedUpShareText, signedUpShareUrl, storyImagePath } from '../../src/lib/shareLinks.js'

describe('shareLinks („Pochwal się”)', () => {
  const url = signedUpShareUrl('bieg-leszego')
  const text = signedUpShareText('Bieg Leszego & przyjaciół', '6 grudnia 2026')

  it('the shared address is the event page with ?z=1, nothing about the person', () => {
    assert.equal(url, 'https://www.leszy.run/events/bieg-leszego?z=1')
    assert.equal(text, 'Jestem na liście startowej: Bieg Leszego & przyjaciół (6 grudnia 2026)! Zapisz się też 👉')
    assert.equal(signedUpShareText('X', null), 'Jestem na liście startowej: X! Zapisz się też 👉')
  })

  it('Facebook gets the address only, WhatsApp the text and the address', () => {
    const links = shareLinks({ url, text })
    assert.deepEqual(links.map((l) => l.id), ['facebook', 'whatsapp'])
    assert.equal(new URL(links[0].href).searchParams.get('u'), url)
    assert.equal(new URL(links[1].href).searchParams.get('text'), `${text} ${url}`)
  })

  it('the story image is the event-og variant', () => {
    assert.equal(storyImagePath('bieg-leszego'), '/api/event-og?slug=bieg-leszego&v=story')
  })
})
