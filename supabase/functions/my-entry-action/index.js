import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getCorsHeaders, guardRequest } from '../_shared/cors.js'
import { getSession } from '../_shared/session.js'
import { clubRegistrationEnabled, clubsWithAgreement } from '../_shared/organizer.js'
import { checkAndIncrement } from '../_shared/throttle.js'
import { sendEmail } from '../_shared/email.js'
import { isUuid } from '../_shared/registration/organizerEvent.js'
import { raiseAlert } from '../_shared/registration/orderFlow.js'
import { publicSite } from '../_shared/registration/consentRequests.js'
import { runnerChangeClubEmail } from '../_shared/registration/emails.js'
import { checkEdit, RUNNER_EDITABLE, RUNNER_NOT_EDITABLE } from '../_shared/registration/editCheck.js'
import { changeRefusal } from '../_shared/registration/competitionChange.js'
import { changePreview, runChange } from '../_shared/registration/changeCompetitionFlow.js'
import { dpayConfig, DpayConfigError } from '../_shared/dpay.js'
import { actsOnEntry } from '../_shared/registration/selfService.js'

function json(body, status, req, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  })
}

const NOT_FOUND = { error: 'Not found' }

/** Whether a change_competition call already used this request key (its outcome or a refund of it). */
async function knownChangeKey(admin, requestKey) {
  const [req, refund] = await Promise.all([
    admin.from('competition_change_requests').select('request_key').eq('request_key', requestKey).maybeSingle(),
    admin.from('refunds').select('id').eq('request_key', requestKey).maybeSingle(),
  ])
  if (req.error) throw req.error
  if (refund.error) throw refund.error
  return req.data != null || refund.data != null
}
const ACTIONS = ['targets', 'change', 'edit', 'details']
// Changes and edits together, per entry (spec Part 2): claim_throttle_slot, fail closed.
const CHANGES_PER_DAY = 10
const DAY = 86400
const FIELD_MESSAGE = 'Sprawdź to pole.'

// runner_edit_registration's refusals as the runner reads them.
const EDIT_REFUSALS = {
  edits_closed: [409, 'Po zamknięciu zapisów danych nie można już zmienić. Napisz do organizatora.'],
  not_allowed: [403, changeRefusal('not_allowed').error],
  not_live: [409, 'To zgłoszenie nie jest aktywne.'],
  ineligible: [422, 'Z tą datą urodzenia nie spełniasz wymagań wiekowych konkurencji.'],
  role_change: [409, 'Data urodzenia zmieniłaby zgłoszenie dziecka na zgłoszenie dorosłego albo odwrotnie.'],
  duplicate: [409, 'Ta osoba jest już zapisana na te zawody.'],
  edit_invalid: [422, 'Popraw zaznaczone pola.'],
  invalid_field: [422, changeRefusal('invalid_field').error],
  field_not_allowed: [422, changeRefusal('field_not_allowed').error],
  team_member: [404, NOT_FOUND.error],
  not_found: [404, NOT_FOUND.error],
}

// The difference refund dpay did not take: the entry has moved already (change_competition committed).
const CHANGE_REFUND = {
  rejected: 'Konkurencję zmieniono, ale operator płatności nie przyjął zwrotu różnicy. Różnicę zwróci organizator.',
  insufficient_balance: 'Konkurencję zmieniono, ale operator płatności nie przyjął zwrotu różnicy. Różnicę zwróci organizator.',
  blocked: 'Konkurencję zmieniono, ale operator płatności wstrzymał zwrot różnicy. Wyjaśniamy to; różnicę zwróci organizator.',
}

async function single(query) {
  const { data, error } = await query
  if (error) throw error
  return data
}

/**
 * The entry when the session may act on it, else null (one 404 for every case: unknown, somebody
 * else's, a draft, a disabled club). The session's own entry (`profile_id`), an adult entry whose
 * address is the session's, or a child's entry whose guardian is the session's profile.
 * → { reg, settings, team: null | { captain: boolean } }
 */
