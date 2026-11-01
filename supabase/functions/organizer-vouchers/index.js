import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getCorsHeaders, guardRequest } from '../_shared/cors.js'
import { getSession } from '../_shared/session.js'
import { logOrganizerAction } from '../_shared/organizer.js'
import { isUuid, loadOrganizerEvent } from '../_shared/registration/organizerEvent.js'
import { allRows } from '../_shared/registration/allRows.js'
import { generateCodes, MAX_GENERATED_CODES, validateVoucherInput } from '../_shared/registration/vouchers.js'
import { vouchersToCsv } from '../_shared/registration/entriesCsv.js'
import { warsawToday } from '../_shared/registration/dates.js'

// Codes and partners are the organizer's commercial data: never cached.
function json(body, status, req) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })
}

const NOT_FOUND = { error: 'Not found' }
const MANAGERS = ['owner', 'admin']
const ACTIONS = ['list', 'create', 'generate', 'update', 'disable', 'delete', 'export',
  'partner_create', 'partner_update', 'partner_delete']
const MAX_NOTE = 500
const MAX_PARTNER_NAME = 80

const REFUSALS = {
  code_taken: [409, 'Ten kod już istnieje.'],
  voucher_used: [409, 'Kodu, który już wykorzystano, nie można zmienić — wyłącz go.'],
  below_used: [409, 'Limit nie może być mniejszy niż liczba dotychczasowych użyć.'],
  voucher_referenced: [409, 'Kodu, który już wykorzystano, nie można usunąć — wyłącz go.'],
  partner_taken: [409, 'Taki partner już istnieje.'],
  partner_referenced: [409, 'Partnera przypisanego do kodów lub zgłoszeń nie można usunąć.'],
  invalid_partner: [422, 'Nieznany partner.'],
  invalid_category: [422, 'Nieznana konkurencja.'],
  invalid_code: [422, 'Kod: 4–32 znaki, litery A–Z, cyfry i „-”.'],
  invalid_percent: [422, 'Rabat od 1 do 100%.'],
  invalid_max_uses: [422, 'Liczba użyć od 1 do 100 000.'],
  invalid_note: [422, 'Notatka może mieć najwyżej 500 znaków.'],
  invalid_count: [422, `Można wygenerować od 1 do ${MAX_GENERATED_CODES} kodów.`],
  not_found: [404, NOT_FOUND.error],
}

const refuse = (req, code) => {
  const [status, error] = REFUSALS[code]
  return json({ error, code }, status, req)
}

function refusalOrThrow(req, error) {
  const msg = error?.message ?? ''
  if (REFUSALS[msg]) return refuse(req, msg)
  throw error
}

const invalid = (req, fields) => json({ error: 'Popraw zaznaczone pola.', code: 'invalid_voucher', fields }, 422, req)

/** A note: absent or blank → null; a string of at most 500; anything else → undefined (invalid). */
function cleanNote(note) {
  if (note == null) return null
  if (typeof note !== 'string') return undefined
  const t = note.trim()
  if (t.length > MAX_NOTE) return undefined
  return t || null
}

/** „Ważny do” back as the Warsaw day the organizer typed: valid_until is the start of the day after. */
const validUntilDay = (instant) => (instant ? warsawToday(new Date(Date.parse(instant) - 1)) : null)

async function single(query) {
  const { data, error } = await query
  if (error) throw error
  return data
}

/** Every voucher and partner of the event, in the shape `list` answers. */
async function loadVouchers(admin, eventId) {
  const [vouchers, links, partners] = await Promise.all([
    allRows(() => admin.from('vouchers')
      .select('id, code, percent, used, max_uses, valid_until, partner_id, note, disabled_at, created_at')
      .eq('event_id', eventId).order('created_at').order('id')),
    allRows(() => admin.from('voucher_competitions').select('voucher_id, category_id, vouchers!inner(event_id)')
      .eq('vouchers.event_id', eventId).order('voucher_id').order('category_id')),
    allRows(() => admin.from('registration_partners').select('id, name, note').eq('event_id', eventId).order('id')),
  ])
  const partnerOf = new Map(partners.map((p) => [p.id, p]))
  const categoriesOf = new Map()
  for (const l of links) {
    if (!categoriesOf.has(l.voucher_id)) categoriesOf.set(l.voucher_id, [])
    categoriesOf.get(l.voucher_id).push(l.category_id)
  }
  return {
    vouchers: vouchers.map((v) => {
      const p = v.partner_id ? partnerOf.get(v.partner_id) : null
      return {
        id: v.id,
        code: v.code,
        percent: v.percent,
        used: v.used,
        maxUses: v.max_uses,
        validUntil: validUntilDay(v.valid_until),
        partner: p ? { id: p.id, name: p.name } : null,
        categoryIds: categoriesOf.get(v.id) ?? [],
        note: v.note,
        disabled: v.disabled_at != null,
      }
    }),
    partners: partners.map((p) => ({ id: p.id, name: p.name, note: p.note }))
      .sort((a, b) => a.name.localeCompare(b.name, 'pl')),
  }
}

