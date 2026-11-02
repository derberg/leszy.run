import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getCorsHeaders, guardRequest } from '../_shared/cors.js'
import { getSession } from '../_shared/session.js'
import { logOrganizerAction } from '../_shared/organizer.js'
import { isUuid, loadOrganizerEvent } from '../_shared/registration/organizerEvent.js'
import { allRows } from '../_shared/registration/allRows.js'
import { partnerName, partnerNote, partnerUrl } from '../_shared/registration/partners.js'

// A partner's note is the organizer's: never cached.
function json(body, status, req) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })
}

const NOT_FOUND = { error: 'Not found' }
const MANAGERS = ['owner', 'admin']
const ACTIONS = ['list', 'create', 'update', 'delete', 'reorder']
const BUCKET = 'partner-logos'

const REFUSALS = {
  partner_taken: [409, 'Taki partner już istnieje.'],
  partner_referenced: [409, 'Partnera przypisanego do kodów lub zgłoszeń nie można usunąć.'],
  invalid_order: [422, 'Kolejność musi obejmować każdego partnera wydarzenia dokładnie raz.'],
}

const MESSAGES = {
  name: 'Nazwa partnera: 1–80 znaków.',
  note: 'Notatka: do 500 znaków.',
  websiteUrl: 'Podaj adres zaczynający się od http:// lub https://.',
  isPublic: 'Wybierz, czy partner jest widoczny.',
}

// The request's field names, in this order, and their columns.
const FIELDS = { name: 'name', note: 'note', websiteUrl: 'website_url', isPublic: 'is_public' }

const refuse = (req, code) => {
  const [status, error] = REFUSALS[code]
  return json({ error, code }, status, req)
}

const invalid = (req, fields) => json({ error: 'Popraw zaznaczone pola.', code: 'invalid_fields', fields }, 422, req)

/** The sent fields checked → { values: { column: value }, sent: [field], errors }. */
function readFields(body, { requireName }) {
  const values = {}
  const errors = {}
  const sent = Object.keys(FIELDS).filter((k) => k in body)
  if (requireName && !sent.includes('name')) sent.unshift('name')
  for (const k of sent) {
    const raw = body[k]
    let v
    if (k === 'name') v = partnerName(raw) ?? undefined
    else if (k === 'note') v = partnerNote(raw)
    else if (k === 'websiteUrl') v = partnerUrl(raw)
    else v = typeof raw === 'boolean' ? raw : undefined
    if (v === undefined) errors[k] = MESSAGES[k]
    else values[FIELDS[k]] = v
  }
  return { values, sent, errors }
}

async function single(query) {
  const { data, error } = await query
  if (error) throw error
  return data
}

/** The partner, when it belongs to the event (else null: a 404, never another event's partner). */
async function partnerOf(admin, eventId, id) {
  if (!isUuid(id)) return null
  return single(admin.from('event_partners').select('*').eq('id', id).eq('event_id', eventId).maybeSingle())
}

/** Every partner of the event in the wizard's order, with `referenced` (a code or an entry holds it). */
async function loadPartners(admin, eventId) {
  const [partners, codes, entries] = await Promise.all([
    allRows(() => admin.from('event_partners')
      .select('id, name, note, website_url, logo_url, is_public, sort_order, created_at')
      .eq('event_id', eventId).order('sort_order').order('created_at').order('id')),
    allRows(() => admin.from('vouchers').select('id, partner_id')
      .eq('event_id', eventId).not('partner_id', 'is', null).order('id')),
    allRows(() => admin.from('registrations').select('id, partner_id')
      .eq('event_id', eventId).not('partner_id', 'is', null).order('id')),
  ])
  const held = new Set([...codes, ...entries].map((r) => r.partner_id))
  return partners.map((p) => ({
    id: p.id,
    name: p.name,
    note: p.note,
    websiteUrl: p.website_url,
    logoUrl: p.logo_url,
    isPublic: p.is_public,
    sortOrder: p.sort_order,
    referenced: held.has(p.id),
  }))
}

