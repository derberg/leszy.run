import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { guardRequest } from '../_shared/cors.js'
import { sendEmail } from '../_shared/email.js'
import { clientIp } from '../_shared/organizer.js'
import { eventPageUrl } from '../_shared/registration/slug.js'
import { freeConfirmationEmail } from '../_shared/registration/emails.js'
import { issueConsentRequests } from '../_shared/registration/consentRequests.js'
import {
  json, NOT_FOUND, REFUSALS, groupRefusal, prepareRegistration, rpcPeople,
} from '../_shared/registration/registrationRequest.js'

// Throttles (claim_throttle_slot): requests per address, 10 per hour, and per client IP, 20 per
// hour (fix round 1, I-2). prepareRegistration adds the buyer's 30 people a day.
const REGISTER_LIMIT = 10
const REGISTER_IP_LIMIT = 20
const REGISTER_WINDOW_SECONDS = 3600

async function rows(query) {
  const { data, error } = await query
  if (error) throw error
  return data ?? []
}

// ---------------------------------------------------------------- handler

// POST { people: [{ categoryId, person, guardianConsent? }], buyer?, acceptedConsentIds, serviceRegulamin, code? }
//   or Plan 2's { categoryId, person, … } (a group of one)
//   → 201 { data: { registrations: [{ id, competition, ageGroupLabel, startTime }] } } (request order)
// A free event only. The event comes from the competitions, never from the client. Who
// registers is the `buyer` of the body, or card 1 („Twoje dane”) without one: a session with that
// address needs no code; otherwise the e-mail code is verified first (spec 14.7: no registration
// exists before it), which logs them in, and the response sets that cookie. The registrations,
// consents (the buyer's own, and as guardian for every child), slot claims (every competition,
// all or nothing) and participant rows are one transaction (register_free). 404 for a draft, an
// unknown competition, two events or a disabled club; 409 full (categoryId) / closed / not_open
// / not_free / duplicate (index; past the buyer's daily cap `refused`, naming nobody); 400 invalid_person (people, fields), invalid_group or consents;
// 401 code missing or wrong; 403 a retired address (index, only to a verified buyer); 429 per
// address, per IP, or past the buyer's 30 people a day. One confirmation e-mail, to the
// buyer, listing everybody; one consent request e-mail to each added adult.
Deno.serve(async (req) => {
  const guard = guardRequest(req)
  if (guard) return guard

  const admin = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { autoRefreshToken: false, persistSession: false } })

  let body
  try { body = await req.json() } catch { return json({ error: 'Invalid JSON' }, 400, req) }

  let withCookie = {}
  try {
    const ip = clientIp(req)
    const prepared = await prepareRegistration(req, admin, body, {
      pricing: (settings) => (settings.pricing_mode !== 'free' ? 'not_free' : null),
      throttles: (email) => [
        ...(ip ? [{ key: `register-ip:${ip}`, limit: REGISTER_IP_LIMIT, windowSeconds: REGISTER_WINDOW_SECONDS }] : []),
        { key: `register:${email}`, limit: REGISTER_LIMIT, windowSeconds: REGISTER_WINDOW_SECONDS },
      ],
    })
    if (prepared.response) return prepared.response
    const { competitions, settings, people, consentIds, profileId, email, buyerName, buyerFirstName, legacy } = prepared
    withCookie = prepared.withCookie

    // ---- one transaction
    const { data, error } = await admin.rpc('register_free', {
      p_people: rpcPeople(people),
      p_profile_id: profileId,
      p_meta: { consentIds, buyerName, ip, userAgent: req.headers.get('user-agent') || null },
    })
    if (error) {
      const msg = error.message ?? ''
      if (msg === 'not_found') return json(NOT_FOUND, 404, req, withCookie)
      if (msg === 'session_required') return json({ error: 'Wpisz kod wysłany na adres e-mail.', code: 'code_required' }, 401, req, withCookie)
      const group = await groupRefusal(admin, msg, { competitions, people, legacy, email })
      if (group) return json(group[1], group[0], req, withCookie)
      if (REFUSALS[msg]) {
        const [status, text] = REFUSALS[msg]
        return json({ error: text, code: msg }, status, req, withCookie)
      }
      throw error
    }

    const startOf = (categoryId) => {
      const c = competitions.get(categoryId)
      return (c?.start_time ?? settings.first_start_time)?.slice(0, 5) ?? null
    }
    const created = [...data.registrations].sort((a, b) => a.index - b.index)
      .map((r) => ({ ...r, person: people[r.index] }))

    // Best effort: the registrations stand whether or not the e-mails go out.
    try {
      const hours = await rows(admin.from('office_hours').select('starts_at, ends_at')
        .eq('event_id', settings.event_id).order('starts_at')).catch(() => [])
      const place = [settings.town_label, settings.place_details].filter(Boolean).join(', ')
      const mail = freeConfirmationEmail({
        event: {
          name: settings.name, eventDate: settings.event_date, place,
          officePlace: settings.office_same_as_event ? place : settings.office_address, url: eventPageUrl(settings.slug),
        },
        people: created.map((r) => ({
          role: r.person.role, firstName: r.person.firstName, lastName: r.person.lastName,
          competition: competitions.get(r.person.categoryId)?.name, ageGroupLabel: r.person.ageGroupLabel,
          startTime: startOf(r.person.categoryId),
        })),
        payerFirstName: buyerFirstName,
        officeHours: hours,
      })
      await sendEmail({ to: email, ...mail })
    } catch (err) {
      console.error('register-free: confirmation email failed:', err?.message)
    }
    await issueConsentRequests(admin, created.filter((r) => r.person.role === 'adult').map((r) => r.id), { registeredBy: buyerName })

    return json({
      data: {
        registrations: created.map((r) => ({
          id: r.id, competition: competitions.get(r.person.categoryId)?.name ?? null,
          ageGroupLabel: r.person.ageGroupLabel, startTime: startOf(r.person.categoryId),
        })),
      },
    }, 201, req, withCookie)
  } catch (err) {
    console.error('register-free error:', err?.message, err?.code)
    return json({ error: 'Internal server error' }, 500, req, withCookie)
  }
})
