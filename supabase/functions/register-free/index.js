import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getCorsHeaders, guardRequest } from '../_shared/cors.js'
import { getSession } from '../_shared/session.js'
import { checkAndIncrement } from '../_shared/throttle.js'
import { verifyCodeAndOpenSession } from '../_shared/verifyCode.js'
import { isEmailRetired, RETIRED_EMAIL_MESSAGE } from '../_shared/deletedEmails.js'
import { sendEmail } from '../_shared/email.js'
import { clientIp, clubRegistrationEnabled } from '../_shared/organizer.js'
import { isUuid } from '../_shared/registration/organizerEvent.js'
import { isOpen } from '../_shared/registration/dates.js'
import { validatePerson } from '../_shared/registration/person.js'
import { MAX_PEOPLE_PER_REQUEST } from '../_shared/registration/flags.js'
import { eventPageUrl } from '../_shared/registration/slug.js'

function json(body, status, req, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json', ...headers },
  })
}

const NOT_FOUND = { error: 'Not found' }
// The RPC's refusals (exception messages) and what the runner reads.
const REFUSALS = {
  full: [409, 'Brak wolnych miejsc w tej konkurencji.'],
  closed: [409, 'Zapisy są zamknięte.'],
  not_open: [409, 'Zapisy jeszcze się nie rozpoczęły.'],
  not_free: [409, 'Zapisy na te zawody są płatne. Płatności online będą dostępne wkrótce.'],
  duplicate: [409, 'Ten adres e-mail jest już zapisany na te zawody.'],
  consents_changed: [400, 'Zaznacz wymagane zgody.'],
}
const refusal = (code, req) => {
  const [status, error] = REFUSALS[code]
  return json({ error, code }, status, req)
}

// Throttle: registrations per address, 10 per hour (claim_throttle_slot).
const REGISTER_LIMIT = 10
const REGISTER_WINDOW_SECONDS = 3600

async function rows(query) {
  const { data, error } = await query
  if (error) throw error
  return data ?? []
}

const sameSet = (a, b) => a.length === b.length && new Set(a).size === a.length && a.every((x) => b.includes(x))

// ---------------------------------------------------------------- email

