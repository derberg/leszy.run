import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getCorsHeaders, guardRequest } from '../_shared/cors.js'
import { getSession } from '../_shared/session.js'
import { logOrganizerAction } from '../_shared/organizer.js'
import { AGREEMENT_REQUIRED, clubHasAgreement, loadOrganizerEvent } from '../_shared/registration/organizerEvent.js'
import { publishChecklist, blockingMessage, SLUG_TAKEN_ITEM } from '../_shared/registration/checklist.js'
import { eventPageUrl } from '../_shared/registration/slug.js'
import { changeDiff, mergedChecklistInput, noticeAudience } from '../_shared/registration/changeDiff.js'
import { PAID_REGISTRATION_ENABLED } from '../_shared/registration/flags.js'
import { sendBulkEmail } from '../_shared/email.js'

function json(body, status, req) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
  })
}

const NOT_DRAFT = { error: 'Wydarzenie jest już opublikowane.', code: 'not_draft' }
const NOT_PUBLISHED = { error: 'Wydarzenie nie jest opublikowane.', code: 'not_published' }
const ACTIONS = ['publish', 'publish_changes', 'discard_changes', 'preview_changes']
const PAGE = 1000
const SUBJECT_MAX = 200
const BODY_MAX = 5000

const refused = (blocking, req) => json({ error: blockingMessage(blocking), blocking }, 409, req)

const camelKey = (k) => k.replace(/_([a-z])/g, (_, c) => c.toUpperCase())
const camel = (row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [camelKey(k), v]))

// What publishChecklist() reads, in get-registration-event's shape.
async function checklistInput(admin, settings) {
  const [competitions, hours] = await Promise.all([
    admin.from('competitions').select('*').eq('event_id', settings.event_id),
    admin.from('office_hours').select('id').eq('event_id', settings.event_id).limit(1),
  ])
  if (competitions.error) throw competitions.error
  if (hours.error) throw hours.error
  return { settings: camel(settings), competitions: competitions.data.map(camel), officeHours: hours.data }
}

/** Every row of a query, 1000 at a time (PostgREST caps one response at 1000). */
async function allRows(query) {
  const out = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await query().range(from, from + PAGE - 1)
    if (error) throw error
    out.push(...data)
    if (data.length < PAGE) return out
  }
}

// The live rows changeDiff() compares the staged payload with.
async function liveSnapshot(admin, settings) {
  const eventId = settings.event_id
  const competitions = await allRows(() => admin.from('competitions').select('*').eq('event_id', eventId).order('category_id'))
  const ids = competitions.map((c) => c.category_id)
  const byCategory = (table, cols) => (ids.length
    ? allRows(() => admin.from(table).select(cols).in('category_id', ids).order('category_id'))
    : [])
  const [prices, hours, ageGroups, kidsGroups, consents] = await Promise.all([
    byCategory('competition_prices', 'category_id, amount, price_tiers!inner(ends_on)'),
    allRows(() => admin.from('office_hours').select('starts_at, ends_at').eq('event_id', eventId).order('starts_at')),
    byCategory('age_groups', '*'),
    byCategory('kids_groups', '*'),
    allRows(() => admin.from('event_consents').select('kind, text, sort_order').eq('event_id', eventId).order('sort_order')),
  ])
  const fixedPrice = new Map(prices.filter((p) => p.price_tiers?.ends_on == null).map((p) => [p.category_id, p.amount]))
  return {
    settings,
    competitions: competitions.map((c) => ({ ...c, price: settings.pricing_mode === 'fixed' ? (fixedPrice.get(c.category_id) ?? null) : null })),
    officeHours: hours, ageGroups, kidsGroups, consents,
  }
}

/** notify = { send: boolean, subject?, body? } → { send, subject, body } | { error, fields? } */
function checkNotify(notify) {
  if (!notify || typeof notify !== 'object' || typeof notify.send !== 'boolean') {
    return { status: 400, body: { error: 'Zdecyduj, czy wysłać powiadomienie o zmianach.' } }
  }
  if (!notify.send) return { send: false }
  const fields = {}
  const subject = typeof notify.subject === 'string' ? notify.subject.trim() : ''
  const body = typeof notify.body === 'string' ? notify.body.trim() : ''
  if (!subject) fields.subject = 'Podaj temat wiadomości.'
  else if (subject.length > SUBJECT_MAX) fields.subject = `Najwyżej ${SUBJECT_MAX} znaków.`
  if (!body) fields.body = 'Podaj treść wiadomości.'
  else if (body.length > BODY_MAX) fields.body = `Najwyżej ${BODY_MAX} znaków.`
  if (Object.keys(fields).length) return { status: 422, body: { error: 'Popraw zaznaczone pola.', fields } }
  return { send: true, subject, body }
}

