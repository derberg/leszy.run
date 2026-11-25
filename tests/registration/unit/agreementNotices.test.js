import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AGREEMENT_CHANGES, ORGANIZER_AGREEMENT_VERSION } from '../../../supabase/functions/_shared/organizer.js'
import {
  AGREEMENT_NOTICE_SUBJECT, agreementNoticeEmail, agreementPageUrl,
} from '../../../supabase/functions/_shared/registration/agreementNotices.js'

test('AN-01 AGREEMENT_CHANGES lists what the current version changed (never empty)', () => {
  assert.ok(Array.isArray(AGREEMENT_CHANGES) && AGREEMENT_CHANGES.length > 0)
  for (const c of AGREEMENT_CHANGES) assert.ok(typeof c === 'string' && c.trim().length > 10, c)
  assert.ok(AGREEMENT_CHANGES.some((c) => /7 dni/.test(c)), 'the 7-day objection window is in the list')
})

test('AN-02 the notice e-mail: subject, version, every change, the agreement link from PUBLIC_SITE_URL, the 7-day objection', () => {
  const url = agreementPageUrl('https://www.leszy.run/', 'zatyrani')
  assert.equal(url, 'https://www.leszy.run/klub/zatyrani/wydarzenia/umowa')
  const m = agreementNoticeEmail({ clubName: 'Zatyrani <b>', version: ORGANIZER_AGREEMENT_VERSION, changes: AGREEMENT_CHANGES, url })
  assert.equal(m.subject, AGREEMENT_NOTICE_SUBJECT)
  assert.equal(m.subject, 'Zaktualizowaliśmy umowę organizatora')
  for (const body of [m.text, m.html]) {
    assert.ok(body.includes(ORGANIZER_AGREEMENT_VERSION))
    assert.ok(body.includes(url))
    assert.ok(body.includes('lukasz@leszy.run'))
    assert.ok(body.includes('w ciągu 7 dni'))
    assert.ok(body.includes('opublikowane wydarzenia obsłużymy do końca na dotychczasowych zasadach'))
  }
  for (const c of AGREEMENT_CHANGES) assert.ok(m.text.includes(c))
  assert.ok(!m.html.includes('<b>'), 'the club name is escaped')
})