const TZ = 'Europe/Warsaw'
const dayFmt = new Intl.DateTimeFormat('pl-PL', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric' })
const timeFmt = new Intl.DateTimeFormat('pl-PL', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
const isoDay = (iso) => {
  const [y, m, d] = iso.split('-')
  return `${d}.${m}.${y}`
}
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

function confirmationEmail({ settings, competition, person, startTime, hours }) {
  const place = [settings.town_label, settings.place_details].filter(Boolean).join(', ')
  const office = hours.map((h) => `${dayFmt.format(new Date(h.starts_at))} ${timeFmt.format(new Date(h.starts_at))}–${timeFmt.format(new Date(h.ends_at))}`)
  const officePlace = settings.office_same_as_event ? place : settings.office_address
  const facts = [
    ['Konkurencja', competition.name],
    ['Kategoria', person.ageGroupLabel],
    ['Start', `${isoDay(settings.event_date)}${startTime ? `, godz. ${startTime}` : ''}`],
    ['Miejsce', place],
  ].filter(([, v]) => v)
  const url = eventPageUrl(settings.slug)

  const text = [
    `Cześć ${person.firstName},`,
    '',
    `jesteś na liście startowej zawodów ${settings.name}.`,
    '',
    ...facts.map(([k, v]) => `${k}: ${v}`),
    ...(office.length
      ? ['', `Biuro zawodów${officePlace ? ` (${officePlace})` : ''}:`, ...office.map((o) => `- ${o}`)]
      : []),
    '',
    `Strona zawodów: ${url}`,
    '',
    'LESZY.RUN',
  ].join('\n')

  const html = [
    `<p>Cześć ${escapeHtml(person.firstName)},</p>`,
    `<p>jesteś na liście startowej zawodów <strong>${escapeHtml(settings.name)}</strong>.</p>`,
    `<p>${facts.map(([k, v]) => `${escapeHtml(k)}: <strong>${escapeHtml(v)}</strong>`).join('<br>')}</p>`,
    office.length
      ? `<p>Biuro zawodów${officePlace ? ` (${escapeHtml(officePlace)})` : ''}:</p><ul>${office.map((o) => `<li>${escapeHtml(o)}</li>`).join('')}</ul>`
      : '',
    `<p><a href="${escapeHtml(url)}">Strona zawodów</a></p>`,
    '<p>LESZY.RUN</p>',
  ].join('')

  return { subject: `Jesteś na liście — ${settings.name}`, text, html }
}

// ---------------------------------------------------------------- handler

// POST { categoryId, person, acceptedConsentIds, serviceRegulamin, code? }
//   → 201 { data: { registrations: [{ id, competition, ageGroupLabel, startTime }] } }
// A free event only. The event comes from the competition (categoryId), never
// from the client. A session whose address is the person's needs no code;
// otherwise the e-mail code is verified first (spec 14.7: no registration
// exists before it), which logs the person in, and the response sets that
// cookie. The registration, consents, slot claim and participant row are one
// transaction (register_free). 404 for a draft, an unknown competition or a
// disabled club; 409 full / closed / not_open / not_free / duplicate; 400 for
// person fields (fields) or consents; 401 code missing or wrong; 403 a retired
// address. One confirmation e-mail per person.
Deno.serve(async (req) => {
  const guard = guardRequest(req)
  if (guard) return guard

  const admin = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { autoRefreshToken: false, persistSession: false } })

  let body
  try { body = await req.json() } catch { return json({ error: 'Invalid JSON' }, 400, req) }

  try {
    const { categoryId, acceptedConsentIds, serviceRegulamin, code } = body ?? {}
    const people = Array.isArray(body?.people) ? body.people : body?.person ? [body.person] : []
    if (people.length === 0) return json({ error: 'Brak danych osoby.' }, 400, req)
    if (people.length > MAX_PEOPLE_PER_REQUEST) {
      return json({ error: 'Można zapisać jedną osobę naraz.', code: 'too_many_people' }, 400, req)
    }

    // ---- the event, derived from the competition
    if (!isUuid(categoryId)) return json(NOT_FOUND, 404, req)
    const { data: competition, error: compErr } = await admin.from('competitions')
      .select('*').eq('category_id', categoryId).maybeSingle()
    if (compErr) throw compErr
    if (!competition) return json(NOT_FOUND, 404, req)
    const { data: settings, error: rsErr } = await admin.from('registration_settings')
      .select('*').eq('event_id', competition.event_id).maybeSingle()
    if (rsErr) throw rsErr
    if (!settings || settings.state === 'draft') return json(NOT_FOUND, 404, req)
    if (!(await clubRegistrationEnabled(admin, settings.club_id))) return json(NOT_FOUND, 404, req)

    // Early answers; register_free re-checks all of them under its locks.
    if (settings.state !== 'published' || competition.hidden_at) return refusal('closed', req)
    if (settings.pricing_mode !== 'free') return refusal('not_free', req)
    const window = settings.opens_at && settings.closes_at
      ? isOpen({ opensAt: settings.opens_at, closesAt: settings.closes_at })
      : 'not_yet'
    if (window === 'not_yet') return refusal('not_open', req)
    if (window === 'closed') return refusal('closed', req)

    // ---- people
    const [ageGroups, kidsGroups, consents] = await Promise.all([
      rows(admin.from('age_groups').select('gender, label, min_age, max_age').eq('category_id', categoryId)),
      rows(admin.from('kids_groups').select('id, gender, birth_year_from, birth_year_to').eq('category_id', categoryId)),
      rows(admin.from('event_consents').select('id').eq('event_id', settings.event_id)),
    ])
    const ctx = {
      formFields: settings.form_fields ?? {},
      competition: { minAge: competition.min_age, maxAge: competition.max_age, isKids: competition.is_kids },
      raceDate: settings.event_date,
      reckoning: settings.age_reckoning,
      ageGroups: ageGroups.map((g) => ({ gender: g.gender, label: g.label, minAge: g.min_age, maxAge: g.max_age })),
      kidsGroups: kidsGroups.map((g) => ({ id: g.id, gender: g.gender, minYear: g.birth_year_from, maxYear: g.birth_year_to })),
      now: new Date(),
    }
    const valid = []
    for (const p of people) {
      const r = validatePerson(p, ctx)
      if (!r.ok) return json({ error: 'Popraw zaznaczone pola.', code: 'invalid_person', fields: r.errors }, 400, req)
      valid.push(r.value)
    }
    if (new Set(valid.map((p) => p.email)).size !== valid.length) {
      return refusal('duplicate', req)
    }

    // ---- consents: every event consent and the LESZY.RUN service regulamin
    const consentIds = consents.map((c) => c.id)
    if (serviceRegulamin !== true || !Array.isArray(acceptedConsentIds) || !sameSet(acceptedConsentIds, consentIds)) {
      return json({ error: REFUSALS.consents_changed[1], code: 'consents_required' }, 400, req)
    }

    // ---- who registers: a retired address never does (spec 13.3)
    const email = valid[0].email
    for (const p of valid) {
      if (await isEmailRetired(admin, p.email)) {
        return json({ error: RETIRED_EMAIL_MESSAGE, code: 'email_retired' }, 403, req)
      }
    }

    const throttle = await checkAndIncrement(admin, `register:${email}`, REGISTER_LIMIT,
      { failOpen: true, windowSeconds: REGISTER_WINDOW_SECONDS })
    if (!throttle.allowed) {
      return json({ error: 'Zbyt wiele prób. Spróbuj ponownie później.' }, 429, req,
        { 'retry-after': String(throttle.retryAfterSec) })
    }

    let profileId
    let cookie = null
    const session = await getSession(req, admin)
    if (session && session.email?.toLowerCase() === email) {
      profileId = session.userId
    } else {
      if (!code) return json({ error: 'Wpisz kod wysłany na adres e-mail.', code: 'code_required' }, 401, req)
      const verified = await verifyCodeAndOpenSession(admin, { email, code })
      if (!verified.ok) {
        const extra = verified.retryAfterSec ? { 'retry-after': String(verified.retryAfterSec) } : {}
        return json({ error: verified.error, ...(verified.code ? { code: verified.code } : {}) }, verified.status, req, extra)
      }
      profileId = verified.profile.id
      cookie = verified.cookie
    }
    const withCookie = cookie ? { 'Set-Cookie': cookie } : {}

    // ---- one transaction
    const { data, error } = await admin.rpc('register_free', {
      p_category_id: categoryId,
      p_people: valid,
      p_profile_id: profileId,
      p_meta: { consentIds, ip: clientIp(req), userAgent: req.headers.get('user-agent') || null },
    })
    if (error) {
      const msg = error.message ?? ''
      if (msg === 'not_found') return json(NOT_FOUND, 404, req, withCookie)
      if (REFUSALS[msg]) {
        const [status, text] = REFUSALS[msg]
        return json({ error: text, code: msg }, status, req, withCookie)
      }
      throw error
    }

    const startTime = (competition.start_time ?? settings.first_start_time)?.slice(0, 5) ?? null
    const created = data.registrations.map((r, i) => ({ ...r, person: valid[i] }))

    // Best effort: the registration stands whether or not the e-mail goes out.
    const hours = await rows(admin.from('office_hours').select('starts_at, ends_at')
      .eq('event_id', settings.event_id).order('starts_at')).catch(() => [])
    for (const r of created) {
      try {
        const mail = confirmationEmail({ settings, competition, person: r.person, startTime, hours })
        await sendEmail({ to: r.person.email, ...mail })
      } catch (err) {
        console.error('register-free: confirmation email failed:', err?.message)
      }
    }

    return json({
      data: {
        registrations: created.map((r) => ({
          id: r.id, competition: competition.name, ageGroupLabel: r.person.ageGroupLabel, startTime,
        })),
      },
    }, 201, req, withCookie)
  } catch (err) {
    console.error('register-free error:', err?.message, err?.code)
    return json({ error: 'Internal server error' }, 500, req)
  }
})
