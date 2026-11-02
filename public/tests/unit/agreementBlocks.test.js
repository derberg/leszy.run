import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { agreementSections, draftNoteSegments } from '../../src/lib/agreementBlocks.js'
import { organizerAgreement } from '../../src/legal/organizerAgreement.js'

describe('agreementSections', () => {
  it('splits headings, points, sub-points and continuations', () => {
    const body = [
      'Wstęp.',
      '§1. Strony',
      'Lead-in:',
      '1. Pierwszy.',
      'a) litera,',
      'b) druga.',
      'Ciąg dalszy punktu.',
      '§2. Inne',
      '1. Coś.',
    ].join('\n\n')
    const { preamble, sections } = agreementSections(body)
    assert.deepEqual(preamble, [{ kind: 'p', text: 'Wstęp.' }])
    assert.equal(sections.length, 2)
    assert.deepEqual(sections[0], {
      number: '§1',
      title: 'Strony',
      blocks: [
        { kind: 'p', text: 'Lead-in:' },
        { kind: 'point', marker: '1.', text: 'Pierwszy.' },
        { kind: 'sub', marker: 'a)', text: 'litera,' },
        { kind: 'sub', marker: 'b)', text: 'druga.' },
        { kind: 'cont', text: 'Ciąg dalszy punktu.' },
      ],
    })
    assert.equal(sections[1].number, '§2')
  })

  it('reads the real agreement into all fourteen sections', () => {
    const { sections } = agreementSections(organizerAgreement.body)
    assert.equal(sections.length, 14)
    assert.equal(sections[13].number, '§14')
  })
})

describe('draftNoteSegments', () => {
  it('sets drafting notes apart from the wording', () => {
    assert.deepEqual(draftNoteSegments('Tekst. [DO UZUPEŁNIENIA: x] Dalej.'), [
      { note: false, text: 'Tekst. ' },
      { note: true, text: '[DO UZUPEŁNIENIA: x]' },
      { note: false, text: ' Dalej.' },
    ])
  })
})