async function entryFor(admin, session, registrationId) {
  if (!isUuid(registrationId)) return null
  const reg = await single(admin.from('registrations')
    .select('id, event_id, order_id, profile_id, email, guardian_profile_id, team_id, first_name, last_name')
    .eq('id', registrationId).maybeSingle())
  if (!reg || !actsOnEntry(reg, session)) return null
  const settings = await single(admin.from('registration_settings')
    .select('event_id, club_id, name, state, closes_at, contact_email, runner_competition_change, runner_data_edit, form_fields')
    .eq('event_id', reg.event_id).maybeSingle())
  if (!settings || settings.state === 'draft') return null
  if (!(await clubRegistrationEnabled(admin, settings.club_id))) return null
  let team = null
  if (reg.team_id) {
    const t = await single(admin.from('teams').select('captain_registration_id').eq('id', reg.team_id).maybeSingle())
    team = { captain: t?.captain_registration_id === reg.id }
  }
  return { reg, settings, team }
}

/**
 * The club is told about every runner change, at the event's contact address. A send that fails
 * never fails the request (the change is stored): it is logged and alerted.
 */
async function tellClub(admin, settings, reg, content) {
  try {
    if (!settings.contact_email) return
    const club = await single(admin.from('clubs').select('slug').eq('id', settings.club_id).single())
    const url = `${publicSite()}/klub/${encodeURIComponent(club.slug)}/wydarzenia/${encodeURIComponent(settings.event_id)}/zgloszenia`
    const person = [reg.first_name, reg.last_name].filter(Boolean).join(' ')
    const mail = runnerChangeClubEmail({ eventName: settings.name, person, url, ...content })
    const res = await sendEmail({ to: settings.contact_email, ...mail, noTracking: true })
    if (!res?.ok) throw new Error(`e-mail not accepted (${res?.status})`)
  } catch (err) {
    console.error('my-entry-action: club e-mail not sent:', reg.id, err?.message)
    await raiseAlert(admin, 'email_failed', reg.order_id ?? null, {
      template: 'runner_change_club', registrationId: reg.id, error: String(err?.message ?? err),
    })
  }
}

const throttled = (req, retryAfter) => json(
  { error: 'Zbyt wiele zmian tego zgłoszenia. Spróbuj ponownie jutro.', code: 'throttled' }, 429, req,
  { 'Retry-After': String(retryAfter ?? 60) })

/** A competition change refusal in the runner's words: a 422 names the field, price_changed the real difference. */
function changeAnswer(req, refused) {
  const r = changeRefusal(refused.refused, { runner: true })
  const body = { error: r.error, code: r.code }
  if (r.status === 422) body.fields = r.code === 'team_competition' ? {} : { categoryId: r.error }
  if (refused.difference !== undefined) body.difference = refused.difference
  if (refused.remaining !== undefined) body.remaining = refused.remaining
  return json(body, r.status, req)
}

function editRefusal(req, code, keys) {
  const [status, error] = EDIT_REFUSALS[code]
  if (status !== 422) return json({ error, code }, status, req)
  const fields = code === 'ineligible'
    ? { birthDate: error }
    : Object.fromEntries(keys.map((k) => [k, FIELD_MESSAGE]))
  return json({ error, code, fields }, status, req)
}

