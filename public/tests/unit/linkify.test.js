import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { linkParts } from '../../src/lib/linkify.js'

describe('W-72 linkParts: bare http(s) addresses in plain text', () => {
  it('splits text and links, trailing punctuation stays text', () => {
    assert.deepEqual(linkParts('Trasa: https://example.org/trasa. Zapraszamy (http://a.pl/x)!'), [
      { text: 'Trasa: ' }, { href: 'https://example.org/trasa', text: 'https://example.org/trasa' },
      { text: '. Zapraszamy (' }, { href: 'http://a.pl/x', text: 'http://a.pl/x' }, { text: ')!' },
    ])
  })
  it('no address, no link; other schemes and markup stay text', () => {
    assert.deepEqual(linkParts('Bez linku'), [{ text: 'Bez linku' }])
    assert.deepEqual(linkParts('javascript:alert(1) <a href="x">y</a> www.example.org'),
      [{ text: 'javascript:alert(1) <a href="x">y</a> www.example.org' }])
    assert.deepEqual(linkParts(''), [])
  })
  it('a quote or angle bracket ends an address', () => {
    assert.deepEqual(linkParts('"https://e.org/a"<b>'), [{ text: '"' }, { href: 'https://e.org/a', text: 'https://e.org/a' }, { text: '"<b>' }])
  })
})
