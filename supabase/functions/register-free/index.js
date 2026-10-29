import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { guardRequest } from '../_shared/cors.js'
import { sendEmail } from '../_shared/email.js'
import { clientIp } from '../_shared/organizer.js'
import { eventPageUrl } from '../_shared/registration/slug.js'
import { json, NOT_FOUND, REFUSALS, prepareRegistration } from '../_shared/registration/registrationRequest.js'

// Throttle: registrations per address, 10 per hour (claim_throttle_slot).
const REGISTER_LIMIT = 10
const REGISTER_WINDOW_SECONDS = 3600

async function rows(query) {
  const { data, error } = await query
  if (error) throw error
  return data ?? []
}

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
    const prepared = await prepareRegistration(req, admin, body, {
      pricing: (settings) => (settings.pricing_mode !== 'free' ? 'not_free' : null),
      throttles: (email) => [{ key: `register:${email}`, limit: REGISTER_LIMIT, windowSeconds: REGISTER_WINDOW_SECONDS }],
    })
    if (prepared.response) return prepared.response
    const { competition, settings, people: valid, consentIds, profileId, withCookie } = prepared
    const categoryId = competition.category_id

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