// POST { action, registrationId, … } → the runner's own changes from „Moje zapisy” (spec Part 2),
// unless the club refused them (registration_settings.runner_competition_change / runner_data_edit).
//   targets { registrationId } → 200 { data: { competitionChange, dataEdit, closesAt, allowed,
//           refusal?, entry?, targets } }: the switches, and when the entry may move, every other
//           visible individual competition at change_competition's price (changeCompetitionFlow.js).
//           allowed false (with `refusal`: not_allowed, edits_closed, refund_pending, …) and no
//           targets when it cannot move. A cheaper target of an entry paid outside LESZY.RUN reads
//           reason offline_paid: only the club gives that difference back.
//   change  { registrationId, categoryId, expectedDifference, requestKey } → as organizer-entry-action's
//           change_competition: same price 200 moved; cheaper 200 refund accepted, 202 „Zwrot w toku.”
//           (unknown), 409 rejected / insufficient_balance / refund_blocked with data.moved; dearer
//           200 surcharge (orderId, expiresAt), billed to the session. 403 not_allowed, 409
//           price_changed with `difference`, 409 offline_paid for a cheaper move of an entry paid
//           outside LESZY.RUN (never acknowledged by a runner).
//   details { registrationId } → 200 { data: { competitionChange, dataEdit, closesAt, formFields, status,
//           person: { firstName, lastName, birthDate, gender, phone, city, club, nationality, iceName,
//           icePhone } } }: „Popraw dane”'s prefill (a captain too). No e-mail.
//   edit    { registrationId, fields } → 200 { data: { changed, ageGroupLabel, fields } }: the
//           organizer's editable fields without the names and the e-mail (422 field_not_allowed),
//           runner_edit_registration re-checks eligibility and the age group. 403 not_allowed, 409
//           edits_closed / role_change, 422 invalid_person / ineligible / edit_invalid with `fields`.
// Who: the entry's profile, a session for the entry's address (an adult entry), or a child's
// guardian; anybody else, a draft and a disabled club 404. A team member who is not the captain:
// 404; a captain may edit their own data, but a team entry never changes competition (404).
// Throttle: 10 changes and edits per entry per 24 h (`runner-change:<registrationId>`, fail closed),
// 429. Audit: registration_changes, written by the RPCs; never organizer_actions. The club gets
// „Zawodnik zmienił zgłoszenie — <wydarzenie>” at the event's contact address after each change.
Deno.serve(async (req) => {
  const guard = guardRequest(req)
  if (guard) return guard

  const admin = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { autoRefreshToken: false, persistSession: false } })

  let body
  try { body = await req.json() } catch { return json({ error: 'Invalid JSON' }, 400, req) }

  try {
    const session = await getSession(req, admin)
    if (!session) return json({ error: 'Authorization required' }, 401, req)
    const action = body?.action
    if (!ACTIONS.includes(action)) return json({ error: 'Nieznana operacja.', code: 'invalid_action' }, 400, req)

    const found = await entryFor(admin, session, body.registrationId)
    if (!found) return json(NOT_FOUND, 404, req)
    const { reg, settings, team } = found
    if (team && (!team.captain || (action !== 'edit' && action !== 'details'))) return json(NOT_FOUND, 404, req)
    // The club's switch, and its organizer agreement (any version, §13 ust. 6), which is what lets
    // a runner move the club's money (L-2; change_competition checks the same).
    const competitionChange = settings.runner_competition_change === true
      && action !== 'edit'
      && (await clubsWithAgreement(admin, [settings.club_id])).has(settings.club_id)
    const dataEdit = settings.runner_data_edit === true
    const claim = () => checkAndIncrement(admin, `runner-change:${reg.id}`, CHANGES_PER_DAY, { windowSeconds: DAY })

    if (action === 'details') {
      // „Popraw dane”'s prefill: the fields the runner may change, never the names' edit or the e-mail.
      const p = await single(admin.from('registrations')
        .select('status, birth_date, gender, phone, city, club, nationality, ice_name, ice_phone')
        .eq('id', reg.id).single())
      return json({
        data: {
          competitionChange, dataEdit, closesAt: settings.closes_at, formFields: settings.form_fields ?? {},
          status: p.status,
          person: {
            firstName: reg.first_name, lastName: reg.last_name, birthDate: p.birth_date, gender: p.gender,
            phone: p.phone, city: p.city, club: p.club, nationality: p.nationality,
            iceName: p.ice_name, icePhone: p.ice_phone,
          },
        },
      }, 200, req)
    }

    if (action === 'targets') {
      const base = { competitionChange, dataEdit, closesAt: settings.closes_at }
      if (!competitionChange) return json({ data: { ...base, allowed: false, refusal: 'not_allowed', targets: [] } }, 200, req)
      const preview = await changePreview(admin, reg.id)
      if (!preview) return json(NOT_FOUND, 404, req)
      if (preview.refusal) return json({ data: { ...base, allowed: false, refusal: preview.refusal, targets: [] } }, 200, req)
      // A runner never acknowledges an offline refund: the club gives that difference back by hand.
      const targets = preview.targets.map(({ offlineAck, ...t }) => (offlineAck && t.eligible
        ? { ...t, eligible: false, reason: 'offline_paid' }
        : t))
      return json({ data: { ...base, allowed: true, entry: preview.entry, targets } }, 200, req)
    }

    if (action === 'change') {
      if (!competitionChange) return changeAnswer(req, { refused: 'not_allowed' })
      const { categoryId, expectedDifference, requestKey } = body
      if (!isUuid(categoryId)) return changeAnswer(req, { refused: 'not_found' })
      if (!Number.isInteger(expectedDifference) || !isUuid(requestKey)) {
        return json({ error: 'Nieprawidłowe żądanie.', code: 'invalid_request' }, 400, req)
      }
      // A retry of a request key already used (a lost answer, a double click) is answered by the RPC
      // with the first outcome, so it spends no allowance.
      if (!(await knownChangeKey(admin, requestKey))) {
        const slot = await claim()
        if (!slot.allowed) return throttled(req, slot.retryAfterSec)
      }
      let cfg = null
      try {
        cfg = dpayConfig(Deno.env)
      } catch (err) {
        if (!(err instanceof DpayConfigError)) throw err
        console.error('my-entry-action: dpay not configured:', err.message)
      }
      // No organizer audit (log): the RPC writes registration_changes for a runner.
      const out = await runChange(admin, cfg, {
        registrationId: reg.id, categoryId, expectedDifference, requestKey,
        actor: session.userId, actorKind: 'runner', offlineAck: false,
      })
      if (out.refused) return changeAnswer(req, out)

      const replay = out.replay === true || out.refund?.replay === true
      if (!replay) {
        const names = await single(admin.from('competitions').select('category_id, name')
          .in('category_id', [out.fromCategoryId, out.toCategoryId]))
        const nameOf = (id) => (names ?? []).find((c) => c.category_id === id)?.name ?? ''
        await tellClub(admin, settings, reg, {
          change: {
            from: nameOf(out.fromCategoryId), to: nameOf(out.toCategoryId), outcome: out.outcome,
            grosze: out.grosze, refundStatus: out.refund?.status ?? null,
          },
        })
      }

      const data = { outcome: out.outcome, grosze: out.grosze, categoryId: out.toCategoryId, emailed: out.emailed }
      if (out.outcome === 'surcharge') return json({ data: { ...data, orderId: out.orderId, expiresAt: out.expiresAt } }, 200, req)
      if (out.outcome !== 'refund') return json({ data }, 200, req)
      const refundData = { ...data, status: out.refund.status, refundIds: out.refund.refundIds, moved: true }
      if (out.refund.status === 'accepted') return json({ data: refundData }, 200, req)
      if (out.refund.status === 'unknown') return json({ data: refundData, message: 'Zwrot w toku.' }, 202, req)
      const code = out.refund.status === 'blocked' ? 'refund_blocked' : out.refund.status
      return json({ error: CHANGE_REFUND[out.refund.status] ?? CHANGE_REFUND.rejected, code, data: refundData }, 409, req)
    }

    // edit
    if (!dataEdit) return editRefusal(req, 'not_allowed', [])
    const fields = body.fields
    if (fields && typeof fields === 'object' && !Array.isArray(fields)) {
      const named = Object.keys(fields).filter((k) => RUNNER_NOT_EDITABLE.includes(k))
      if (named.length) return editRefusal(req, 'field_not_allowed', named)
    }
    const checked = await checkEdit(admin, settings, reg.id, fields, { editable: RUNNER_EDITABLE })
    if (checked.invalid) {
      return json({ error: 'Popraw zaznaczone pola.', code: 'invalid_person', fields: checked.invalid }, 422, req)
    }
    const slot = await claim()
    if (!slot.allowed) return throttled(req, slot.retryAfterSec)
    const edits = Object.fromEntries(checked.keys.map((k) => [k, fields[k]]))
    const { data, error } = await admin.rpc('runner_edit_registration', {
      p_registration_id: reg.id, p_fields: edits, p_actor: session.userId,
    })
    if (error) {
      if (EDIT_REFUSALS[error.message]) return editRefusal(req, error.message, checked.keys)
      throw error
    }
    const changedFields = Array.isArray(data?.fields) ? data.fields : []
    if (data?.changed === true) await tellClub(admin, settings, reg, { fields: changedFields })
    return json({
      data: { changed: data?.changed === true, ageGroupLabel: data?.ageGroupLabel ?? null, fields: changedFields },
    }, 200, req)
  } catch (err) {
    console.error('my-entry-action error:', err?.message, err?.code)
    return json({ error: 'Internal server error' }, 500, req)
  }
})