/** Confirmed registrants in the audience, one address each. */
async function noticeRecipients(admin, eventId, audience) {
  if (!audience.all && !audience.categoryIds.length) return []
  const rows = await allRows(() => {
    let q = admin.from('registrations').select('id, email, guardian_email')
      .eq('event_id', eventId).eq('status', 'confirmed').order('id')
    if (!audience.all) q = q.in('category_id', audience.categoryIds)
    return q
  })
  return [...new Set(rows.map((r) => (r.email ?? r.guardian_email)?.toLowerCase()).filter(Boolean))]
}

// Sent from the LESZY.RUN domain with the club as display name and the event's
// contact address as reply-to (ruling P2-R19: never a member's own address).
async function clubSender(admin, settings) {
  const { data: club, error } = await admin.from('clubs').select('name').eq('id', settings.club_id).single()
  if (error) throw error
  return { fromName: `${club.name} przez LESZY.RUN`, replyTo: settings.contact_email ?? undefined }
}

const changeRefusal = (error) => {
  const msg = error?.message ?? ''
  if (msg === 'no_changes') return [409, { error: 'Brak zmian do opublikowania.', code: 'no_changes' }]
  if (msg === 'not_published') return [409, NOT_PUBLISHED]
  if (msg === 'changed') return [409, { error: 'Zmiany zmieniły się w trakcie publikacji. Spróbuj jeszcze raz.', code: 'changed' }]
  if (msg === 'forbidden') return [403, { error: 'Brak uprawnień.' }]
  if (msg === 'notice_throttled') {
    return [429, { error: 'Powiadomienie o zmianach można wysłać raz na godzinę. Odznacz wysyłkę albo spróbuj później.', code: 'notice_throttled' }]
  }
  if (msg === 'competition_locked') {
    return [409, { error: 'Nie można opublikować: konkurencji nie można usunąć, a z zapisami także ukryć ani zmienić jej rodzaju.', code: 'competition_locked' }]
  }
  if (msg === 'price_locked') return [409, { error: 'Nie można opublikować: opłaty nie można zmienić, są już zapisy.', code: 'price_locked' }]
  if (msg === 'consent_locked') {
    return [409, { error: 'Nie można opublikować: zgody zaakceptowanej przez zapisanych nie można usunąć ani zmienić. Odrzuć zmiany i dodaj nową zgodę.', code: 'consent_locked' }]
  }
  // A row something else still points at (a foreign key): refused, never a 500.
  if (error?.code === '23503') return [409, { error: 'Nie można opublikować: zmiany usuwają dane, z których korzystają zapisy.', code: 'locked' }]
  if (msg === 'immutable') return [409, { error: 'Nie można opublikować: adresu i pomiaru czasu nie można zmienić.', code: 'immutable' }]
  if (msg.startsWith('invalid_state:')) {
    return [409, { error: 'Nie można opublikować: zmiany zostawiłyby wydarzenie bez dat zapisów albo regulaminu.', code: 'invalid_state', what: msg.slice('invalid_state:'.length) }]
  }
  if (msg === 'foreign_id' || msg === 'duplicate_id' || ['23514', '22P02', '22007', '22008', '22003'].includes(error?.code)) {
    return [422, { error: 'Nieprawidłowe dane.', code: 'invalid' }]
  }
  return null
}

// The message row is written first and its count after sending: a crash in
// between leaves a row saying 0, never mail with no record.
async function sendChangeNotice(admin, req, session, settings, notify, affected) {
  const eventId = settings.event_id
  const { data: message, error } = await admin.from('organizer_messages').insert({
    event_id: eventId, sent_by: session.userId, subject: notify.subject, body: notify.body,
    filter: { kind: 'change_notice', ...affected }, recipient_count: 0,
  }).select('id').single()
  if (error) {
    console.error('organizer_messages insert failed, notice not sent:', error.message)
    return { sent: false, recipientCount: 0 }
  }
  const recipients = await noticeRecipients(admin, eventId, affected)
  const { sent, failed } = await sendBulkEmail(recipients, {
    subject: notify.subject, text: notify.body, ...(await clubSender(admin, settings)),
  })
  const { error: uErr } = await admin.from('organizer_messages').update({ recipient_count: sent }).eq('id', message.id)
  if (uErr) console.error('organizer_messages count update failed:', uErr.message)
  await logOrganizerAction(admin, req, {
    actorId: session.userId, clubId: settings.club_id, eventId, action: 'change_notice_sent',
    target: message.id, payload: { recipientCount: sent, failed, ...affected },
  })
  return { sent: true, recipientCount: sent, failed }
}

