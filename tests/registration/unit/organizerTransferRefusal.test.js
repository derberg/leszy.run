import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { organizerTransferRefusal } from '../../../supabase/functions/_shared/registration/transfers.js'

// organizer-entry-action `transfer` (Plan 7, 9b review): every 422 carries `fields`, so
// TransferDialog marks the field; a 409 carries none and reads by the button.
describe('organizerTransferRefusal', () => {
  it('invalid_email → 422 naming the e-mail field', () => {
    assert.deepEqual(organizerTransferRefusal('invalid_email'), {
      status: 422, body: { error: 'Podaj poprawny adres e-mail.', code: 'invalid_email', fields: { email: 'Podaj poprawny adres e-mail.' } },
    })
  })
  it('every 422 carries fields, an empty set when the RPC names no field', () => {
    for (const code of ['invalid_person', 'consents_required', 'invalid_kind', 'invalid_token']) {
      const r = organizerTransferRefusal(code)
      assert.equal(r.status, 422, code)
      assert.ok(r.body.fields && typeof r.body.fields === 'object', code)
    }
  })
  it('a 409 keeps the organizer\'s wording and no fields', () => {
    assert.deepEqual(organizerTransferRefusal('recipient_minor'), {
      status: 409, body: { error: 'Pakiet może przejąć tylko osoba pełnoletnia.', code: 'recipient_minor' },
    })
  })
  it('an unknown code → null (the caller throws, a 500)', () => assert.equal(organizerTransferRefusal('nope'), null))
})
