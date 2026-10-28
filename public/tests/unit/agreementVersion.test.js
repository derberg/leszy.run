import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')

test('the agreement text and the edge function name the same version', () => {
  const edge = read('../../../supabase/functions/_shared/organizer.js').match(/ORGANIZER_AGREEMENT_VERSION\s*=\s*'([^']+)'/)
  const page = read('../../src/legal/organizerAgreement.js').match(/version:\s*'([^']+)'/)
  assert.ok(edge && page, 'both version strings found')
  assert.equal(page[1], edge[1])
})