const CHANGED = { error: 'Zmiany zmieniły się od podglądu. Sprawdź je jeszcze raz.', code: 'changed' }

async function publishChanges(admin, req, session, settings, notifyInput, expectedUpdatedAt) {
  const notify = checkNotify(notifyInput)
  if (notify.status) return json(notify.body, notify.status, req)
  if (settings.state !== 'published') return json(NOT_PUBLISHED, 409, req)
  if (!(await clubHasAgreement(admin, settings.club_id))) return json(AGREEMENT_REQUIRED, 409, req)

  const eventId = settings.event_id
  const { data: pending, error: pErr } = await admin.from('registration_pending_changes')
    .select('payload, changed_fields, updated_at').eq('event_id', eventId).maybeSingle()
  if (pErr) throw pErr
  if (!pending) return json({ error: 'Brak zmian do opublikowania.', code: 'no_changes' }, 409, req)
  // P2-R28: what the organizer confirmed (preview_changes' stamp) is what is
  // published; staged again since, the dialog must show the new diff first.
  if (expectedUpdatedAt !== undefined && expectedUpdatedAt !== pending.updated_at) return json(CHANGED, 409, req)
  const mode = pending.payload.competitions?.pricing_mode
  if (!PAID_REGISTRATION_ENABLED && mode && mode !== 'free') {
    return json({ error: 'Nie można opublikować: płatności online — wkrótce.', code: 'payments' }, 409, req)
  }

  const live = await liveSnapshot(admin, settings)
  // The event as it will be must pass the first publish's checklist too.
  const { blocking } = publishChecklist({ ...mergedChecklistInput(live, pending.payload), hasAgreement: true })
  if (blocking.length) return refused(blocking, req)

  const diff = changeDiff(live, pending.payload)
  const affected = noticeAudience(diff)
  // Nobody to tell: no notice, and the hourly slot stays free.
  const noticeWanted = notify.send && (affected.all || affected.categoryIds.length > 0)

  const { error } = await admin.rpc('publish_registration_changes', {
    p_event_id: eventId, p_actor: session.userId, p_expected_updated_at: pending.updated_at, p_claim_notice: noticeWanted,
  })
  if (error) {
    const msg = error.message ?? ''
    if (msg.startsWith('capacity_below_taken:')) {
      const categoryId = msg.slice('capacity_below_taken:'.length)
      const { data: c } = await admin.from('competitions').select('name, taken').eq('category_id', categoryId).maybeSingle()
      return json({
        error: `Nie można opublikować: limit „${c?.name ?? ''}” jest mniejszy niż liczba zapisanych (${c?.taken ?? '?'}).`,
        code: 'capacity_below_taken', categoryId,
      }, 409, req)
    }
    const mapped = changeRefusal(error)
    if (mapped) return json(mapped[1], mapped[0], req)
    throw error
  }

  await logOrganizerAction(admin, req, {
    actorId: session.userId, clubId: settings.club_id, eventId, action: 'changes_published', target: eventId,
    payload: { changedFields: pending.changed_fields },
  })

  let notice = { sent: false, recipientCount: 0 }
  if (noticeWanted) notice = await sendChangeNotice(admin, req, session, settings, notify, affected)
  return json({ data: { diff, affected, notice } }, 200, req)
}

// What „Opublikuj zmiany” would change and whom a notice would reach, for
// the A8a dialog. Reads only; nothing staged: an empty diff.
async function previewChanges(admin, req, settings) {
  const { data: pending, error } = await admin.from('registration_pending_changes')
    .select('payload, updated_at').eq('event_id', settings.event_id).maybeSingle()
  if (error) throw error
  if (!pending) {
    return json({ data: { diff: [], affected: { all: false, categoryIds: [] }, recipientCount: 0, updatedAt: null } }, 200, req)
  }
  const diff = changeDiff(await liveSnapshot(admin, settings), pending.payload)
  const affected = noticeAudience(diff)
  const recipients = await noticeRecipients(admin, settings.event_id, affected)
  return json({ data: { diff, affected, recipientCount: recipients.length, updatedAt: pending.updated_at } }, 200, req)
}

async function discardChanges(admin, req, session, settings) {
  const { data, error } = await admin.from('registration_pending_changes')
    .delete().eq('event_id', settings.event_id).select('event_id')
  if (error) throw error
  await logOrganizerAction(admin, req, {
    actorId: session.userId, clubId: settings.club_id, eventId: settings.event_id, action: 'changes_discarded',
    target: settings.event_id,
  })
  return json({ data: { discarded: data.length > 0 } }, 200, req)
}

