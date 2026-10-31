import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { guardRequest } from '../_shared/cors.js'
import { getSession } from '../_shared/session.js'
import { checkAndIncrement } from '../_shared/throttle.js'
import { clientIp, clubRegistrationEnabled } from '../_shared/organizer.js'
import { isEmailRetired, RETIRED_EMAIL_MESSAGE } from '../_shared/deletedEmails.js'
import { sendEmail } from '../_shared/email.js'
import { isUuid } from '../_shared/registration/organizerEvent.js'
import { ageOn } from '../_shared/registration/ageGroups.js'
import { paymentStatusOf, registrationRole } from '../_shared/registration/group.js'
import { validateSquadMember } from '../_shared/registration/team.js'
import { squadChangedEmail, squadRemovedEmail } from '../_shared/registration/emails.js'
import { issueConsentRequests } from '../_shared/registration/consentRequests.js'
import { teamEmailArgs } from '../_shared/registration/orderFlow.js'
import {
  NOT_FOUND, PEOPLE_PER_DAY, REFUSALS, SQUAD_REFUSALS, json, personContexts, rpcPeople, squadRefusal, throttled,
} from '../_shared/registration/registrationRequest.js'

// Reads and edits per team per hour (ruling: 30/h, whoever of the captain's tabs asks).
const SQUAD_LIMIT = 30
const HOUR = 3600
const DAY = 86400
const LIVE = ['confirmed', 'pending_payment']
const ACTIONS = ['get', 'reorder', 'swap', 'add']
// An entry whose person deleted the account carries this as both names: shown once.
const DELETED = 'Usunięte konto'

async function rows(query) {
  const { data, error } = await query
  if (error) throw error
  return data ?? []
}

async function single(query) {
  const { data, error } = await query
  if (error) throw error
  return data
}

const memberColumns = 'id, first_name, last_name, birth_date, age_group_label, team_leg, consent_state, created_at, ' +
  'profile_id, registered_by_profile_id, guardian_name, guardian_profile_id, guardian_removed_at'

/** What the captain's page shows: the live squad, with no address, phone or birth date. */
async function squadView(admin, team, settings, competition) {
  const captain = await single(admin.from('registrations')
    .select('status, order_id, price').eq('id', team.captain_registration_id).single())
  const [regs, order] = await Promise.all([
    rows(admin.from('registrations').select(memberColumns).eq('team_id', team.id).in('status', LIVE)
      .order('created_at').order('id')),
    captain.order_id ? single(admin.from('orders').select('total').eq('id', captain.order_id).single()) : null,
  ])
  const isCaptain = (r) => r.id === team.captain_registration_id
  const rank = (r) => (competition.leg_order_enabled ? r.team_leg ?? Number.MAX_SAFE_INTEGER : isCaptain(r) ? 0 : 1)
  const members = [...regs].sort((a, b) => rank(a) - rank(b)).map((r) => ({
    registrationId: r.id,
    firstName: r.first_name,
    lastName: r.first_name === DELETED ? null : r.last_name,
    ageGroupLabel: r.age_group_label,
    age: r.birth_date ? ageOn(r.birth_date, settings.event_date, settings.age_reckoning) : null,
    role: isCaptain(r) ? 'self' : registrationRole(r),
    consentState: r.consent_state,
    leg: r.team_leg,
    isCaptain: isCaptain(r),
  }))
  return {
    team: {
      name: team.name,
      status: captain.status,
      paymentStatus: paymentStatusOf(captain, order, captain.price),
      orderId: captain.order_id,
      closesAt: settings.closes_at,
      legOrderEnabled: competition.leg_order_enabled === true,
      teamMin: competition.team_min,
      teamMax: competition.team_max,
    },
    members,
    competition: { categoryId: competition.category_id, name: competition.name },
    event: { id: settings.event_id, slug: settings.slug, name: settings.name, eventDate: settings.event_date },
  }
}

// Best effort: the edit is committed and answered whatever happens to an e-mail. No address in a log.
async function mail(what, to, message) {
  try {
    const res = await sendEmail({ to, ...message })
    if (res && res.ok === false) console.error(`team-squad: ${what} e-mail not accepted (${res.status})`)
  } catch (err) {
    console.error(`team-squad: ${what} e-mail failed:`, err?.message)
  }
}

// After a swap or an add. An unconfirmed team has told nobody yet: the adult out never heard of the
// entry, so a „removed” e-mail would be the first they hear, and the adult in is asked when the fee
// lands (settleConfirmOutcome covers every registration of the order). A swap keeping the address is
// a correction, not a removal. A child has no address: the captain, their guardian, reads the summary.
async function tellPeople(admin, { teamId, confirmed, captainEmail, captainName, person, result }) {
  const [added] = result.added
  const [removed] = result.removed
  const adult = person.role === 'adult'
  if (adult) await issueConsentRequests(admin, [added.id], { registeredBy: captainName })
  try {
    const args = await teamEmailArgs(admin, teamId)
    if (confirmed && removed?.email && removed.email !== person.email) {
      await mail('removed', removed.email, squadRemovedEmail({ event: args.event, team: args.team, firstName: removed.firstName }))
    }
    await mail('summary', captainEmail, squadChangedEmail({
      ...args,
      removedName: removed?.firstName ?? null,
      addedName: `${person.firstName} ${person.lastName}`,
      consentAsked: confirmed && adult ? person.firstName : null,
    }))
  } catch (err) {
    console.error('team-squad: e-mails failed:', err?.message)
  }
}

