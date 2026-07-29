import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { callFunction, supabaseAdmin, E2E_MARKER } from './helpers.js'

describe('checkpoint-roster edge function', () => {
  let eventId
  const PIN = '123456'

  before(async () => {
    // Create a throwaway event + one participant + secret (service role bypasses RLS)
    const { data: ev, error: evErr } = await supabaseAdmin.from('events').insert({
      name: `${E2E_MARKER} roster test`, slug: `e2e-roster-${Date.now()}`, visibility: 'private',
    }).select('id').single()
    assert.ifError(evErr)
    eventId = ev.id
    await supabaseAdmin.from('participants').insert({
      event_id: eventId, first_name: 'E2E', last_name: E2E_MARKER,
      bib_number: 9101, rfid_epc: 'AABBCCDD9101',
    })
    await supabaseAdmin.from('participants').insert({
      event_id: eventId, first_name: 'E2E', last_name: E2E_MARKER,
      bib_number: 9102, rfid_epc: null, // no tag — must be excluded from roster
    })
    await supabaseAdmin.from('event_secrets').upsert(
      { event_id: eventId, checkpoint_pin: PIN }, { onConflict: 'event_id' })
  })

  after(async () => {
    await supabaseAdmin.from('event_secrets').delete().eq('event_id', eventId)
    await supabaseAdmin.from('events').delete().eq('id', eventId) // participants cascade
  })

  it('returns roster with correct PIN, only tagged participants, only bib+epc fields', async () => {
    const { status, data } = await callFunction('checkpoint-roster', { event_id: eventId, pin: PIN })
    assert.equal(status, 200)
    assert.equal(data.data.length, 1)
    assert.deepEqual(Object.keys(data.data[0]).sort(), ['bib_number', 'rfid_epc'])
    assert.equal(data.data[0].bib_number, 9101)
  })

  it('rejects wrong PIN with 401', async () => {
    const { status } = await callFunction('checkpoint-roster', { event_id: eventId, pin: '000000' })
    assert.equal(status, 401)
  })

  it('rejects missing fields with 400', async () => {
    const { status } = await callFunction('checkpoint-roster', { pin: PIN })
    assert.equal(status, 400)
  })

  it('rejects event without a configured PIN with 401', async () => {
    const { data: ev2 } = await supabaseAdmin.from('events').insert({
      name: `${E2E_MARKER} roster nopin`, slug: `e2e-roster-np-${Date.now()}`, visibility: 'private',
    }).select('id').single()
    try {
      const { status } = await callFunction('checkpoint-roster', { event_id: ev2.id, pin: PIN })
      assert.equal(status, 401)
    } finally {
      await supabaseAdmin.from('events').delete().eq('id', ev2.id)
    }
  })
})
