import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { callFunction, supabaseAdmin, E2E_MARKER } from './helpers.js'
import { checkinToken } from '../_shared/checkinToken.js'

describe('self-checkin edge function', () => {
  let eventId, participantId, otherParticipantId, docId, token

  before(async () => {
    const { data: ev, error: evErr } = await supabaseAdmin.from('events').insert({
      name: `${E2E_MARKER} self-checkin`, slug: `e2e-sci-${Date.now()}`, visibility: 'private', date: '2026-12-31',
    }).select('id').single()
    assert.ifError(evErr)
    eventId = ev.id
    const { data: ps, error: pErr } = await supabaseAdmin.from('participants').insert([
      { event_id: eventId, first_name: 'E2E', last_name: E2E_MARKER, bib_number: 9201, phone: '+48500000000', birth_date: '2012-05-01' },
      { event_id: eventId, first_name: 'E2E', last_name: E2E_MARKER, bib_number: 9202 },
    ]).select('id, bib_number')
    assert.ifError(pErr)
    participantId = ps.find(p => p.bib_number === 9201).id
    otherParticipantId = ps.find(p => p.bib_number === 9202).id
    const { data: doc } = await supabaseAdmin.from('event_documents').insert({
      event_id: eventId, name: `${E2E_MARKER} regulamin`, type: 'acknowledge', required_for: 'all',
    }).select('id').single()
    docId = doc.id
    await supabaseAdmin.from('event_secrets').upsert({ event_id: eventId }, { onConflict: 'event_id' })
    const { data: secret } = await supabaseAdmin.from('event_secrets').select('checkin_link_key').eq('event_id', eventId).single()
    token = await checkinToken(secret.checkin_link_key, participantId)
  })

  after(async () => {
    const { data: cks } = await supabaseAdmin.from('checkins').select('id').eq('event_id', eventId)
    const ids = (cks ?? []).map(c => c.id)
    if (ids.length) {
      await supabaseAdmin.from('checkin_documents').delete().in('checkin_id', ids)
      await supabaseAdmin.from('checkins').delete().in('id', ids)
    }
    await supabaseAdmin.from('event_documents').delete().eq('event_id', eventId)
    await supabaseAdmin.from('event_secrets').delete().eq('event_id', eventId)
    await supabaseAdmin.from('events').delete().eq('id', eventId)
  })

  const call = (body) => callFunction('self-checkin', { event_id: eventId, participant_id: participantId, token, ...body })

  it('get returns the runner without phone or birth date', async () => {
    const { status, data } = await call({ action: 'get' })
    assert.equal(status, 200)
    const p = data.data.participant
    assert.equal(p.bib_number, 9201)
    assert.equal(p.minor, true)
    assert.equal('phone' in p, false)
    assert.equal('birth_date' in p, false)
    assert.equal(data.data.checkedIn, false)
  })

  it('a wrong token and a bare participant id both get 404', async () => {
    assert.equal((await call({ action: 'get', token: 'x'.repeat(32) })).status, 404)
    assert.equal((await call({ action: 'get', token: undefined })).status, 404)
  })

  it("one runner's token does not open another runner", async () => {
    const { status } = await callFunction('self-checkin', {
      action: 'get', event_id: eventId, participant_id: otherParticipantId, token,
    })
    assert.equal(status, 404)
  })

  it('confirm needs every acknowledge document ticked', async () => {
    const { status } = await call({ action: 'confirm', acknowledged: [] })
    assert.equal(status, 400)
  })

  it('confirm checks in and records the acknowledgement', async () => {
    const { status, data } = await call({ action: 'confirm', acknowledged: [docId] })
    assert.equal(status, 200)
    assert.equal(data.data.checkedIn, true)
    const { data: ck } = await supabaseAdmin.from('checkins').select('id').eq('participant_id', participantId).single()
    const { data: docs } = await supabaseAdmin.from('checkin_documents').select('document_id, status').eq('checkin_id', ck.id)
    assert.deepEqual(docs, [{ document_id: docId, status: 'accepted' }])
  })

  it('a second confirm and a later get both report checked in', async () => {
    assert.equal((await call({ action: 'confirm', acknowledged: [docId] })).status, 200)
    const { data } = await call({ action: 'get' })
    assert.equal(data.data.checkedIn, true)
  })
})
