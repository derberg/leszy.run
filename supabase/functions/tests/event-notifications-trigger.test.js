// supabase/functions/tests/event-notifications-trigger.test.js
// Verifies the trg_notify_calendar_event_changes trigger on calendar_events.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { supabaseAdmin } from './helpers.js'

async function createTestEvent(overrides = {}) {
  const { data, error } = await supabaseAdmin
    .from('calendar_events')
    .insert({
      name: `Trigger Test Bieg ${Date.now()}`,
      date: '2030-01-01',
      source: 'test',
      source_id: `trigger-test-${crypto.randomUUID()}`,
      status: 'active',
      ...overrides,
    })
    .select('id')
    .single()
  if (error) throw error
  return data.id
}

async function notifCount(eventId, type) {
  const { count, error } = await supabaseAdmin
    .from('event_notifications')
    .select('id', { count: 'exact', head: true })
    .eq('event_id', eventId)
    .eq('type', type)
  if (error) throw error
  return count
}

async function cleanup(eventId) {
  // cascade removes event_notifications
  await supabaseAdmin.from('calendar_events').delete().eq('id', eventId)
}

describe('trg_notify_calendar_event_changes', () => {
  it('status -> cancelled fires exactly once', async () => {
    const id = await createTestEvent()
    try {
      await supabaseAdmin.from('calendar_events').update({ status: 'cancelled' }).eq('id', id)
      assert.equal(await notifCount(id, 'cancelled'), 1)
    } finally {
      await cleanup(id)
    }
  })

  it('re-cancel after flipping back to active does not duplicate', async () => {
    const id = await createTestEvent()
    try {
      await supabaseAdmin.from('calendar_events').update({ status: 'cancelled' }).eq('id', id)
      // flip back and re-cancel — unique constraint keeps it at 1
      await supabaseAdmin.from('calendar_events').update({ status: 'active' }).eq('id', id)
      await supabaseAdmin.from('calendar_events').update({ status: 'cancelled' }).eq('id', id)
      assert.equal(await notifCount(id, 'cancelled'), 1)
    } finally {
      await cleanup(id)
    }
  })

  it('status -> rejected does NOT fire', async () => {
    const id = await createTestEvent()
    try {
      await supabaseAdmin.from('calendar_events').update({ status: 'rejected' }).eq('id', id)
      assert.equal(await notifCount(id, 'cancelled'), 0)
    } finally {
      await cleanup(id)
    }
  })

  it('registration_url NULL -> value fires; value -> value does not', async () => {
    const id = await createTestEvent()
    try {
      await supabaseAdmin.from('calendar_events')
        .update({ registration_url: 'https://example.com/zapisy' }).eq('id', id)
      assert.equal(await notifCount(id, 'registration_opened'), 1)

      await supabaseAdmin.from('calendar_events')
        .update({ registration_url: 'https://example.com/zapisy-v2' }).eq('id', id)
      assert.equal(await notifCount(id, 'registration_opened'), 1)
    } finally {
      await cleanup(id)
    }
  })

  it('event created WITH registration_url never fires registration_opened on later edits', async () => {
    const id = await createTestEvent({ registration_url: 'https://example.com/zapisy' })
    try {
      await supabaseAdmin.from('calendar_events')
        .update({ registration_url: 'https://example.com/other' }).eq('id', id)
      assert.equal(await notifCount(id, 'registration_opened'), 0)
    } finally {
      await cleanup(id)
    }
  })

  it('pipeline-style touch (timestamps only) fires nothing', async () => {
    const id = await createTestEvent()
    try {
      await supabaseAdmin.from('calendar_events')
        .update({ updated_at: new Date().toISOString(), enriched_at: new Date().toISOString() })
        .eq('id', id)
      const { count } = await supabaseAdmin
        .from('event_notifications')
        .select('id', { count: 'exact', head: true })
        .eq('event_id', id)
      assert.equal(count, 0)
    } finally {
      await cleanup(id)
    }
  })
})
