import { supabase } from '../lib/supabaseClient.js'
import { logAdminAction } from '../lib/adminAudit.js'

export async function calendarEventReportsRoutes(fastify) {
  fastify.get('/calendar-event-reports', async (request, reply) => {
    const { status = 'pending' } = request.query

    const { data: reports, error } = await supabase
      .from('calendar_event_reports')
      .select('*, calendar_events(*), profiles!calendar_event_reports_user_id_fkey(id, username, display_name, email)')
      .eq('status', status)
      .order('created_at', { ascending: false })

    if (error) return reply.status(500).send({ error: error.message })
    return { data: reports }
  })

  fastify.patch('/calendar-event-reports/:id/accept', async (request, reply) => {
    const { id } = request.params
    const { suggested_value: override } = request.body || {}

    const { data: report, error: fetchErr } = await supabase
      .from('calendar_event_reports')
      .select('*')
      .eq('id', id)
      .single()

    if (fetchErr || !report) return reply.status(404).send({ error: 'Report not found' })

    const value = override !== undefined ? override : report.suggested_value

    await logAdminAction({ action: 'accept_calendar_event_report', targetTable: 'calendar_event_reports', targetId: id, payload: { field: report.field, suggested_value: value }, req: request.raw })

    const eventUpdate = { updated_at: new Date().toISOString() }

    if (report.field === 'cancelled') {
      eventUpdate.status = 'cancelled'
    } else if (report.field === 'distances') {
      const parts = value.split(',').map(s => s.trim()).filter(Boolean)
      eventUpdate.distances = parts
    } else if (report.field === 'event_type') {
      eventUpdate.event_type = value.split(',').map(s => s.trim()).filter(Boolean)
    } else {
      eventUpdate[report.field] = value
    }

    const { error: updateErr } = await supabase
      .from('calendar_events')
      .update(eventUpdate)
      .eq('id', report.calendar_event_id)

    if (updateErr) return reply.status(500).send({ error: updateErr.message })

    const { error: reportErr } = await supabase
      .from('calendar_event_reports')
      .update({ status: 'accepted', reviewed_at: new Date().toISOString() })
      .eq('id', id)

    if (reportErr) return reply.status(500).send({ error: reportErr.message })
    return { success: true }
  })

  fastify.patch('/calendar-event-reports/:id/reject', async (request, reply) => {
    const { id } = request.params
    await logAdminAction({ action: 'reject_calendar_event_report', targetTable: 'calendar_event_reports', targetId: id, req: request.raw })

    const { error } = await supabase
      .from('calendar_event_reports')
      .update({ status: 'rejected', reviewed_at: new Date().toISOString() })
      .eq('id', id)

    if (error) return reply.status(500).send({ error: error.message })
    return { success: true }
  })
}