// POST { eventId, action, … } → the event's partners (the wizard's „Partnerzy”): one table,
// event_partners, for the public page's sponsors and the discount codes' partners. Every write
// applies at once, in draft and after publish, like the codes (ruling 11). Not behind
// PAID_REGISTRATION_ENABLED: a partner moves no money, so the money switch is never consulted here.
//   list     → 200 { data: { partners: [{ id, name, note, websiteUrl, logoUrl, isPublic, sortOrder,
//              referenced }] } } by sort_order, created_at; referenced = a code or an entry holds it
//   create   { name, note?, websiteUrl?, isPublic? (default true) } → 201 { data: { id } }, last in order
//   update   { id, name?, note?, websiteUrl?, isPublic? } → 200 { data: { id } }; only what was sent
//   delete   { id } → 200 { data: { deleted: true } }, then its logo_path object is removed;
//            409 partner_referenced while a code or an entry names it (the FK is ON DELETE RESTRICT)
//   reorder  { ids } → 200 { data: { ids } }; exactly the event's partner ids, else 422 invalid_order
// 409 partner_taken „Taki partner już istnieje.” (the same name in any case); 422 invalid_fields with
// `fields`: name „Nazwa partnera: 1–80 znaków.”, note „Notatka: do 500 znaków.”, websiteUrl „Podaj
// adres zaczynający się od http:// lub https://.”.
// The owner and admins of the event's club only: a member, an outsider, another club and a disabled
// club all get 404. Every write logs one organizer_actions row (partner_created, partner_updated,
// partner_deleted on the partner, partner_reordered on the event) whose payload names fields only,
// never a value.
Deno.serve(async (req) => {
  const guard = guardRequest(req)
  if (guard) return guard

  const admin = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { autoRefreshToken: false, persistSession: false } })
  const session = await getSession(req, admin)
  if (!session) return json({ error: 'Authorization required' }, 401, req)

  let body
  try { body = await req.json() } catch { return json({ error: 'Invalid JSON' }, 400, req) }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'Invalid JSON' }, 400, req)

  try {
    // write: false, then the role: a member gets the outsider's 404, as in organizer-vouchers.
    const loaded = await loadOrganizerEvent(admin, body.eventId, session, { write: false, req })
    if (loaded instanceof Response) return loaded
    if (!MANAGERS.includes(loaded.role)) return json(NOT_FOUND, 404, req)
    const action = body.action
    if (!ACTIONS.includes(action)) return json({ error: 'Nieznana operacja.', code: 'invalid_action' }, 400, req)

    const { settings } = loaded
    const eventId = settings.event_id
    const log = (name, target, payload = null) => logOrganizerAction(admin, req, {
      actorId: session.userId, clubId: settings.club_id, eventId, action: name, target, payload,
    })

    if (action === 'list') {
      return json({ data: { partners: await loadPartners(admin, eventId) } }, 200, req)
    }

    if (action === 'create') {
      const { values, sent, errors } = readFields(body, { requireName: true })
      if (Object.keys(errors).length) return invalid(req, errors)
      const [last] = await single(admin.from('event_partners').select('sort_order')
        .eq('event_id', eventId).order('sort_order', { ascending: false }).limit(1))
      const { data, error } = await admin.from('event_partners')
        .insert({ ...values, event_id: eventId, sort_order: last ? last.sort_order + 1 : 0 }).select('id').single()
      if (error?.code === '23505') return refuse(req, 'partner_taken')
      if (error) throw error
      await log('partner_created', data.id, { fields: sent })
      return json({ data: { id: data.id } }, 201, req)
    }

    if (action === 'update') {
      const partner = await partnerOf(admin, eventId, body.id)
      if (!partner) return json(NOT_FOUND, 404, req)
      const { values, sent, errors } = readFields(body, { requireName: false })
      if (Object.keys(errors).length) return invalid(req, errors)
      const changed = sent.filter((k) => values[FIELDS[k]] !== partner[FIELDS[k]])
      if (changed.length) {
        const patch = Object.fromEntries(changed.map((k) => [FIELDS[k], values[FIELDS[k]]]))
        const { error } = await admin.from('event_partners')
          .update({ ...patch, updated_at: new Date().toISOString() }).eq('id', partner.id)
        if (error?.code === '23505') return refuse(req, 'partner_taken')
        if (error) throw error
        await log('partner_updated', partner.id, { fields: changed })
      }
      return json({ data: { id: partner.id } }, 200, req)
    }

    if (action === 'delete') {
      const partner = await partnerOf(admin, eventId, body.id)
      if (!partner) return json(NOT_FOUND, 404, req)
      const { error } = await admin.from('event_partners').delete().eq('id', partner.id)
      if (error?.code === '23503') return refuse(req, 'partner_referenced')
      if (error) throw error
      // Only after the row is gone: a refused delete keeps its logo. A legacy row with a logo_url
      // and no logo_path is left as it is (its object may be shared or not ours to parse).
      if (partner.logo_path) {
        const { error: rmError } = await admin.storage.from(BUCKET).remove([partner.logo_path])
        if (rmError) console.error('organizer-partners logo remove failed:', rmError.message)
      }
      await log('partner_deleted', partner.id)
      return json({ data: { deleted: true } }, 200, req)
    }

    // reorder
    const ids = body.ids
    const current = await allRows(() => admin.from('event_partners').select('id, sort_order')
      .eq('event_id', eventId).order('id'))
    const known = new Set(current.map((p) => p.id))
    if (!Array.isArray(ids) || ids.length !== known.size || new Set(ids).size !== ids.length
      || !ids.every((id) => isUuid(id) && known.has(id))) {
      return refuse(req, 'invalid_order')
    }
    const orderOf = new Map(current.map((p) => [p.id, p.sort_order]))
    const now = new Date().toISOString()
    for (const [i, id] of ids.entries()) {
      if (orderOf.get(id) === i) continue
      const { error } = await admin.from('event_partners').update({ sort_order: i, updated_at: now })
        .eq('id', id).eq('event_id', eventId)
      if (error) throw error
    }
    await log('partner_reordered', eventId)
    return json({ data: { ids } }, 200, req)
  } catch (err) {
    console.error('organizer-partners error:', err?.message, err?.code)
    return json({ error: 'Internal server error' }, 500, req)
  }
})