// POST { teamId, action, … } → 200 { data: { team: { name, status, paymentStatus, orderId, closesAt,
//   legOrderEnabled, teamMin, teamMax }, members: [{ registrationId, firstName, lastName,
//   ageGroupLabel, age, role, consentState, leg, isCaptain }], competition: { categoryId, name },
//   event: { id, slug, name, eventDate } } }, the same answer for a read and an edit.
//   get
//   reorder { legs: [registrationId…] }  every live member, in running order
//   swap    { registrationId, person, guardianConsent?, acceptedConsentIds?, serviceRegulamin? }
//   add     { person, guardianConsent?, acceptedConsentIds?, serviceRegulamin? }
// The captain's session only: 401 without one, 404 for anybody else and for a disabled club.
// A person is checked here and their role comes from the birth date, never from the request. A
// child's acceptances are the captain's as guardian, so they carry the event's consents and the
// service regulamin; an adult accepts for themself from the e-mail, so an adult's edit needs neither.
// team_squad_edit decides under its locks: a refused edit changes nothing and e-mails nobody.
// An edit that brings a person in spends the buyer's daily people allowance, shared with sign-ups,
// because each one can send an e-mail to an address the captain typed. Both throttles fail closed.
// Consent reminders are Plan 4's remind-consent: the captain is registered_by_profile_id.
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
    const { teamId, action } = body ?? {}
    if (!isUuid(teamId)) return json(NOT_FOUND, 404, req)
    const team = await single(admin.from('teams')
      .select('id, name, event_id, category_id, captain_registration_id').eq('id', teamId).maybeSingle())
    if (!team) return json(NOT_FOUND, 404, req)
    const captain = await single(admin.from('registrations')
      .select('profile_id, first_name, last_name').eq('id', team.captain_registration_id).single())
    if (!captain.profile_id || captain.profile_id !== session.userId) return json(NOT_FOUND, 404, req)
    const [settings, competition] = await Promise.all([
      single(admin.from('registration_settings').select('*').eq('event_id', team.event_id).single()),
      single(admin.from('competitions').select('*').eq('category_id', team.category_id).single()),
    ])
    if (!(await clubRegistrationEnabled(admin, settings.club_id))) return json(NOT_FOUND, 404, req)

    // After the captain check, so nobody else can spend this team's allowance.
    const throttle = await checkAndIncrement(admin, `squad:${team.id}`, SQUAD_LIMIT, { windowSeconds: HOUR })
    if (!throttle.allowed) return throttled(req, throttle.retryAfterSec)

    if (!ACTIONS.includes(action)) {
      const [status, error] = SQUAD_REFUSALS.invalid_op
      return json({ error, code: 'invalid_op' }, status, req)
    }
    if (action === 'get') return json({ data: await squadView(admin, team, settings, competition) }, 200, req)

    const email = session.email.toLowerCase()
    const meta = { ip: clientIp(req), userAgent: req.headers.get('user-agent') || null }
    let op = { op: action, legs: body.legs }
    let person = null

    if (action !== 'reorder') {
      const contexts = await personContexts(admin, settings, [competition])
      const checked = validateSquadMember(body, { ...contexts.get(competition.category_id), now: new Date() })
      if (!checked.ok) {
        return json({ error: 'Popraw zaznaczone pola.', code: 'invalid_person', fields: checked.errors }, 400, req)
      }
      ;[person] = rpcPeople([checked.value])

      if (person.role === 'minor') {
        if (body.serviceRegulamin !== true) {
          return json({ error: REFUSALS.consents_changed[1], code: 'consents_required' }, 400, req)
        }
        meta.consentIds = body.acceptedConsentIds
      }

      const claim = await checkAndIncrement(admin, `register-people:${email}`, PEOPLE_PER_DAY, { windowSeconds: DAY })
      if (!claim.allowed) return throttled(req, claim.retryAfterSec)
      // Ruling 8 of Plan 4, after the session and the throttles: a child's address is never stored.
      if (person.role === 'adult' && await isEmailRetired(admin, person.email)) {
        return json({ error: RETIRED_EMAIL_MESSAGE, code: 'email_retired' }, 403, req)
      }
      op = action === 'swap' ? { op: action, registrationId: body.registrationId, person } : { op: action, person }
    }

    const { data: result, error } = await admin.rpc('team_squad_edit', {
      p_team_id: team.id, p_actor_profile_id: session.userId, p_op: op, p_meta: meta,
    })
    if (error) {
      const refused = await squadRefusal(admin, error, { person, email })
      if (refused) return json(refused[1], refused[0], req)
      throw error
    }

    const view = await squadView(admin, team, settings, competition)
    if (person) {
      await tellPeople(admin, {
        teamId: team.id,
        confirmed: view.team.status === 'confirmed',
        captainEmail: email,
        captainName: `${captain.first_name} ${captain.last_name}`,
        person,
        result,
      })
    }
    return json({ data: view }, 200, req)
  } catch (err) {
    console.error('team-squad error:', err?.message, err?.code)
    return json({ error: 'Internal server error' }, 500, req)
  }
})
