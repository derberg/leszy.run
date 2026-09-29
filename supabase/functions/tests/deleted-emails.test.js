import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { hashEmail, isEmailRetired } from '../_shared/deletedEmails.js'

// Pure/stubbed — runs locally, unlike the suites that call a deployed function.

function stubClient(retiredHashes) {
  const calls = []
  return {
    calls,
    from(table) {
      calls.push(table)
      return {
        select() { return this },
        eq(_col, value) { this._value = value; return this },
        async maybeSingle() {
          return { data: retiredHashes.includes(this._value) ? { email_hash: this._value } : null }
        },
      }
    },
  }
}

describe('hashEmail', () => {
  it('normalises case and surrounding space before hashing', async () => {
    const a = await hashEmail('  Jan.Kowalski@Example.PL ')
    const b = await hashEmail('jan.kowalski@example.pl')
    assert.equal(a, b)
  })

  it('is a 64-char hex digest that differs per address', async () => {
    const a = await hashEmail('jan@example.pl')
    const b = await hashEmail('anna@example.pl')
    assert.match(a, /^[0-9a-f]{64}$/)
    assert.notEqual(a, b)
  })

  it('never returns the address itself', async () => {
    const h = await hashEmail('jan@example.pl')
    assert.ok(!h.includes('jan'))
    assert.ok(!h.includes('@'))
  })
})

describe('isEmailRetired', () => {
  it('recognises a retired address whatever case it is typed in', async () => {
    const retired = await hashEmail('jan@example.pl')
    const client = stubClient([retired])
    assert.equal(await isEmailRetired(client, 'JAN@Example.pl'), true)
    assert.equal(client.calls[0], 'deleted_email_hashes')
  })

  it('lets an address that was never deleted through', async () => {
    const client = stubClient([])
    assert.equal(await isEmailRetired(client, 'anna@example.pl'), false)
  })
})
