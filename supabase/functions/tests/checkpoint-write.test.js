import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { callFunction, supabaseAdmin, E2E_MARKER } from './helpers.js'

describe('checkpoint-write edge function', () => {
  let eventId, checkpointId
  const PIN = '246810'

  before(async () => {
    const { data: ev, error: evErr } = await supabaseAdmin.from('events').insert({
      name: `${E2E_MARKER} checkpoint-write`, slug: `e2e-cpw-${Date.now()}`, visibility: 'private',
    }).select('id').single()
    assert.ifError(evErr)
    eventId = ev.id
    const { data: cp, error: cpErr } = await supabaseAdmin.from('checkpoints').insert({
      event_id: eventId, name: `${E2E_MARKER} CP`,
    }).select('id').single()
    assert.ifError(cpErr)
    checkpointId = cp.id
    await supabaseAdmin.from('event_secrets').upsert({ event_id: eventId, checkpoint_pin: PIN }, { onConflict: 'event_id' })
  })

  after(async () => {
    await supabaseAdmin.from('checkpoint_observations').delete().eq('checkpoint_id', checkpointId)
    await supabaseAdmin.from('checkpoint_agents').delete().eq('checkpoint_id', checkpointId)
    await supabaseAdmin.from('event_secrets').delete().eq('event_id', eventId)
    await supabaseAdmin.from('otp_throttle').delete().like('key', `pin:%:${eventId}`)
    await supabaseAdmin.from('events').delete().eq('id', eventId)
  })

  const observation = (bib, extra = {}) => ({
    id: crypto.randomUUID(), bib_number: bib, observed_at: new Date().toISOString(), source: 'manual', ...extra,
  })

  it('verify accepts the checkpoint PIN', async () => {
    const { status, data } = await callFunction('checkpoint-write', { action: 'verify', checkpoint_id: checkpointId, pin: PIN })
    assert.equal(status, 200)
    assert.equal(data.data.ok, true)
  })

  it('a wrong PIN is 401 and writes nothing', async () => {
    const { status, data } = await callFunction('checkpoint-write', {
      action: 'observe', checkpoint_id: checkpointId, pin: '000000', observation: observation(901),
    })
    assert.equal(status, 401)
    assert.equal(data.code, 'invalid_pin')
    const { count } = await supabaseAdmin.from('checkpoint_observations')
      .select('id', { count: 'exact', head: true }).eq('checkpoint_id', checkpointId).eq('bib_number', 901)
    assert.equal(count, 0)
  })

  it('observe stores the pass and returns its row', async () => {
    const obs = observation(902)
    const { status, data } = await callFunction('checkpoint-write', {
      action: 'observe', checkpoint_id: checkpointId, pin: PIN, observation: obs,
    })
    assert.equal(status, 200)
    assert.deepEqual(data.data, [{ id: obs.id }])
  })

  it('the same entry sent twice is a 23505 duplicate', async () => {
    const obs = observation(903)
    const body = { action: 'observe', checkpoint_id: checkpointId, pin: PIN, observation: obs }
    assert.equal((await callFunction('checkpoint-write', body)).status, 200)
    const again = await callFunction('checkpoint-write', body)
    assert.equal(again.status, 409)
    assert.equal(again.data.code, '23505')
  })

  it('the observation cannot name another checkpoint', async () => {
    const obs = observation(904, { checkpoint_id: crypto.randomUUID() })
    const { status } = await callFunction('checkpoint-write', {
      action: 'observe', checkpoint_id: checkpointId, pin: PIN, observation: obs,
    })
    assert.equal(status, 200)
    const { data: row } = await supabaseAdmin.from('checkpoint_observations').select('checkpoint_id').eq('id', obs.id).single()
    assert.equal(row.checkpoint_id, checkpointId)
  })

  it('rejects a malformed observation', async () => {
    const { status } = await callFunction('checkpoint-write', {
      action: 'observe', checkpoint_id: checkpointId, pin: PIN, observation: { bib_number: 'abc', observed_at: 'x' },
    })
    assert.equal(status, 400)
  })

  it('heartbeat upserts the agent status', async () => {
    const { status } = await callFunction('checkpoint-write', {
      action: 'heartbeat', checkpoint_id: checkpointId, pin: PIN, status: 'listening', reads_total: 5, queue_pending: 1, unknown_count: 0,
    })
    assert.equal(status, 200)
    const { data: agent } = await supabaseAdmin.from('checkpoint_agents').select('status, reads_total').eq('checkpoint_id', checkpointId).single()
    assert.deepEqual(agent, { status: 'listening', reads_total: 5 })
  })

  it('an unknown checkpoint is 404', async () => {
    const { status } = await callFunction('checkpoint-write', { action: 'verify', checkpoint_id: crypto.randomUUID(), pin: PIN })
    assert.equal(status, 404)
  })
})