/** The voucher, when it belongs to the event (else null: a 404, never another event's code). */
async function voucherOf(admin, eventId, id) {
  if (!isUuid(id)) return null
  return single(admin.from('vouchers').select('*').eq('id', id).eq('event_id', eventId).maybeSingle())
}

async function partnerOf(admin, eventId, id) {
  if (!isUuid(id)) return null
  return single(admin.from('registration_partners').select('*').eq('id', id).eq('event_id', eventId).maybeSingle())
}

/** A partner's name: trimmed, 1–80 characters, else null. */
function partnerName(name) {
  if (typeof name !== 'string') return null
  const t = name.trim()
  return t.length >= 1 && t.length <= MAX_PARTNER_NAME ? t : null
}

// POST { eventId, action, … } → the organizer's codes and partners (Płatności, A6). Ruling 11: they
// are not pending changes, so every write applies at once, in draft and after publish.
//   list            → 200 { data: { vouchers: [{ id, code, percent, used, maxUses, validUntil,
//                     partner: { id, name } | null, categoryIds, note, disabled }], partners: [{ id, name, note }] } }
//   create          { code?, percent, maxUses, validUntil?, categoryIds?, partnerId?, note? } → 201 { data: { id, code } }
//                   no code → one is generated. 409 code_taken „Ten kod już istnieje.”
//   generate        { n (1–200), percent, prefix?, validUntil?, categoryIds?, partnerId?, note? }
//                   → 201 { data: { count } }; always single-use; the codes are read back through `list`
//   update          { id, …any field of create } → 200 { data: { changed } }. A used code keeps its
//                   code and percent (409 voucher_used), maxUses never below used (409 below_used).
//   disable         { id } → 200 { data: { disabled: true } }; the next claim answers voucher_invalid
//   delete          { id } → 200 { data: { deleted: true } }; 409 voucher_referenced once any entry,
//                   live or not, holds it („Wyłącz” instead)
//   export          → 200 { data: { filename, csv } }: Kod;Rabat;Wykorzystano;Limit;Ważny do;Partner;Notatka,
//                   entriesCsv's escaping
//   partner_create  { name, note? } → 201 { data: { id } }; 409 partner_taken (same name, any case)
//   partner_update  { id, name?, note? } → 200 { data: { id } }
//   partner_delete  { id } → 200 { data: { deleted: true } }; 409 partner_referenced while a code or
//                   an entry names it
// The owner and admins of the event's club only: a member, an outsider, another club and a disabled
// club all get 404. Every write logs one organizer_actions row naming its target; no payload holds a
// code (a code is a bearer discount).
Deno.serve(async (req) => {
  const guard = guardRequest(req)
  if (guard) return guard

  const admin = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { autoRefreshToken: false, persistSession: false } })
  const session = await getSession(req, admin)
  if (!session) return json({ error: 'Authorization required' }, 401, req)

  let body
  try { body = await req.json() } catch { return json({ error: 'Invalid JSON' }, 400, req) }
  if (!body || typeof body !== 'object') return json({ error: 'Invalid JSON' }, 400, req)

  try {
    // write: false, then the role: a member gets the outsider's 404, not 403 (codes are not for members).
    const loaded = await loadOrganizerEvent(admin, body.eventId, session, { write: false, req })
    if (loaded instanceof Response) return loaded
    if (!MANAGERS.includes(loaded.role)) return json(NOT_FOUND, 404, req)
    const action = body.action
    if (!ACTIONS.includes(action)) return json({ error: 'Nieznana operacja.', code: 'invalid_action' }, 400, req)

    const { settings } = loaded
    const eventId = settings.event_id
    const actor = session.userId
    const log = (name, target, payload = null) => logOrganizerAction(admin, req, {
      actorId: actor, clubId: settings.club_id, eventId, action: name, target, payload,
    })

    if (action === 'list') {
      return json({ data: await loadVouchers(admin, eventId) }, 200, req)
    }

    if (action === 'export') {
      const { vouchers } = await loadVouchers(admin, eventId)
      const csv = vouchersToCsv(vouchers)
      await log('vouchers_exported', eventId, { rows: vouchers.length })
      const filename = `kody-${settings.slug ?? eventId}-${warsawToday()}.csv`
      return json({ data: { filename, csv } }, 200, req)
    }

    if (action === 'create' || action === 'generate') {
      const generating = action === 'generate'
      const note = cleanNote(body.note)
      const checked = validateVoucherInput({
        code: generating ? null : body.code,
        percent: body.percent,
        maxUses: generating ? 1 : body.maxUses, // generated codes are single-use
        validUntil: body.validUntil,
        categoryIds: body.categoryIds,
        partnerId: body.partnerId,
      })
      const errors = { ...(checked.errors ?? {}) }
      if (note === undefined) errors.note = REFUSALS.invalid_note[1]
      let codes
      if (generating) {
        try {
          codes = generateCodes(Number(body.n), { prefix: body.prefix || undefined })
        } catch (err) {
          errors[err?.message === 'invalid_prefix' ? 'prefix' : 'n'] = err?.message === 'invalid_prefix'
            ? 'Przedrostek: 1–23 znaki, litery A–Z, cyfry i „-”.'
            : REFUSALS.invalid_count[1]
        }
      }
      if (Object.keys(errors).length) return invalid(req, errors)
      const v = checked.value
      if (!generating) codes = [v.code ?? generateCodes(1)[0]]
      const items = codes.map((code) => ({
        code, percent: v.percent, max_uses: v.max_uses, valid_until: v.valid_until,
        partner_id: v.partner_id, note, category_ids: v.category_ids,
      }))
      let { data: count, error } = await admin.rpc('create_vouchers', { p_event_id: eventId, p_items: items, p_actor: actor })
      // A generated batch meeting an existing code (32^8 codes, so all but impossible): new codes, once.
      if (error?.message === 'code_taken' && generating) {
        const again = generateCodes(codes.length, { prefix: body.prefix || undefined })
        ;({ data: count, error } = await admin.rpc('create_vouchers', {
          p_event_id: eventId, p_items: items.map((it, i) => ({ ...it, code: again[i] })), p_actor: actor,
        }))
      }
      if (error) return refusalOrThrow(req, error)
      if (generating) {
        await log('vouchers_generated', eventId, { n: count })
        return json({ data: { count } }, 201, req)
      }
      const created = await single(admin.from('vouchers').select('id, code').eq('event_id', eventId).eq('code', codes[0]).single())
      await log('voucher_created', created.id, {
        percent: v.percent, maxUses: v.max_uses, partnerId: v.partner_id, categories: v.category_ids.length,
      })
      return json({ data: { id: created.id, code: created.code } }, 201, req)
    }

    if (action === 'update') {
      const voucher = await voucherOf(admin, eventId, body.id)
      if (!voucher) return json(NOT_FOUND, 404, req)
      // Every field the form can send, checked as a whole with the stored values filling the rest.
      const KEYS = { code: 'code', percent: 'percent', maxUses: 'max_uses', validUntil: 'valid_until',
        categoryIds: 'category_ids', partnerId: 'partner_id' }
      const sent = Object.keys(KEYS).filter((k) => k in body)
      const stored = { code: voucher.code, percent: voucher.percent, maxUses: voucher.max_uses,
        validUntil: validUntilDay(voucher.valid_until), categoryIds: [], partnerId: voucher.partner_id }
      // The stored values always pass (the table's checks are validateVoucherInput's), so an error
      // names a field that was sent.
      const checked = validateVoucherInput({ ...stored, ...Object.fromEntries(sent.map((k) => [k, body[k]])) })
      const note = 'note' in body ? cleanNote(body.note) : null
      const errors = { ...(checked.errors ?? {}) }
      if (note === undefined) errors.note = REFUSALS.invalid_note[1]
      if ('code' in body && checked.ok && checked.value.code == null) errors.code = REFUSALS.invalid_code[1]
      if (!checked.ok || Object.keys(errors).length) return invalid(req, errors)
      const fields = Object.fromEntries(sent.map((k) => [KEYS[k], checked.value[KEYS[k]]]))
      if ('note' in body) fields.note = note
      const { data, error } = await admin.rpc('update_voucher', { p_voucher_id: voucher.id, p_fields: fields, p_actor: actor })
      if (error) return refusalOrThrow(req, error)
      const changed = data?.changed ?? []
      if (changed.length) await log('voucher_updated', voucher.id, { fields: changed })
      return json({ data: { changed } }, 200, req)
    }

    if (action === 'disable') {
      const voucher = await voucherOf(admin, eventId, body.id)
      if (!voucher) return json(NOT_FOUND, 404, req)
      if (!voucher.disabled_at) {
        const { error } = await admin.from('vouchers').update({ disabled_at: new Date().toISOString() })
          .eq('id', voucher.id).is('disabled_at', null)
        if (error) throw error
        await log('voucher_disabled', voucher.id)
      }
      return json({ data: { disabled: true } }, 200, req)
    }

    if (action === 'delete') {
      const voucher = await voucherOf(admin, eventId, body.id)
      if (!voucher) return json(NOT_FOUND, 404, req)
      // used = 0 in the statement: a claim landing meanwhile holds the row, and the registrations
      // foreign key (on delete restrict) refuses one held by any entry, live or not.
      const { data, error } = await admin.from('vouchers').delete().eq('id', voucher.id).eq('used', 0).select('id')
      if (error?.code === '23503') return refuse(req, 'voucher_referenced')
      if (error) throw error
      if (!data?.length) return refuse(req, 'voucher_referenced')
      await log('voucher_deleted', voucher.id)
      return json({ data: { deleted: true } }, 200, req)
    }

    if (action === 'partner_create') {
      const name = partnerName(body.name)
      const note = cleanNote(body.note)
      const errors = {}
      if (!name) errors.name = 'Nazwa partnera: 1–80 znaków.'
      if (note === undefined) errors.note = REFUSALS.invalid_note[1]
      if (Object.keys(errors).length) return invalid(req, errors)
      const { data, error } = await admin.from('registration_partners')
        .insert({ event_id: eventId, name, note }).select('id').single()
      if (error?.code === '23505') return refuse(req, 'partner_taken')
      if (error) throw error
      await log('partner_created', data.id)
      return json({ data: { id: data.id } }, 201, req)
    }

    if (action === 'partner_update') {
      const partner = await partnerOf(admin, eventId, body.id)
      if (!partner) return json(NOT_FOUND, 404, req)
      const patch = {}
      const errors = {}
      if ('name' in body) {
        patch.name = partnerName(body.name)
        if (!patch.name) errors.name = 'Nazwa partnera: 1–80 znaków.'
      }
      if ('note' in body) {
        patch.note = cleanNote(body.note)
        if (patch.note === undefined) errors.note = REFUSALS.invalid_note[1]
      }
      if (Object.keys(errors).length) return invalid(req, errors)
      if (Object.keys(patch).length) {
        const { error } = await admin.from('registration_partners').update(patch).eq('id', partner.id)
        if (error?.code === '23505') return refuse(req, 'partner_taken')
        if (error) throw error
        await log('partner_updated', partner.id, { fields: Object.keys(patch) })
      }
      return json({ data: { id: partner.id } }, 200, req)
    }

    // partner_delete
    const partner = await partnerOf(admin, eventId, body.id)
    if (!partner) return json(NOT_FOUND, 404, req)
    const { error } = await admin.from('registration_partners').delete().eq('id', partner.id)
    if (error?.code === '23503') return refuse(req, 'partner_referenced')
    if (error) throw error
    await log('partner_deleted', partner.id)
    return json({ data: { deleted: true } }, 200, req)
  } catch (err) {
    console.error('organizer-vouchers error:', err?.message, err?.code)
    return json({ error: 'Internal server error' }, 500, req)
  }
})