// POST { eventId, action: 'publish' } → 200 { data: { state: 'published', url } }.
// Owner or admin of the owning club, with the current organizer agreement.
// 409 { error: 'Uzupełnij: …', blocking } while the checklist has blocking
// items (or an ordinary event took the slug meanwhile); 409 not_draft once
// published. The RPC flips the state and writes the events, categories and
// calendar rows in one transaction.
//
// POST { eventId, action: 'publish_changes', notify: { send, subject?, body? }, expectedUpdatedAt? }
//   → 200 { data: { diff, affected: { all, categoryIds }, notice: { sent, recipientCount, failed? } } }.
// The event as it will be must pass publishChecklist (409 { error, blocking }
// like the first publish), then publish_registration_changes applies it
// (locks re-checked, limit ≥ taken in the writing statement, window and
// regulamin re-checked). `notify.send` is required; with true, a plain-text
// email goes to every confirmed registrant the changes concern (date/place:
// all; start time/distance: that competition), in batches of 1000, as the
// club with the event's contact_email as reply-to, at most once an hour per
// event (429 otherwise, nothing applied). No one concerned: nothing is sent
// and the hour is not used up.
// 409 { error, code } when a lock refuses: capacity_below_taken (names the
// competition), competition_locked, price_locked, consent_locked, immutable,
// locked (a foreign key still points at the row), no_changes, and
// changed when expectedUpdatedAt (preview_changes' updatedAt, ruling P2-R28)
// is no longer the staged row's updated_at: nothing applied, nothing sent.
// POST { eventId, action: 'discard_changes' } → 200 { data: { discarded } }.
// POST { eventId, action: 'preview_changes' }
//   → 200 { data: { diff, affected: { all, categoryIds }, recipientCount, updatedAt } }:
// what publish_changes would apply and how many confirmed registrants a
// notice would reach (one per address). Writes nothing; nothing staged gives
// an empty diff and 0.
Deno.serve(async (req) => {
  const guard = guardRequest(req)
  if (guard) return guard

  const admin = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { autoRefreshToken: false, persistSession: false } })
  const session = await getSession(req, admin)
  if (!session) return json({ error: 'Authorization required' }, 401, req)

  let body
  try { body = await req.json() } catch { return json({ error: 'Invalid JSON' }, 400, req) }

  try {
    const { eventId, action } = body ?? {}
    const loaded = await loadOrganizerEvent(admin, eventId, session, { write: true, req })
    if (loaded instanceof Response) return loaded
    const { settings } = loaded
    if (!ACTIONS.includes(action)) return json({ error: 'Nieznana akcja.' }, 400, req)
    if (action === 'publish_changes') return await publishChanges(admin, req, session, settings, body.notify, body.expectedUpdatedAt)
    if (action === 'discard_changes') return await discardChanges(admin, req, session, settings)
    if (action === 'preview_changes') return await previewChanges(admin, req, settings)
    if (settings.state !== 'draft') return json(NOT_DRAFT, 409, req)
    if (!(await clubHasAgreement(admin, settings.club_id))) return json(AGREEMENT_REQUIRED, 409, req)

    const { blocking } = publishChecklist({ ...(await checklistInput(admin, settings)), hasAgreement: true })
    if (blocking.length) return refused(blocking, req)

    const { data, error } = await admin.rpc('publish_registration_event', {
      p_event_id: settings.event_id, p_actor: session.userId, p_expected_updated_at: settings.updated_at,
    })
    if (error) {
      const msg = error.message ?? ''
      if (msg === 'not_draft') return json(NOT_DRAFT, 409, req)
      if (msg === 'slug_taken') return refused([SLUG_TAKEN_ITEM], req)
      if (msg === 'changed') {
        return json({ error: 'Wydarzenie zmieniło się w trakcie publikacji. Spróbuj jeszcze raz.', code: 'changed' }, 409, req)
      }
      if (msg === 'forbidden') return json({ error: 'Brak uprawnień.' }, 403, req)
      throw error
    }

    await logOrganizerAction(admin, req, {
      actorId: session.userId, clubId: settings.club_id, eventId: settings.event_id, action: 'published',
      target: settings.event_id,
    })
    return json({ data: { state: data.state, url: eventPageUrl(data.slug) } }, 200, req)
  } catch (err) {
    console.error('publish-registration-event error:', err?.message, err?.code)
    return json({ error: 'Internal server error' }, 500, req)
  }
})
